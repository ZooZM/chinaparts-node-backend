import { Inject, Injectable, Logger } from '@nestjs/common';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StorageService } from '../../common/storage/storage.service';
import { AccountsService } from '../accounts/accounts.service';
import { ReelLifecycleService } from './lifecycle/reel-lifecycle.service';
import { MODERATION_PROVIDER } from './moderation/moderation-provider';
import type {
  ModerationProvider,
  ModerationVerdict,
} from './moderation/moderation-provider';
import { ReelsNotificationsService } from './reels-notifications.service';
import { REELS_REPOSITORY } from './reels.repository';
import type {
  ModerationCandidate,
  ReelMentionRecord,
  ReelsRepository,
} from './reels.repository';

/**
 * The screening pipeline's logic (FR-029 to FR-031), kept free of any BullMQ plumbing so it runs
 * behind the real queue (`ReelsModerationProcessor`) and directly in tests. `moderateReel` is the
 * only code path that moves a reel out of `pending_moderation`.
 *
 * It fails closed: if screening cannot run, `moderateReel` throws, the reel stays pending, and the
 * queue retries. A reel is published only on an explicit clean verdict.
 */
@Injectable()
export class ReelsModerationService {
  private readonly logger = new Logger(ReelsModerationService.name);

  constructor(
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
    @Inject(MODERATION_PROVIDER)
    private readonly provider: ModerationProvider,
    private readonly storage: StorageService,
    private readonly lifecycle: ReelLifecycleService,
    private readonly notifications: ReelsNotificationsService,
    private readonly accounts: AccountsService,
  ) {}

  async moderateReel(reelId: string): Promise<void> {
    const reel = await this.reels.getModerationCandidate(reelId);
    // Gone: the owner deleted it mid-review.
    if (!reel) return;

    if (reel.status === 'published') {
      // A retry after the status changed but moving the files failed. Re-screening would be
      // wrong (it is already decided), so only put the files where the rule says (research R12).
      await this.lifecycle.syncMediaVisibility(reel);
      return;
    }
    // Decided by a previous attempt, a report, or an operator: nothing to do (safe under retries
    // and duplicate enqueues).
    if (reel.status !== 'pending_moderation') return;

    // Letting a failure propagate is the point: the reel simply stays pending and is retried.
    const verdict = await this.screen(reel);

    if (verdict.verdict === 'clean') {
      await this.publish(reel);
    } else {
      await this.reject(reel, verdict);
    }
  }

  /** Reels stuck in `pending_moderation` past `staleMs`: input for the retry sweep (FR-031). */
  findStalePendingIds(staleMs: number): Promise<string[]> {
    return this.reels.findStalePendingIds(staleMs);
  }

  /** Downloads the private video, asks the provider, and always deletes the temp copy. */
  private async screen(reel: ModerationCandidate): Promise<ModerationVerdict> {
    const videoPath = await this.storage.downloadToTemp(
      this.storage.privateBucket,
      reel.media.videoKey,
    );
    try {
      return await this.provider.analyze(videoPath, reel.description);
    } finally {
      // The temp file lives in its own directory, so remove the directory.
      await rm(dirname(videoPath), { recursive: true, force: true });
    }
  }

  private async publish(reel: ModerationCandidate): Promise<void> {
    // Guarded: a concurrent or retried attempt that already decided it gets null here, and then
    // nothing below runs a second time.
    const published = await this.reels.publishPending(reel.id);
    if (!published) return;

    await this.lifecycle.onPublished(published);
    await this.notifications.notifyMentions({
      actorId: published.creatorId,
      reelId: published.id,
      mentions: await this.blockFilteredMentions(published),
    });

    this.logger.log(
      JSON.stringify({
        event: 'reel.published',
        reelId: published.id,
        publishLatencyMs: Date.now() - reel.createdAt.getTime(),
      }),
    );
  }

  /**
   * A block created between upload and verdict, in either direction, suppresses that mention's
   * notification at fan-out time.
   */
  private async blockFilteredMentions(
    reel: ModerationCandidate,
  ): Promise<ReelMentionRecord[]> {
    if (reel.mentions.length === 0) return [];
    const blocked = new Set(await this.accounts.getBlockSet(reel.creatorId));
    return reel.mentions.filter((mention) => !blocked.has(mention.userId));
  }

  private async reject(
    reel: ModerationCandidate,
    verdict: ModerationVerdict,
  ): Promise<void> {
    const rejected = await this.reels.rejectPending(reel.id, verdict);
    if (!rejected) return;

    // The files were never made public, so there is nothing to move: only tell the owner.
    await this.notifications.notifyReelRejected({
      recipientId: rejected.creatorId,
      reelId: rejected.id,
    });
  }
}
