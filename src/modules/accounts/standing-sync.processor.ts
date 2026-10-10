import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { AccountType, Standing } from '../../common/http/viewer-request';
import {
  MEDIA_VISIBILITY_JOB,
  MEDIA_VISIBILITY_JOB_OPTIONS,
} from '../../common/queues/media-visibility-job';
import {
  QUEUE_ACCOUNTS_SYNC,
  QUEUE_MEDIA_VISIBILITY,
} from '../../common/queues/queue-names';
import { RoleAwareWorkerHost } from '../../common/queues/role-aware-worker.host';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import {
  ChinaPartsAccount,
  ChinaPartsAccountsRepository,
} from '../china-parts/chinaparts-accounts.repository';
import { toDisplay } from './account-display';
import {
  AccountsRepository,
  DisplayUpdate,
  SyncRecord,
} from './accounts.repository';
import { StandingService } from './standing.service';

const SYNC_SCHEDULER_ID = 'accounts-sync';
const SYNC_JOB = 'sync';
const BATCH_SIZE = 1_000;
const ACCOUNT_TYPES: readonly AccountType[] = ['customer', 'seller'];
/** More than this many missing accounts is the start of a mass-miss (below the ratio it is just life). */
const BREAKER_MIN_MISSING = 10;

/** What a run changed, for the jobs that follow it: media visibility and account cleanup. */
export interface SyncResult {
  /** Reels account ids whose standing changed, in either direction. */
  changedStanding: string[];
  /** Reels account ids marked `deleted` by this run. */
  newlyDeleted: string[];
}

/** An account the run looked at, with the standing it ends up in if it changed. */
interface Scanned {
  id: string;
  accountType: AccountType;
  externalId: number;
  standing: Standing;
}

/**
 * Keeps every reels account in step with China Parts (research R7): public name, picture, preferred
 * currency, and standing. It re-reads every account on a schedule rather than only the recent ones,
 * so a change that Laravel made without touching `updated_at`, or to an account nobody has used for
 * months, is still found, and a suspended account's content leaves the feeds within the 15 minutes
 * of FR-009.
 *
 * The run is built to fail safe, because the worst thing it could do is act on bad data:
 * - It reads everything first and writes afterwards, so a China Parts error (a thrown query) leaves
 *   every account exactly as it was. An unreachable database never looks like a deleted account.
 * - What the run does is ordered so that a failure is simply found again by the next run: the
 *   exclusion set and the media jobs (Redis) come first and MongoDB, which is what the next run
 *   compares against, comes last. A run that fails before its MongoDB writes still sees every
 *   change next time, so no account is left with its media on the wrong side.
 * - An account is only deleted after two consecutive cycles in which China Parts did not return it.
 * - If a cycle finds more than 10 accounts missing and more than `SYNC_MAX_MISSING_RATIO` of those
 *   it checked, it assumes China Parts is wrong (a wrong database, an empty replica) and marks
 *   nothing, loudly.
 *
 * Runs only in a worker process (`WORKER_ROLE`), see `RoleAwareWorkerHost`.
 */
