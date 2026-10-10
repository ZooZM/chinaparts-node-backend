import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { FakeRedis } from '../../common/redis/fake-redis.testing';
import type { AccountType } from '../../common/http/viewer-request';
import type {
  ChinaPartsAccount,
  ChinaPartsAccountsRepository,
} from '../china-parts/chinaparts-accounts.repository';
import type {
  AccountsRepository,
  DisplayUpdate,
  SyncRecord,
} from './accounts.repository';
import { StandingService } from './standing.service';
import { StandingSyncProcessor } from './standing-sync.processor';

/** The reels accounts and the China Parts rows, as two plain lists the fakes below read. */
class World {
  local: Array<SyncRecord & { accountType: AccountType }> = [];
  remote: ChinaPartsAccount[] = [];
  /** Throws on the n-th China Parts read (1-based), to simulate an outage mid-run. */
  failOnRead: number | undefined;
  reads = 0;

  readonly applied: Array<{ id: string; data: DisplayUpdate }> = [];
  readonly missing: Array<{ ids: string[]; date: Date | null }> = [];
  readonly deleted: string[] = [];
  readonly pages: Array<{ type: AccountType; after: number; limit: number }> =
    [];

  add(
    accountType: AccountType,
    externalId: number,
    overrides: Partial<SyncRecord> = {},
  ): SyncRecord {
    const record: SyncRecord & { accountType: AccountType } = {
      _id: new Types.ObjectId(),
      accountType,
      externalId,
      name: `Account ${externalId}`,
      avatarUrl: null,
      standing: 'good',
      preferredCurrency: null,
      missingSince: null,
      ...overrides,
    };
    this.local.push(record);
    return record;
  }

  /** China Parts has the account, in good standing unless said otherwise. */
  have(
    accountType: AccountType,
    externalId: number,
    overrides: Partial<ChinaPartsAccount> = {},
  ): void {
    this.remote.push({
      accountType,
      externalId,
      name: `Account ${externalId}`,
      avatarUrl: null,
      standing: 'good',
      preferredCurrency: null,
      ...overrides,
    });
  }

  accounts(): AccountsRepository {
    return {
      listByType: (type: AccountType, after: number, limit: number) => {
        this.pages.push({ type, after, limit });
        return Promise.resolve(
          this.local
            .filter((a) => a.accountType === type && a.externalId > after)
            .sort((a, b) => a.externalId - b.externalId)
            .slice(0, limit),
        );
      },
      applyDisplayUpdates: (
        updates: Array<{ id: string; data: DisplayUpdate }>,
      ) => {
        this.applied.push(...updates);
        for (const { id, data } of updates) {
          const row = this.local.find((a) => a._id.toString() === id);
          if (row) Object.assign(row, data, { missingSince: null });
        }
        return Promise.resolve();
      },
      setMissingSince: (ids: string[], date: Date | null) => {
        this.missing.push({ ids, date });
        for (const row of this.local) {
          if (ids.includes(row._id.toString())) row.missingSince = date;
        }
        return Promise.resolve();
      },
      markDeleted: (ids: string[]) => {
        this.deleted.push(...ids);
        for (const row of this.local) {
          if (ids.includes(row._id.toString())) row.standing = 'deleted';
        }
        return Promise.resolve();
      },
      listExcludedIds: () =>
        Promise.resolve(
          this.local
            .filter((a) => a.standing !== 'good')
            .map((a) => a._id.toString()),
        ),
    } as unknown as AccountsRepository;
  }

  chinaParts(): ChinaPartsAccountsRepository {
    const read = (type: AccountType) => (ids: number[]) => {
      this.reads += 1;
      if (this.failOnRead === this.reads) {
        return Promise.reject(new Error('China Parts is unreachable'));
      }
      return Promise.resolve(
        this.remote.filter(
          (a) => a.accountType === type && ids.includes(a.externalId),
        ),
      );
    };
    return {
      getCustomers: read('customer'),
      getSellers: read('seller'),
    } as unknown as ChinaPartsAccountsRepository;
  }

  get writes(): number {
    return this.applied.length + this.missing.length + this.deleted.length;
  }
}

