import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { join } from 'path';
import { Reel, ReelDocument, ReelStatus } from './schemas/reel.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { MODERATION_PROVIDER } from './moderation/moderation-provider';
import type {
  ModerationProvider,
  ModerationVerdict,
} from './moderation/moderation-provider';
import { ReelsNotificationsService } from './reels-notifications.service';

/**
 * v3 (FR-062–FR-066): the moderation pipeline's actual logic, deliberately
 * kept free of any BullMQ/`WorkerHost` plumbing so it can run either behind
 * the real queue (`ReelsModerationProcessor`, production) or be invoked
 * directly (tests — a live Redis-backed Worker is real infrastructure the
 * test suite should not need, mirroring how `reels.e2e-spec.ts` already
 * avoids importing `AppModule`). `moderateReel` is the ONLY code path that
 * writes a status transition out of `pending_moderation`.
 */
@Injectable()
export class ReelsModerationService {
  private readonly logger = new Logger(ReelsModerationService.name);

  constructor(
    @InjectModel(Reel.name) private readonly reelModel: Model<ReelDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @Inject(MODERATION_PROVIDER)
    private readonly provider: ModerationProvider,
    private readonly notifications: ReelsNotificationsService,
  ) {}

  async moderateReel(reelId: string): Promise<void> {
    if (!Types.ObjectId.isValid(reelId)) return;
    const reel = await this.reelModel.findById(reelId).exec();
    // No-op: the reel was deleted mid-review, or a prior attempt already
    // decided it (safe under retries/duplicate enqueues — R17).
    if (!reel || reel.status !== ReelStatus.PENDING_MODERATION) return;

    const uploadedAt = reel.createdAt ?? new Date();
    const videoPath = this.toLocalPath(reel.videoUrl);

    // Fail-closed (FR-066): letting this throw propagate to the caller is
    // the point — the reel simply stays pending_moderation and is retried.
    const result = await this.provider.analyze(videoPath, reel.description);

    const verdictLatencyMs = Date.now() - uploadedAt.getTime();
    this.logger.log(
      `Reel ${reelId} verdict: ${result.verdict} (${verdictLatencyMs}ms since upload — SC-018)`,
    );

    if (result.verdict === 'clean') {
      await this.publish(reel);
    } else {
      await this.reject(reel, result);
    }
  }

  /** R17: reels found stuck in `pending_moderation` past `staleMs`. */
  async findStalePendingIds(staleMs: number): Promise<string[]> {
    const stale = await this.reelModel
      .find({
        status: ReelStatus.PENDING_MODERATION,
        updatedAt: { $lt: new Date(Date.now() - staleMs) },
      })
      .select('_id')
      .lean()
      .exec();
    return stale.map((doc) => doc._id.toString());
  }

  private toLocalPath(videoUrl: string): string {
    return join(process.cwd(), videoUrl.replace(/^\/+/, ''));
  }

  private async publish(reel: ReelDocument): Promise<void> {
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: reel._id, status: ReelStatus.PENDING_MODERATION },
        { $set: { status: ReelStatus.PUBLISHED, publishedAt: new Date() } },
      )
      .exec();
    // A concurrent/retried attempt already decided it — never double-fire.
    if (!updated) return;

    const mentions = await this.blockFilteredMentions(reel);
    await this.notifications.notifyMentions({
      actorId: reel.creatorId.toString(),
      reelId: reel._id.toString(),
      mentions,
    });
  }

  /**
   * Plan rule 3: a block created between upload and verdict (in either
   * direction) suppresses that mention notification at fan-out time.
   */
  private async blockFilteredMentions(
    reel: ReelDocument,
  ): Promise<{ userId: string; username: string }[]> {
    if (reel.mentions.length === 0) return [];
    const [creator, reverseBlockers] = await Promise.all([
      this.userModel
        .findById(reel.creatorId)
        .select('blockedUsers')
        .lean()
        .exec(),
      this.userModel
        .find({
          blockedUsers: reel.creatorId,
          _id: { $in: reel.mentions.map((m) => m.userId) },
        })
        .select('_id')
        .lean()
        .exec(),
    ]);
    const creatorBlocked = new Set(
      (creator?.blockedUsers ?? []).map((id) => id.toString()),
    );
    const reverseBlocked = new Set(
      reverseBlockers.map((u) => u._id.toString()),
    );
    return reel.mentions
      .filter(
        (m) =>
          !creatorBlocked.has(m.userId.toString()) &&
          !reverseBlocked.has(m.userId.toString()),
      )
      .map((m) => ({ userId: m.userId.toString(), username: m.username }));
  }

  private async reject(
    reel: ReelDocument,
    result: ModerationVerdict,
  ): Promise<void> {
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: reel._id, status: ReelStatus.PENDING_MODERATION },
        {
          $set: {
            status: ReelStatus.REJECTED,
            moderation: {
              verdict: result.verdict,
              flaggedSource: result.flaggedSource,
              categories: result.categories ?? [],
              providerRef: result.providerRef,
              completedAt: new Date(),
            },
          },
        },
      )
      .exec();
    if (!updated) return;

    await this.notifications.notifyReelRejected({
      recipientId: reel.creatorId.toString(),
      reelId: reel._id.toString(),
    });
  }
}