@Injectable()
@Processor(QUEUE_ACCOUNTS_SYNC, { autorun: false })
export class StandingSyncProcessor extends RoleAwareWorkerHost {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly chinaParts: ChinaPartsAccountsRepository,
    private readonly standing: StandingService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QUEUE_ACCOUNTS_SYNC) private readonly queue: Queue,
    @InjectQueue(QUEUE_MEDIA_VISIBILITY) private readonly mediaQueue: Queue,
    private readonly config: ConfigService,
  ) {
    super(config);
  }

  /**
   * One repeating job for the whole fleet: every worker upserts the same scheduler, so there is
   * one schedule however many workers run. The first run is a full interval away, because a
   * request re-reads its own account anyway.
   */
  protected async onWorkerStart(): Promise<void> {
    const minutes = this.config.getOrThrow<number>(
      'ACCOUNT_SYNC_INTERVAL_MINUTES',
    );
    await this.queue.upsertJobScheduler(
      SYNC_SCHEDULER_ID,
      { every: minutes * 60_000 },
      { name: SYNC_JOB },
    );
  }

  async process(): Promise<SyncResult> {
    // A thrown error is the point: the job fails, nothing was written, and the next run starts over.
    return this.runOnce();
  }

  async runOnce(): Promise<SyncResult> {
    const startedAt = Date.now();
    const changed: Scanned[] = [];
    const updates: Array<{ id: string; data: DisplayUpdate }> = [];
    const missing: Array<{ scanned: Scanned; stampedBefore: boolean }> = [];
    let checked = 0;

    // Phase 1: read. Nothing is written here, so a failure in this phase changes nothing.
    for (const accountType of ACCOUNT_TYPES) {
      let after = 0;
      for (;;) {
        const page = await this.accounts.listByType(
          accountType,
          after,
          BATCH_SIZE,
        );
        if (page.length === 0) break;
        after = page[page.length - 1].externalId;

        const remote = await this.readRemote(
          accountType,
          page.map((row) => row.externalId),
        );
        for (const local of page) {
          const scanned: Scanned = {
            id: local._id.toString(),
            accountType,
            externalId: local.externalId,
            standing: local.standing,
          };
          const found = remote.get(local.externalId);
          if (found) {
            checked += 1;
            if (differs(local, found)) {
              updates.push({ id: scanned.id, data: toDisplay(found) });
              if (local.standing !== found.standing) {
                changed.push({ ...scanned, standing: found.standing });
              }
            }
          } else if (local.standing !== 'deleted') {
            // Already deleted accounts are expected to be absent: they are neither checked nor
            // missing as far as the breaker is concerned.
            checked += 1;
            missing.push({
              scanned,
              stampedBefore: local.missingSince !== null,
            });
          }
        }
        if (page.length < BATCH_SIZE) break;
      }
    }

    // What to do about the accounts China Parts did not return, decided here and applied later.
    let firstMiss: Scanned[] = [];
    let newlyDeleted: Scanned[] = [];
    if (this.breakerTrips(missing.length, checked)) {
      this.logger.error(
        `Sync found ${missing.length} of ${checked} accounts missing from China Parts, ` +
          `which is more than ${BREAKER_MIN_MISSING} and more than ` +
          `${this.config.getOrThrow<number>('SYNC_MAX_MISSING_RATIO')} of those checked. ` +
          'Treating it as a wrong or empty source: nothing marked missing or deleted.',
      );
    } else {
      firstMiss = missing.filter((m) => !m.stampedBefore).map((m) => m.scanned);
      newlyDeleted = missing
        .filter((m) => m.stampedBefore)
        .map((m) => ({ ...m.scanned, standing: 'deleted' as const }));
    }
    const changedStanding = [...changed, ...newlyDeleted];

    // Phase 2: Redis. The exclusion set that every read uses, and the media jobs.
    const excluded = new Set(await this.accounts.listExcludedIds());
    for (const account of changedStanding) {
      if (account.standing === 'good') excluded.delete(account.id);
      else excluded.add(account.id);
    }
    await this.standing.replaceAll([...excluded]);
    await this.enqueueMediaSync(changedStanding, startedAt);

    // Phase 3: MongoDB, last, because it is what the next run compares against.
    if (updates.length > 0) await this.accounts.applyDisplayUpdates(updates);
    if (firstMiss.length > 0) {
      await this.accounts.setMissingSince(
        firstMiss.map((account) => account.id),
        new Date(),
      );
    }
    if (newlyDeleted.length > 0) {
      await this.accounts.markDeleted(
        newlyDeleted.map((account) => account.id),
      );
    }
    await this.forgetCachedAccounts(changedStanding);

    return {
      changedStanding: changedStanding.map((account) => account.id),
      newlyDeleted: newlyDeleted.map((account) => account.id),
    };
  }

  /**
   * One job per account whose standing changed, so its reels' files follow (FR-009, FR-014). The
   * job id carries the cycle's start, so a re-delivered batch from the same run is not doubled.
   */
  private async enqueueMediaSync(
    accounts: Scanned[],
    startedAt: number,
  ): Promise<void> {
    if (accounts.length === 0) return;
    await this.mediaQueue.addBulk(
      accounts.map((account) => ({
        name: MEDIA_VISIBILITY_JOB,
        data: { accountId: account.id },
        opts: {
          ...MEDIA_VISIBILITY_JOB_OPTIONS,
          // BullMQ ids may not contain ':'.
          jobId: `media-${account.id}-${startedAt}`,
        },
      })),
    );
  }

  private async readRemote(
    accountType: AccountType,
    externalIds: number[],
  ): Promise<Map<number, ChinaPartsAccount>> {
    const accounts =
      accountType === 'customer'
        ? await this.chinaParts.getCustomers(externalIds)
        : await this.chinaParts.getSellers(externalIds);
    return new Map(accounts.map((account) => [account.externalId, account]));
  }

  private breakerTrips(missing: number, checked: number): boolean {
    const ratio = this.config.getOrThrow<number>('SYNC_MAX_MISSING_RATIO');
    return missing > BREAKER_MIN_MISSING && missing > ratio * checked;
  }

  /**
   * An account whose standing changed has its per-request cache entry dropped, so its next request
   * reads the new standing at once instead of after up to a minute.
   */
  private async forgetCachedAccounts(accounts: Scanned[]): Promise<void> {
    if (accounts.length === 0) return;
    const keys = accounts.map(
      (account) => `auth:acct:${account.accountType}:${account.externalId}`,
    );
    for (let index = 0; index < keys.length; index += BATCH_SIZE) {
      await this.redis.del(...keys.slice(index, index + BATCH_SIZE));
    }
  }
}

/** Whether the reels copy of an account differs from China Parts in anything the sync keeps. */
function differs(local: SyncRecord, remote: ChinaPartsAccount): boolean {
  return (
    local.name !== remote.name ||
    local.avatarUrl !== remote.avatarUrl ||
    local.standing !== remote.standing ||
    local.preferredCurrency !== remote.preferredCurrency ||
    local.missingSince !== null
  );
}