function build(world: World, config: Record<string, unknown> = {}) {
  const redis = new FakeRedis();
  const standing = new StandingService(redis.asRedis());
  const upsertJobScheduler = jest.fn().mockResolvedValue(undefined);
  const removeJobScheduler = jest.fn().mockResolvedValue(true);
  const queue = { upsertJobScheduler, removeJobScheduler } as unknown as Queue;
  const addBulk = jest.fn().mockResolvedValue([]);
  const mediaQueue = { addBulk } as unknown as Queue;
  const addCleanup = jest.fn().mockResolvedValue([]);
  const cleanupQueue = { addBulk: addCleanup } as unknown as Queue;
  const values: Record<string, unknown> = {
    WORKER_ROLE: 'worker',
    ACCOUNT_SYNC_INTERVAL_MINUTES: 5,
    SYNC_MAX_MISSING_RATIO: 0.01,
    ...config,
  };
  const configService = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService;
  const processor = new StandingSyncProcessor(
    world.accounts(),
    world.chinaParts(),
    standing,
    redis.asRedis(),
    queue,
    mediaQueue,
    cleanupQueue,
    configService,
  );
  return {
    processor,
    redis,
    standing,
    upsertJobScheduler,
    removeJobScheduler,
    addBulk,
    addCleanup,
  };
}

