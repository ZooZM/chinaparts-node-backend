import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import {
  ReelsAccount,
  ReelsAccountDocument,
} from '../../accounts/schemas/reels-account.schema';
import { Follow, FollowDocument } from '../schemas/follow.schema';
import {
  NotificationEvent,
  NotificationEventDocument,
} from '../schemas/notification-event.schema';
import {
  ReelCommentReport,
  ReelCommentReportDocument,
} from '../schemas/reel-comment-report.schema';
import {
  ReelComment,
  ReelCommentDocument,
} from '../schemas/reel-comment.schema';
import { ReelLike, ReelLikeDocument } from '../schemas/reel-like.schema';
import {
  ReelProductTap,
  ReelProductTapDocument,
} from '../schemas/reel-product-tap.schema';
import { ReelReport, ReelReportDocument } from '../schemas/reel-report.schema';
import { ReelRepost, ReelRepostDocument } from '../schemas/reel-repost.schema';
import { ReelSave, ReelSaveDocument } from '../schemas/reel-save.schema';
import { ReelShare, ReelShareDocument } from '../schemas/reel-share.schema';
import { ReelView, ReelViewDocument } from '../schemas/reel-view.schema';
import { Reel, ReelDocument } from '../schemas/reel.schema';

const BATCH = 500;

type CounterDeltas = Map<
  string,
  { followers?: number; following?: number; likes?: number }
>;

function bump(
  deltas: CounterDeltas,
  accountId: string,
  field: 'followers' | 'following' | 'likes',
  by: number,
): void {
  const entry = deltas.get(accountId) ?? {};
  entry[field] = (entry[field] ?? 0) + by;
  deltas.set(accountId, entry);
}

/**
 * Everything that removes a deleted account's footprint from the reels data (FR-010), each step
 * safe to run again. A step that changes a counter does it in the same transaction as the removal
 * it corrects, in batches, so an interruption leaves either the whole batch done or none of it and
 * a retry cannot count anything twice or lose a correction.
 */