describe('StandingSyncProcessor (research R7)', () => {
  let world: World;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    world = new World();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('refreshing accounts that are still there', () => {
    it('writes nothing for an account that has not changed', async () => {
      world.add('customer', 1);
      world.have('customer', 1);
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(world.writes).toBe(0);
      expect(result).toEqual({ changedStanding: [], newlyDeleted: [] });
    });

    it('refreshes the name, picture and currency, in step with China Parts', async () => {
      const row = world.add('seller', 7, { name: 'Old Shop' });
      world.have('seller', 7, {
        name: 'New Shop',
        avatarUrl: 'https://cdn.test/logo.png',
        preferredCurrency: 'USD',
      });
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(world.applied).toHaveLength(1);
      expect(world.applied[0].id).toBe(row._id.toString());
      expect(world.applied[0].data).toMatchObject({
        name: 'New Shop',
        avatarUrl: 'https://cdn.test/logo.png',
        preferredCurrency: 'USD',
        standing: 'good',
      });
      // A rename is not a standing change.
      expect(result.changedStanding).toEqual([]);
    });

    it('reports an account whose standing changed, and makes its next request re-read it', async () => {
      const row = world.add('customer', 3);
      world.have('customer', 3, { standing: 'suspended' });
      const { processor, redis } = build(world);
      await redis.set('auth:acct:customer:3', '{"cached":true}', 'EX', 60);
      await redis.set('auth:acct:customer:4', '{"cached":true}', 'EX', 60);

      const result = await processor.runOnce();

      expect(result.changedStanding).toEqual([row._id.toString()]);
      expect(await redis.get('auth:acct:customer:3')).toBeNull();
      // Only the accounts that changed lose their cache.
      expect(await redis.get('auth:acct:customer:4')).not.toBeNull();
    });

    it('reports a reinstatement too', async () => {
      const row = world.add('seller', 2, { standing: 'suspended' });
      world.have('seller', 2, { standing: 'good' });
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(result.changedStanding).toEqual([row._id.toString()]);
    });

    it('rebuilds the not-in-good-standing set from every account', async () => {
      const bad = world.add('customer', 1);
      world.add('customer', 2);
      world.have('customer', 1, { standing: 'suspended' });
      world.have('customer', 2);
      const { processor, standing } = build(world);
      await standing.add('stale-account-that-recovered');

      await processor.runOnce();

      expect([...(await standing.members())]).toEqual([bad._id.toString()]);
    });
  });

  describe('the media that follow standing (FR-009, FR-014)', () => {
    type BulkJob = {
      name: string;
      data: { accountId: string };
      opts: Record<string, unknown>;
    };
    const jobsOf = (addBulk: jest.Mock): BulkJob[] =>
      (addBulk.mock.calls as Array<[BulkJob[]]>).flatMap(([jobs]) => jobs);

    it('queues one job for each account whose standing changed, with an id that has no colon', async () => {
      const suspended = world.add('seller', 1);
      const reinstated = world.add('seller', 2, { standing: 'suspended' });
      world.add('seller', 3);
      world.have('seller', 1, { standing: 'suspended' });
      world.have('seller', 2, { standing: 'good' });
      world.have('seller', 3);
      const { processor, addBulk } = build(world);

      await processor.runOnce();

      const jobs = jobsOf(addBulk);
      expect(jobs.map((job) => job.data.accountId).sort()).toEqual(
        [suspended._id.toString(), reinstated._id.toString()].sort(),
      );
      for (const job of jobs) {
        expect(job.name).toBe('sync-account');
        expect(String(job.opts.jobId)).toMatch(/^media-[0-9a-f]{24}-\d+$/);
        expect(job.opts.attempts).toBeGreaterThan(1);
      }
    });

    it('queues one for an account that was just deleted', async () => {
      const row = world.add('customer', 9, { missingSince: new Date() });
      const { processor, addBulk } = build(world);

      await processor.runOnce();

      expect(jobsOf(addBulk).map((job) => job.data.accountId)).toEqual([
        row._id.toString(),
      ]);
    });

    it('queues nothing when no standing changed, for a rename or a first miss', async () => {
      world.add('customer', 1, { name: 'Old' });
      world.have('customer', 1, { name: 'New' });
      world.add('customer', 2);
      const { processor, addBulk } = build(world);

      await processor.runOnce();

      expect(addBulk).not.toHaveBeenCalled();
    });

    it('puts the exclusion set and the jobs ahead of MongoDB, so a failed run is found again', async () => {
      world.add('seller', 1);
      world.have('seller', 1, { standing: 'suspended' });
      const { processor, addBulk } = build(world);
      addBulk.mockRejectedValue(new Error('Redis is down'));

      await expect(processor.runOnce()).rejects.toThrow('Redis is down');

      // Nothing was written to MongoDB, so the account still looks unchanged and the next run
      // detects the suspension again and queues the job again.
      expect(world.writes).toBe(0);
      expect(world.local[0].standing).toBe('good');
    });
  });

  describe('the cleanup of a deleted account (FR-010)', () => {
    type CleanupJob = {
      name: string;
      data: { accountId: string };
      opts: Record<string, unknown>;
    };
    const cleanupJobs = (addCleanup: jest.Mock): CleanupJob[] =>
      (addCleanup.mock.calls as Array<[CleanupJob[]]>).flatMap(
        ([jobs]) => jobs,
      );

    it('queues one job for an account that was just deleted, with the account as its id', async () => {
      const row = world.add('customer', 9, { missingSince: new Date() });
      const { processor, addCleanup } = build(world);

      await processor.runOnce();

      const jobs = cleanupJobs(addCleanup);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({ accountId: row._id.toString() });
      expect(jobs[0].name).toBe('cleanup-account');
      expect(jobs[0].opts.jobId).toBe(`cleanup-${row._id.toString()}`);
      expect(jobs[0].opts.attempts).toBeGreaterThan(1);
    });

    it('queues nothing for a first miss, a rename, or a suspension', async () => {
      world.add('customer', 1);
      world.add('customer', 2, { name: 'Old' });
      world.have('customer', 2, { name: 'New' });
      world.add('customer', 3);
      world.have('customer', 3, { standing: 'suspended' });
      const { processor, addCleanup } = build(world);

      await processor.runOnce();

      expect(addCleanup).not.toHaveBeenCalled();
    });

    it('queues nothing for an account that was already deleted', async () => {
      world.add('customer', 9, {
        standing: 'deleted',
        missingSince: new Date(),
      });
      const { processor, addCleanup } = build(world);

      await processor.runOnce();

      expect(addCleanup).not.toHaveBeenCalled();
    });

    it('queues nothing when the breaker stopped the deletions', async () => {
      for (let id = 1; id <= 100; id += 1) {
        world.add('customer', id, id <= 12 ? { missingSince: new Date() } : {});
        if (id > 12) world.have('customer', id);
      }
      const { processor, addCleanup } = build(world);

      await processor.runOnce();

      expect(addCleanup).not.toHaveBeenCalled();
    });

    it('is queued before MongoDB is written, so a failed run is found again', async () => {
      world.add('customer', 9, { missingSince: new Date() });
      const { processor, addCleanup } = build(world);
      addCleanup.mockRejectedValue(new Error('Redis is down'));

      await expect(processor.runOnce()).rejects.toThrow('Redis is down');

      expect(world.writes).toBe(0);
      expect(world.local[0].standing).toBe('good');
    });
  });

  describe('paging', () => {
    it('reads every account of both types, a thousand at a time, in id order, and stops at a short page', async () => {
      for (let id = 1; id <= 2_500; id += 1) {
        world.add('customer', id);
        world.have('customer', id);
      }
      world.add('seller', 5);
      world.have('seller', 5);
      const { processor } = build(world);

      await processor.runOnce();

      expect(world.pages.filter((page) => page.type === 'customer')).toEqual([
        { type: 'customer', after: 0, limit: 1_000 },
        { type: 'customer', after: 1_000, limit: 1_000 },
        { type: 'customer', after: 2_000, limit: 1_000 },
      ]);
      expect(world.pages.some((page) => page.type === 'seller')).toBe(true);
      expect(world.writes).toBe(0);
    });
  });

  describe('an account China Parts does not return (FR-010)', () => {
    it('is only stamped on the first miss: standing is untouched', async () => {
      const row = world.add('customer', 9);
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(row.missingSince).toBeInstanceOf(Date);
      expect(row.standing).toBe('good');
      expect(world.deleted).toEqual([]);
      expect(result).toEqual({ changedStanding: [], newlyDeleted: [] });
    });

    it('is deleted on the second miss, and reported for cleanup', async () => {
      const row = world.add('customer', 9, { missingSince: new Date() });
      const { processor, standing, redis } = build(world);
      await redis.set('auth:acct:customer:9', '{"cached":true}', 'EX', 60);

      const result = await processor.runOnce();

      expect(row.standing).toBe('deleted');
      expect(result.newlyDeleted).toEqual([row._id.toString()]);
      expect(result.changedStanding).toEqual([row._id.toString()]);
      expect((await standing.members()).has(row._id.toString())).toBe(true);
      expect(await redis.get('auth:acct:customer:9')).toBeNull();
    });

    it('is forgiven if the row came back before the second miss', async () => {
      const row = world.add('customer', 9, { missingSince: new Date() });
      world.have('customer', 9);
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(row.missingSince).toBeNull();
      expect(row.standing).toBe('good');
      expect(result.newlyDeleted).toEqual([]);
    });

    it('does not delete an account again that already is', async () => {
      world.add('customer', 9, {
        standing: 'deleted',
        missingSince: new Date(),
      });
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(result).toEqual({ changedStanding: [], newlyDeleted: [] });
    });
  });

  describe('the mass-miss breaker', () => {
    function populate(total: number, missing: number): void {
      for (let id = 1; id <= total; id += 1) {
        world.add(
          'customer',
          id,
          id <= missing ? { missingSince: new Date() } : {},
        );
        if (id > missing) world.have('customer', id);
      }
    }

    it('marks nothing when more than 10 accounts and more than the ratio are missing, and says so', async () => {
      populate(100, 12);
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(world.deleted).toEqual([]);
      expect(world.missing).toEqual([]);
      expect(result).toEqual({ changedStanding: [], newlyDeleted: [] });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('12 of 100'),
      );
    });

    it('still refreshes the accounts that were found', async () => {
      populate(100, 12);
      world.local[50].name = 'Renamed in reels only';
      const { processor } = build(world);

      await processor.runOnce();

      expect(world.applied.some((u) => u.data.name === 'Account 51')).toBe(
        true,
      );
    });

    it('does not trip at exactly 10 missing', async () => {
      populate(100, 10);
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(result.newlyDeleted).toHaveLength(10);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('does not trip when the missing share is within the ratio', async () => {
      // 12 of 5,000 is 0.24%, under 1%: an ordinary day of deletions.
      populate(5_000, 12);
      const { processor } = build(world);

      const result = await processor.runOnce();

      expect(result.newlyDeleted).toHaveLength(12);
    });

    it('uses the configured ratio', async () => {
      populate(100, 12);
      const { processor } = build(world, { SYNC_MAX_MISSING_RATIO: 0.5 });

      const result = await processor.runOnce();

      expect(result.newlyDeleted).toHaveLength(12);
    });
  });

  describe('when China Parts cannot be reached', () => {
    it('stops without marking anything missing or changing any standing', async () => {
      for (let id = 1; id <= 1_500; id += 1) {
        world.add('customer', id);
        // Half of them are gone: it would delete them, if it believed the answer.
        if (id % 2 === 0) world.have('customer', id, { standing: 'suspended' });
      }
      // The first page reads fine; the second one fails.
      world.failOnRead = 2;
      const { processor, standing } = build(world);
      await standing.add('previous-member');

      await expect(processor.runOnce()).rejects.toThrow('unreachable');

      expect(world.writes).toBe(0);
      expect([...(await standing.members())]).toEqual(['previous-member']);
    });
  });

  describe('as a job', () => {
    it('runs a sync for each scheduled job', async () => {
      world.add('customer', 1);
      world.have('customer', 1, { standing: 'suspended' });
      const { processor } = build(world);

      await processor.process();

      expect(world.applied).toHaveLength(1);
    });

    it('schedules itself to repeat every ACCOUNT_SYNC_INTERVAL_MINUTES, without running at once', async () => {
      const { processor, upsertJobScheduler } = build(world, {
        ACCOUNT_SYNC_INTERVAL_MINUTES: 3,
      });

      await (
        processor as unknown as { onWorkerStart(): Promise<void> }
      ).onWorkerStart();

      expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
      const [, repeat] = upsertJobScheduler.mock.calls[0] as [
        string,
        { every: number; immediately?: boolean },
      ];
      expect(repeat.every).toBe(3 * 60_000);
      expect(repeat.immediately).toBeFalsy();
    });
  });
});