@Injectable()
export class AccountCleanupRepository {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Reel.name) private readonly reels: Model<ReelDocument>,
    @InjectModel(ReelsAccount.name)
    private readonly accounts: Model<ReelsAccountDocument>,
    @InjectModel(ReelLike.name) private readonly likes: Model<ReelLikeDocument>,
    @InjectModel(ReelSave.name) private readonly saves: Model<ReelSaveDocument>,
    @InjectModel(ReelView.name) private readonly views: Model<ReelViewDocument>,
    @InjectModel(ReelShare.name)
    private readonly shares: Model<ReelShareDocument>,
    @InjectModel(ReelComment.name)
    private readonly comments: Model<ReelCommentDocument>,
    @InjectModel(Follow.name) private readonly follows: Model<FollowDocument>,
    @InjectModel(ReelRepost.name)
    private readonly reposts: Model<ReelRepostDocument>,
    @InjectModel(ReelReport.name)
    private readonly reelReports: Model<ReelReportDocument>,
    @InjectModel(ReelCommentReport.name)
    private readonly commentReports: Model<ReelCommentReportDocument>,
    @InjectModel(NotificationEvent.name)
    private readonly events: Model<NotificationEventDocument>,
    @InjectModel(ReelProductTap.name)
    private readonly taps: Model<ReelProductTapDocument>,
  ) {}

  /** The ids of every reel the account made, whatever its status, a page after `afterId`. */
  async listReelIds(
    creatorId: string,
    afterId: string | null,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.reels
      .find({
        creatorId: new Types.ObjectId(creatorId),
        ...(afterId ? { _id: { $gt: new Types.ObjectId(afterId) } } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit)
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => row._id.toString());
  }

  /** Takes back the account's likes: each reel's `likesCount` and each creator's `totalLikes`. */
  async removeLikes(accountId: string): Promise<number> {
    const userId = new Types.ObjectId(accountId);
    return this.inBatches(async (session) => {
      const batch = await this.likes
        .find({ userId })
        .limit(BATCH)
        .select({ videoId: 1 })
        .session(session)
        .lean<Array<{ _id: Types.ObjectId; videoId: Types.ObjectId }>>()
        .exec();
      if (batch.length === 0) return 0;

      const reels = await this.reels
        .find({ _id: { $in: batch.map((like) => like.videoId) } })
        .select({ creatorId: 1 })
        .session(session)
        .lean<Array<{ _id: Types.ObjectId; creatorId: Types.ObjectId }>>()
        .exec();
      const deltas: CounterDeltas = new Map();
      for (const reel of reels)
        bump(deltas, reel.creatorId.toString(), 'likes', -1);

      await this.reels.bulkWrite(
        batch.map((like) => ({
          updateOne: {
            filter: { _id: like.videoId, likesCount: { $gt: 0 } },
            update: { $inc: { likesCount: -1 } },
          },
        })),
        { session },
      );
      await this.applyDeltas(deltas, session);
      await this.likes.deleteMany(
        { _id: { $in: batch.map((like) => like._id) } },
        { session },
      );
      return batch.length;
    });
  }

  /** Removes the follows in both directions, and takes each counterpart's count down by one. */
  async removeFollows(accountId: string): Promise<number> {
    const id = new Types.ObjectId(accountId);
    const asFollower = await this.inBatches(async (session) => {
      const batch = await this.follows
        .find({ followerId: id })
        .limit(BATCH)
        .select({ followeeId: 1 })
        .session(session)
        .lean<Array<{ _id: Types.ObjectId; followeeId: Types.ObjectId }>>()
        .exec();
      if (batch.length === 0) return 0;
      const deltas: CounterDeltas = new Map();
      for (const follow of batch)
        bump(deltas, follow.followeeId.toString(), 'followers', -1);
      await this.applyDeltas(deltas, session);
      await this.follows.deleteMany(
        { _id: { $in: batch.map((f) => f._id) } },
        { session },
      );
      return batch.length;
    });
    const asFollowee = await this.inBatches(async (session) => {
      const batch = await this.follows
        .find({ followeeId: id })
        .limit(BATCH)
        .select({ followerId: 1 })
        .session(session)
        .lean<Array<{ _id: Types.ObjectId; followerId: Types.ObjectId }>>()
        .exec();
      if (batch.length === 0) return 0;
      const deltas: CounterDeltas = new Map();
      for (const follow of batch)
        bump(deltas, follow.followerId.toString(), 'following', -1);
      await this.applyDeltas(deltas, session);
      await this.follows.deleteMany(
        { _id: { $in: batch.map((f) => f._id) } },
        { session },
      );
      return batch.length;
    });
    return asFollower + asFollowee;
  }

  /** Removes the account's reports of reels, taking each reel's count of reporters down. */
  async removeReelReports(accountId: string): Promise<number> {
    const reporterId = new Types.ObjectId(accountId);
    return this.inBatches(async (session) => {
      const batch = await this.reelReports
        .find({ reporterId })
        .limit(BATCH)
        .select({ videoId: 1 })
        .session(session)
        .lean<Array<{ _id: Types.ObjectId; videoId: Types.ObjectId }>>()
        .exec();
      if (batch.length === 0) return 0;
      await this.reels.bulkWrite(
        batch.map((report) => ({
          updateOne: {
            filter: { _id: report.videoId, reportsCount: { $gt: 0 } },
            update: { $inc: { reportsCount: -1 } },
          },
        })),
        { session },
      );
      await this.reelReports.deleteMany(
        { _id: { $in: batch.map((r) => r._id) } },
        { session },
      );
      return batch.length;
    });
  }

  /**
   * Soft-deletes the account's comments with the role `system`, taking each reel's count down by
   * the number removed. Kept, not erased: the comment reports and any operator review still point
   * at them, and they go with their reel.
   */
  async removeComments(accountId: string): Promise<number> {
    const authorId = new Types.ObjectId(accountId);
    return this.inBatches(async (session) => {
      const batch = await this.comments
        .find({ authorId, deletedAt: null })
        .limit(BATCH)
        .select({ videoId: 1 })
        .session(session)
        .lean<Array<{ _id: Types.ObjectId; videoId: Types.ObjectId }>>()
        .exec();
      if (batch.length === 0) return 0;

      await this.comments.updateMany(
        { _id: { $in: batch.map((c) => c._id) }, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedByRole: 'system' } },
        { session },
      );
      const perReel = new Map<string, number>();
      for (const comment of batch) {
        const key = comment.videoId.toString();
        perReel.set(key, (perReel.get(key) ?? 0) + 1);
      }
      await this.reels.bulkWrite(
        [...perReel].map(([reelId, count]) => ({
          updateOne: {
            filter: {
              _id: new Types.ObjectId(reelId),
              commentsCount: { $gte: count },
            },
            update: { $inc: { commentsCount: -count } },
          },
        })),
        { session },
      );
      return batch.length;
    });
  }

  /** The relations that carry no counter: saves, views, shares, reposts, and comment reports. */
  async removeOtherRelations(accountId: string): Promise<void> {
    const id = new Types.ObjectId(accountId);
    await Promise.all([
      this.saves.deleteMany({ userId: id }),
      this.views.deleteMany({ userId: id }),
      this.shares.deleteMany({ userId: id }),
      this.reposts.deleteMany({ reposterId: id }),
      this.commentReports.deleteMany({ reporterId: id }),
    ]);
  }

  /** Removes the account from every other account's block list. */
  async removeFromBlockLists(accountId: string): Promise<void> {
    const id = new Types.ObjectId(accountId);
    await this.accounts.updateMany(
      { blockedUsers: id },
      { $pull: { blockedUsers: id } },
    );
  }

  /** Removes the notification events the account sent or was to receive. */
  async removeNotificationEvents(accountId: string): Promise<void> {
    const id = new Types.ObjectId(accountId);
    await this.events.deleteMany({
      $or: [{ recipientId: id }, { actorId: id }],
    });
  }

  /** The taps stay (they count the reel's products); who tapped is forgotten. */
  async forgetTapper(accountId: string): Promise<void> {
    await this.taps.updateMany(
      { viewerId: new Types.ObjectId(accountId) },
      { $set: { viewerId: null } },
    );
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.accounts.deleteOne({ _id: new Types.ObjectId(accountId) });
  }

  /** Runs batches until one finds nothing to do, and returns how many items they handled. */
  private async inBatches(
    batch: (session: ClientSession) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const handled = await this.inTransaction(batch);
      if (handled === 0) return total;
      total += handled;
    }
  }

  private async inTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  }

  private async applyDeltas(
    deltas: CounterDeltas,
    session: ClientSession,
  ): Promise<void> {
    if (deltas.size === 0) return;
    await this.accounts.bulkWrite(
      [...deltas].map(([accountId, delta]) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(accountId) },
          update: {
            $inc: {
              ...(delta.followers ? { followersCount: delta.followers } : {}),
              ...(delta.following ? { followingCount: delta.following } : {}),
              ...(delta.likes ? { totalLikes: delta.likes } : {}),
            },
          },
        },
      })),
      { session },
    );
  }
}
