import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ErrorCode } from '../../common/errors/error-codes';
import { isDuplicateKeyError } from '../../common/mongo/duplicate-key';
import { escapeRegex } from '../../common/text/escape-regex';
import { AccountsRepository } from '../accounts/accounts.repository';
import { Follow, FollowDocument } from './schemas/follow.schema';
import {
  NotificationEvent,
  NotificationEventDocument,
} from './schemas/notification-event.schema';
import {
  ReelComment,
  ReelCommentDocument,
} from './schemas/reel-comment.schema';
import { ReelLike, ReelLikeDocument } from './schemas/reel-like.schema';
import {
  ReelReport,
  ReelReportDocument,
  ReelReportReason,
} from './schemas/reel-report.schema';
import { ReelRepost, ReelRepostDocument } from './schemas/reel-repost.schema';
import { ReelSave, ReelSaveDocument } from './schemas/reel-save.schema';
import { ReelShare, ReelShareDocument } from './schemas/reel-share.schema';
import {
  ReelGuestView,
  ReelGuestViewDocument,
} from './schemas/reel-guest-view.schema';
import { ReelView, ReelViewDocument } from './schemas/reel-view.schema';
import {
  Reel,
  ReelDocument,
  ReelLean,
  ReelStatus,
} from './schemas/reel.schema';
import {
  AccountSummary,
  AdminHiddenReelRecord,
  CommentDto,
  FollowedUserDto,
  ModerationCandidate,
  ModerationOutcome,
  Page,
  ProfileRecord,
  ReelDeletion,
  ReelMediaRecord,
  ReelRecord,
  ReelReportReasonValue,
  ReelsRepository,
  ReelSnapshot,
  UserSearchResultDto,
} from './reels.repository';

/** The interface keeps reasons as plain strings; the schema stores the enum. Same values. */
const REPORT_REASONS: Record<ReelReportReasonValue, ReelReportReason> = {
  spam: ReelReportReason.SPAM,
  nudity: ReelReportReason.NUDITY,
  violence: ReelReportReason.VIOLENCE,
  hate_speech: ReelReportReason.HATE_SPEECH,
  other: ReelReportReason.OTHER,
};

/** One viewer-relevant reposter (followed accounts plus the viewer) for the badge stack. */
type RepostReposter = AccountSummary;

/** Per-video repost attribution: the primary label, the avatar stack, and the relevant count. */
interface RepostAttribution {
  primary: RepostReposter;
  top: RepostReposter[];
  count: number;
}

type AccountLookup = {
  _id: Types.ObjectId;
  username?: string;
  name?: string;
  avatarUrl?: string | null;
};

function toObjectId(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
}

function toObjectIds(ids: string[]): Types.ObjectId[] {
  return ids.map(toObjectId).filter((id): id is Types.ObjectId => id !== null);
}

function iso(date: Date | undefined): string {
  return (date ?? new Date(0)).toISOString();
}

function mediaOf(reel: Pick<ReelLean, 'media'>): ReelMediaRecord {
  return {
    videoKey: reel.media.videoKey,
    thumbnailKey: reel.media.thumbnailKey,
    location: reel.media.location,
  };
}

function snapshotOf(reel: ReelLean): ReelSnapshot {
  return {
    id: reel._id.toString(),
    creatorId: reel.creatorId.toString(),
    status: reel.status,
    media: mediaOf(reel),
    hashtagsNormalized: reel.hashtagsNormalized,
  };
}

function summaryOf(account: AccountLookup): AccountSummary {
  return {
    id: account._id.toString(),
    username: account.username ?? '',
    name: account.name ?? '',
    avatarUrl: account.avatarUrl ?? null,
  };
}

/**
 * Mongoose-backed `ReelsRepository`. It only reads and writes data (research R22): it never calls
 * a service, never builds a media URL, and returns the outcome of any status change for the
 * caller to act on.
 *
 * Cursor convention for now: an opaque, ever-increasing integer offset encoded as a string. The
 * main feed wraps the offset modulo the catalog size so `nextCursor` is never null; scoped feeds
 * and lists are finite. The keyset cursors of research R9 replace this story by story.
 */
@Injectable()
export class ReelsDbRepository implements ReelsRepository {
  constructor(
    @InjectModel(Reel.name) private readonly reelModel: Model<ReelDocument>,
    @InjectModel(ReelLike.name)
    private readonly likeModel: Model<ReelLikeDocument>,
    @InjectModel(ReelSave.name)
    private readonly saveModel: Model<ReelSaveDocument>,
    @InjectModel(ReelView.name)
    private readonly viewModel: Model<ReelViewDocument>,
    @InjectModel(ReelGuestView.name)
    private readonly guestViewModel: Model<ReelGuestViewDocument>,
    @InjectModel(ReelShare.name)
    private readonly shareModel: Model<ReelShareDocument>,
    @InjectModel(ReelComment.name)
    private readonly commentModel: Model<ReelCommentDocument>,
    @InjectModel(Follow.name)
    private readonly followModel: Model<FollowDocument>,
    @InjectModel(NotificationEvent.name)
    private readonly notificationEventModel: Model<NotificationEventDocument>,
    @InjectModel(ReelReport.name)
    private readonly reportModel: Model<ReelReportDocument>,
    @InjectModel(ReelRepost.name)
    private readonly repostModel: Model<ReelRepostDocument>,
    private readonly accounts: AccountsRepository,
  ) {}

  // ── Cursor helper ───────────────────────────────────────────────────────

  private parseCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException({
        error: ErrorCode.INVALID_CURSOR,
        message: 'Invalid cursor',
      });
    }
    return parsed;
  }

  // ── Hydration (raw docs -> ReelRecord, batched to avoid N+1) ────────────

  private async hydrate(
    reels: ReelLean[],
    viewerId: string,
  ): Promise<ReelRecord[]> {
    if (reels.length === 0) return [];
    const viewerObjectId = toObjectId(viewerId);
    const creatorIds = [...new Set(reels.map((r) => r.creatorId.toString()))];
    const creatorObjectIds = toObjectIds(creatorIds);
    const videoIds = reels.map((r) => r._id);

    const [creators, followed, liked, saved, reposted] = await Promise.all([
      this.accounts.findByIdsLean(creatorIds, [
        'name',
        'username',
        'avatarUrl',
        'accountType',
      ]),
      viewerObjectId
        ? this.followModel
            .find({
              followerId: viewerObjectId,
              followeeId: { $in: creatorObjectIds },
            })
            .select({ followeeId: 1 })
            .lean<Array<{ followeeId: Types.ObjectId }>>()
            .exec()
        : [],
      viewerObjectId
        ? this.likeModel
            .find({ userId: viewerObjectId, videoId: { $in: videoIds } })
            .select({ videoId: 1 })
            .lean<Array<{ videoId: Types.ObjectId }>>()
            .exec()
        : [],
      viewerObjectId
        ? this.saveModel
            .find({ userId: viewerObjectId, videoId: { $in: videoIds } })
            .select({ videoId: 1 })
            .lean<Array<{ videoId: Types.ObjectId }>>()
            .exec()
        : [],
      // Whether the CALLER reposted this reel (drives the action-column button), independent of
      // whether the item is a For You repost-injected copy (that is `repostedBy` below).
      viewerObjectId
        ? this.repostModel
            .find({ reposterId: viewerObjectId, videoId: { $in: videoIds } })
            .select({ videoId: 1 })
            .lean<Array<{ videoId: Types.ObjectId }>>()
            .exec()
        : [],
    ]);

    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));
    const followedSet = new Set(followed.map((f) => f.followeeId.toString()));
    const likedSet = new Set(liked.map((l) => l.videoId.toString()));
    const savedSet = new Set(saved.map((s) => s.videoId.toString()));
    const repostedSet = new Set(reposted.map((r) => r.videoId.toString()));

    return reels.map((r) => {
      const creator = creatorById.get(r.creatorId.toString());
      const id = r._id.toString();
      return {
        id,
        media: mediaOf(r),
        createdAt: iso(r.createdAt),
        description: r.description,
        hashtags: r.hashtags,
        mentions: r.mentions.map((m) => ({
          userId: m.userId.toString(),
          username: m.username,
        })),
        creator: {
          id: r.creatorId.toString(),
          name: creator?.name ?? 'Unknown',
          username: creator?.username ?? '',
          avatarUrl: creator?.avatarUrl ?? null,
          accountType: creator?.accountType ?? 'customer',
          viewerFollowing: followedSet.has(r.creatorId.toString()),
        },
        status: r.status,
        viewsCount: r.viewsCount,
        likesCount: r.likesCount,
        commentsCount: r.commentsCount,
        sharesCount: r.sharesCount,
        viewerLiked: likedSet.has(id),
        viewerSaved: savedSet.has(id),
        // Null by default: the For You merge overwrites this on its repost-injected items only,
        // and every other path (the Following feed included) serves organic items.
        repostedBy: null,
        // Viewer-relevant reposters (followed plus self): a count and a few avatars for the
        // badge stack, overwritten on the For You and profile Reposts paths, 0 and [] elsewhere.
        repostersCount: 0,
        topReposters: [],
        viewerReposted: repostedSet.has(id),
      };
    });
  }

  private excludeFilter(excludeCreatorIds: string[]): Record<string, unknown> {
    if (excludeCreatorIds.length === 0) return {};
    return { creatorId: { $nin: toObjectIds(excludeCreatorIds) } };
  }

  /**
   * Composes with every other read filter by plain object merge (MongoDB ANDs sibling top-level
   * keys), narrowing any query to "published, OR mine". Applied to every read path: visibility is
   * never enforced client-side.
   */
  private visibilityFilter(viewerId: string): Record<string, unknown> {
    const viewerObjectId = toObjectId(viewerId);
    if (!viewerObjectId) return { status: ReelStatus.PUBLISHED };
    return {
      $or: [{ status: ReelStatus.PUBLISHED }, { creatorId: viewerObjectId }],
    };
  }

  /**
   * Reels reposted by accounts the viewer follows (or the viewer themselves), attributed to the
   * most recent qualifying reposter per reel. Reposter-edge blocks are applied here, independent
   * of the creator-edge `excludeCreatorIds` filter the caller also applies. "Still followed" is
   * implicit: followee ids are read fresh on every call, so an unfollow removes the injection on
   * the very next request.
   */
  private async getRepostAttributions(
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<Map<string, RepostAttribution>> {
    const viewerObjectId = toObjectId(viewerId);
    if (!viewerObjectId) return new Map();

    const follows = await this.followModel
      .find({ followerId: viewerObjectId })
      .select({ followeeId: 1 })
      .lean<Array<{ followeeId: Types.ObjectId }>>()
      .exec();
    const reposterIds = toObjectIds([
      ...new Set([...follows.map((f) => f.followeeId.toString()), viewerId]),
    ]);
    if (reposterIds.length === 0) return new Map();

    const reposts = await this.repostModel
      .find({ reposterId: { $in: reposterIds } })
      .sort({ createdAt: -1 })
      .lean<Array<{ videoId: Types.ObjectId; reposterId: Types.ObjectId }>>()
      .exec();
    if (reposts.length === 0) return new Map();

    // Collect every relevant reposter per video, most recent first: the badge shows a count and a
    // few avatars.
    const repostsByVideo = new Map<string, typeof reposts>();
    for (const repost of reposts) {
      const key = repost.videoId.toString();
      const list = repostsByVideo.get(key);
      if (list) list.push(repost);
      else repostsByVideo.set(key, [repost]);
    }

    const videoIds = toObjectIds([...repostsByVideo.keys()]);
    const reposterIdsNeeded = [
      ...new Set(reposts.map((r) => r.reposterId.toString())),
    ];

    const [reels, reposterAccounts] = await Promise.all([
      this.reelModel
        .find({
          _id: { $in: videoIds },
          ...this.excludeFilter(excludeCreatorIds),
          status: ReelStatus.PUBLISHED,
        })
        .select({ _id: 1 })
        .lean<Array<{ _id: Types.ObjectId }>>()
        .exec(),
      this.accounts.findByIdsLean(reposterIdsNeeded, [
        'username',
        'name',
        'avatarUrl',
      ]),
    ]);
    const visibleVideoIds = new Set(reels.map((r) => r._id.toString()));
    const excludeReposterSet = new Set(excludeCreatorIds);
    const reposterById = new Map(
      reposterAccounts.map((account) => [account._id.toString(), account]),
    );

    const attributions = new Map<string, RepostAttribution>();
    for (const [videoId, list] of repostsByVideo) {
      if (!visibleVideoIds.has(videoId)) continue; // source no longer published, or blocked
      const relevant: RepostReposter[] = [];
      for (const repost of list) {
        const reposterId = repost.reposterId.toString();
        if (excludeReposterSet.has(reposterId)) continue; // reposter-edge block
        const reposter = reposterById.get(reposterId);
        if (!reposter) continue;
        relevant.push(summaryOf(reposter));
      }
      if (relevant.length === 0) continue;
      attributions.set(videoId, {
        primary: relevant[0],
        top: relevant.slice(0, 3),
        count: relevant.length,
      });
    }
    return attributions;
  }

  // ── ReelsRepository ─────────────────────────────────────────────────────

  async createReel(params: {
    id: string;
    creatorId: string;
    videoKey: string;
    thumbnailKey: string;
    description: string;
    hashtags: string[];
    hashtagsNormalized: string[];
    mentions: { userId: string; username: string }[];
  }): Promise<ReelRecord> {
    await this.reelModel.create({
      _id: new Types.ObjectId(params.id),
      creatorId: new Types.ObjectId(params.creatorId),
      media: {
        videoKey: params.videoKey,
        thumbnailKey: params.thumbnailKey,
        location: 'private',
      },
      description: params.description,
      hashtags: params.hashtags,
      hashtagsNormalized: params.hashtagsNormalized,
      mentions: params.mentions.map((m) => ({
        userId: new Types.ObjectId(m.userId),
        username: m.username,
      })),
      status: ReelStatus.PENDING_MODERATION,
    });
    const created = await this.reelModel
      .findById(params.id)
      .lean<ReelLean>()
      .exec();
    if (!created) throw new Error('Created reel vanished');
    const [hydrated] = await this.hydrate([created], params.creatorId);
    return hydrated;
  }

  async listFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    creatorId?: string;
    hashtag?: string;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>> {
    const offset = this.parseCursor(params.cursor);
    const filter: Record<string, unknown> = {};

    if (params.creatorId) {
      // A specific creatorId and the $nin exclusion both target the same field and cannot be
      // merged. If the requested creator is excluded the scoped feed is simply empty; otherwise
      // filter by the exact id.
      if (params.excludeCreatorIds.includes(params.creatorId)) {
        return { items: [], nextCursor: null };
      }
      const creatorObjectId = toObjectId(params.creatorId);
      if (!creatorObjectId) return { items: [], nextCursor: null };
      filter.creatorId = creatorObjectId;
    } else {
      Object.assign(filter, this.excludeFilter(params.excludeCreatorIds));
    }
    if (params.hashtag) {
      filter.hashtagsNormalized = params.hashtag;
    }
    // Published, or mine: composes with whichever of the filters above are already set.
    Object.assign(filter, this.visibilityFilter(params.viewerId));

    const isScoped = Boolean(params.creatorId || params.hashtag);
    const total = await this.reelModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };

    if (isScoped) {
      // Finite: creator-scoped and hashtag-scoped feeds terminate.
      const docs = await this.reelModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(offset)
        .limit(params.limit)
        .lean<ReelLean[]>()
        .exec();
      const nextOffset = offset + params.limit;
      return {
        items: await this.hydrate(docs, params.viewerId),
        nextCursor: nextOffset < total ? String(nextOffset) : null,
      };
    }

    // The main feed loops the catalog indefinitely: nextCursor is never null.
    const sorted = await this.reelModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .lean<ReelLean[]>()
      .exec();

    // This IS the For You feed: merge in followees' (and the viewer's own) reposts. Scoped feeds
    // never reach this branch, so Following has no reposts and creator/hashtag feeds stay pure.
    const attributions = await this.getRepostAttributions(
      params.viewerId,
      params.excludeCreatorIds,
    );

    const docs: ReelLean[] = [];
    const byId = new Map(sorted.map((d) => [d._id.toString(), d]));
    if (offset === 0 && attributions.size > 0) {
      // Reposts are surfaced with priority on the very first page.
      const seeded = new Set<string>();
      for (const [videoId] of attributions) {
        if (docs.length >= params.limit) break;
        const doc = byId.get(videoId);
        if (!doc || seeded.has(videoId)) continue;
        docs.push(doc);
        seeded.add(videoId);
      }
      for (let i = 0; docs.length < params.limit && i < sorted.length; i++) {
        const doc = sorted[i % sorted.length];
        const id = doc._id.toString();
        if (seeded.has(id)) continue;
        docs.push(doc);
        seeded.add(id);
      }
    } else {
      for (let i = 0; i < params.limit; i++) {
        docs.push(sorted[(offset + i) % sorted.length]);
      }
    }

    const items = await this.hydrate(docs, params.viewerId);
    // Attach repost attribution to whichever page items carry one.
    for (const item of items) {
      const attribution = attributions.get(item.id);
      if (attribution) {
        item.repostedBy = attribution.primary;
        item.repostersCount = attribution.count;
        item.topReposters = attribution.top;
      }
    }

    return { items, nextCursor: String(offset + params.limit) };
  }

  /**
   * Originals only, from accounts the viewer follows. Excluded followees are filtered out of the
   * id list up front, rather than combining `$in` and `$nin` on the same `creatorId` field, which
   * a plain-object merge cannot express.
   */
  async listFollowingFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>> {
    const viewerObjectId = toObjectId(params.viewerId);
    if (!viewerObjectId) return { items: [], nextCursor: null };

    const follows = await this.followModel
      .find({ followerId: viewerObjectId })
      .select({ followeeId: 1 })
      .lean<Array<{ followeeId: Types.ObjectId }>>()
      .exec();
    const excludeSet = new Set(params.excludeCreatorIds);
    const followeeIds = follows
      .map((f) => f.followeeId)
      .filter((id) => !excludeSet.has(id.toString()));
    if (followeeIds.length === 0) return { items: [], nextCursor: null };

    const offset = this.parseCursor(params.cursor);
    const filter: Record<string, unknown> = {
      creatorId: { $in: followeeIds },
      ...this.visibilityFilter(params.viewerId),
    };
    const total = await this.reelModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };

    const docs = await this.reelModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<ReelLean[]>()
      .exec();
    const nextOffset = offset + params.limit;
    return {
      items: await this.hydrate(docs, params.viewerId),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  async getReel(
    id: string,
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<ReelRecord | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    const doc = await this.reelModel
      .findOne({
        _id: objectId,
        ...this.excludeFilter(excludeCreatorIds),
        ...this.visibilityFilter(viewerId),
      })
      .lean<ReelLean>()
      .exec();
    if (!doc) return null;
    const [hydrated] = await this.hydrate([doc], viewerId);
    return hydrated;
  }

  async toggleLike(
    id: string,
    viewerId: string,
  ): Promise<{
    liked: boolean;
    likesCount: number;
    reel: { id: string; creatorId: string };
  } | null> {
    const videoId = toObjectId(id);
    const userId = toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // Engagement is only possible on published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .select({ creatorId: 1, likesCount: 1 })
      .lean<Pick<ReelLean, '_id' | 'creatorId' | 'likesCount'>>()
      .exec();
    if (!reel) return null;

    const existing = await this.likeModel
      .findOneAndDelete({ userId, videoId })
      .exec();

    let delta = 0;
    if (existing) {
      delta = -1;
    } else {
      try {
        await this.likeModel.create({ userId, videoId });
        delta = 1;
      } catch (error) {
        // A duplicate-key race (a rapid double tap): another request already inserted the like,
        // which is the same as already-liked, with no double count.
        if (!isDuplicateKeyError(error)) throw error;
      }
    }

    let likesCount = reel.likesCount;
    if (delta !== 0) {
      const updated = await this.reelModel
        .findOneAndUpdate(
          { _id: videoId },
          { $inc: { likesCount: delta } },
          { returnDocument: 'after' },
        )
        .select({ likesCount: 1 })
        .lean<{ likesCount: number }>()
        .exec();
      likesCount = Math.max(0, updated?.likesCount ?? likesCount + delta);
      await this.accounts.incrementCounters(reel.creatorId.toString(), {
        totalLikes: delta,
      });
    }

    return {
      liked: !existing,
      likesCount,
      reel: { id: reel._id.toString(), creatorId: reel.creatorId.toString() },
    };
  }

  async listComments(
    id: string,
    params: { cursor?: string; limit: number; excludeAuthorIds: string[] },
  ): Promise<{
    items: CommentDto[];
    nextCursor: string | null;
    commentsCount: number;
  } | null> {
    const videoId = toObjectId(id);
    if (!videoId) return null;
    // A non-published reel has no comments to serve.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .select({ commentsCount: 1 })
      .lean<{ commentsCount: number }>()
      .exec();
    if (!reel) return null;

    const offset = this.parseCursor(params.cursor);
    const filter: Record<string, unknown> = { videoId };
    if (params.excludeAuthorIds.length > 0) {
      filter.authorId = { $nin: toObjectIds(params.excludeAuthorIds) };
    }
    const total = await this.commentModel.countDocuments(filter).exec();
    const docs = await this.commentModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<
        Array<{
          _id: Types.ObjectId;
          authorId: Types.ObjectId;
          text: string;
          createdAt?: Date;
        }>
      >()
      .exec();

    const authors = await this.accounts.findByIdsLean(
      [...new Set(docs.map((d) => d.authorId.toString()))],
      ['name', 'avatarUrl'],
    );
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));

    const nextOffset = offset + params.limit;
    return {
      items: docs.map((c) => {
        const author = authorById.get(c.authorId.toString());
        return {
          id: c._id.toString(),
          authorId: c.authorId.toString(),
          authorName: author?.name ?? 'Unknown',
          authorAvatarUrl: author?.avatarUrl ?? null,
          text: c.text,
          createdAt: iso(c.createdAt),
        };
      }),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
      commentsCount: reel.commentsCount,
    };
  }

  async addComment(
    id: string,
    viewerId: string,
    text: string,
  ): Promise<{ comment: CommentDto; commentsCount: number } | null> {
    const videoId = toObjectId(id);
    const authorId = toObjectId(viewerId);
    if (!videoId || !authorId) return null;
    // No engagement on non-published reels.
    const exists = await this.reelModel.exists({
      _id: videoId,
      status: ReelStatus.PUBLISHED,
    });
    if (!exists) return null;

    const created = await this.commentModel.create({ videoId, authorId, text });
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: videoId },
        { $inc: { commentsCount: 1 } },
        { returnDocument: 'after' },
      )
      .select({ commentsCount: 1 })
      .lean<{ commentsCount: number }>()
      .exec();
    const [author] = await this.accounts.findByIdsLean(
      [viewerId],
      ['name', 'avatarUrl'],
    );

    return {
      comment: {
        id: created._id.toString(),
        authorId: viewerId,
        authorName: author?.name ?? 'Unknown',
        authorAvatarUrl: author?.avatarUrl ?? null,
        text: created.text,
        createdAt: iso(created.createdAt),
      },
      commentsCount: updated?.commentsCount ?? 0,
    };
  }

  async recordShare(
    id: string,
    viewerId: string,
  ): Promise<{ sharesCount: number } | null> {
    const videoId = toObjectId(id);
    const userId = toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // No engagement on non-published reels.
    const exists = await this.reelModel.exists({
      _id: videoId,
      status: ReelStatus.PUBLISHED,
    });
    if (!exists) return null;

    await this.shareModel.create({ userId, videoId });
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: videoId },
        { $inc: { sharesCount: 1 } },
        { returnDocument: 'after' },
      )
      .select({ sharesCount: 1 })
      .lean<{ sharesCount: number }>()
      .exec();
    return { sharesCount: updated?.sharesCount ?? 0 };
  }

  async getProfile(
    userId: string,
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<ProfileRecord | null> {
    const targetId = toObjectId(userId);
    if (!targetId) return null;
    if (excludeCreatorIds.includes(userId)) return null;

    const account = await this.accounts.findByIdLean(userId);
    if (!account) return null;

    const viewerObjectId = toObjectId(viewerId);
    const isSelf = userId === viewerId;
    // Others see only published videos in the grid; the owner sees their own reels in every
    // status, and the `status` field below lets the app render the Processing, Removed and
    // Under review badges.
    const videos = await this.reelModel
      .find({
        creatorId: targetId,
        ...(isSelf ? {} : { status: ReelStatus.PUBLISHED }),
      })
      .sort({ createdAt: -1, _id: -1 })
      .select({ media: 1, status: 1 })
      .lean<Array<Pick<ReelLean, '_id' | 'media' | 'status'>>>()
      .exec();
    const isFollowing = viewerObjectId
      ? Boolean(
          await this.followModel
            .exists({ followerId: viewerObjectId, followeeId: targetId })
            .exec(),
        )
      : false;

    return {
      user: {
        id: account._id.toString(),
        name: account.name,
        username: account.username,
        avatarUrl: account.avatarUrl,
        accountType: account.accountType,
        bio: account.bio,
      },
      stats: {
        followers: account.followersCount,
        following: account.followingCount,
        totalLikes: account.totalLikes,
      },
      videos: videos.map((v) => ({
        id: v._id.toString(),
        media: mediaOf(v),
        status: v.status,
      })),
      viewer: { following: isFollowing, isSelf },
    };
  }

  async toggleFollow(
    userId: string,
    viewerId: string,
  ): Promise<{ following: boolean; followersCount: number } | 'self' | null> {
    if (userId === viewerId) return 'self';
    const followeeId = toObjectId(userId);
    const followerId = toObjectId(viewerId);
    if (!followeeId || !followerId) return null;
    const followee = await this.accounts.findByIdLean(userId);
    if (!followee) return null;

    const existing = await this.followModel
      .findOneAndDelete({ followerId, followeeId })
      .exec();

    let followersCount = followee.followersCount;
    if (existing) {
      const counters = await this.accounts.incrementCounters(userId, {
        followersCount: -1,
      });
      await this.accounts.incrementCounters(viewerId, { followingCount: -1 });
      followersCount = Math.max(
        0,
        counters?.followersCount ?? followersCount - 1,
      );
      return { following: false, followersCount };
    }

    try {
      await this.followModel.create({ followerId, followeeId });
    } catch (error) {
      // A duplicate-key race: already following, with no double count.
      if (!isDuplicateKeyError(error)) throw error;
      return { following: true, followersCount };
    }
    const counters = await this.accounts.incrementCounters(userId, {
      followersCount: 1,
    });
    await this.accounts.incrementCounters(viewerId, { followingCount: 1 });
    return {
      following: true,
      followersCount: counters?.followersCount ?? followersCount + 1,
    };
  }

  async recordView(
    id: string,
    viewerId: string,
  ): Promise<{ viewsCount: number } | null> {
    const videoId = toObjectId(id);
    const userId = toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // No engagement on non-published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .select({ viewsCount: 1 })
      .lean<{ viewsCount: number }>()
      .exec();
    if (!reel) return null;

    try {
      await this.viewModel.create({ userId, videoId });
    } catch (error) {
      // Already viewed by this account: no increment (a view counts once).
      if (!isDuplicateKeyError(error)) throw error;
      return { viewsCount: reel.viewsCount };
    }
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: videoId },
        { $inc: { viewsCount: 1 } },
        { returnDocument: 'after' },
      )
      .select({ viewsCount: 1 })
      .lean<{ viewsCount: number }>()
      .exec();
    return { viewsCount: updated?.viewsCount ?? reel.viewsCount + 1 };
  }

  async recordGuestView(
    id: string,
    installationId: string,
  ): Promise<{ viewsCount: number } | null> {
    const videoId = toObjectId(id);
    if (!videoId) return null;
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .select({ viewsCount: 1 })
      .lean<{ viewsCount: number }>()
      .exec();
    if (!reel) return null;

    try {
      await this.guestViewModel.create({ installationId, videoId });
    } catch (error) {
      // This installation already viewed it: no increment.
      if (!isDuplicateKeyError(error)) throw error;
      return { viewsCount: reel.viewsCount };
    }
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: videoId },
        { $inc: { viewsCount: 1 } },
        { returnDocument: 'after' },
      )
      .select({ viewsCount: 1 })
      .lean<{ viewsCount: number }>()
      .exec();
    return { viewsCount: updated?.viewsCount ?? reel.viewsCount + 1 };
  }

  async toggleSave(
    id: string,
    viewerId: string,
  ): Promise<{ saved: boolean } | null> {
    const videoId = toObjectId(id);
    const userId = toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // No engagement on non-published reels.
    const exists = await this.reelModel.exists({
      _id: videoId,
      status: ReelStatus.PUBLISHED,
    });
    if (!exists) return null;

    const existing = await this.saveModel
      .findOneAndDelete({ userId, videoId })
      .exec();
    if (existing) return { saved: false };

    try {
      await this.saveModel.create({ userId, videoId });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    return { saved: true };
  }

  async listLiked(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<Page<ReelRecord>> {
    return this.listByRelation(this.likeModel, viewerId, params);
  }

  async listSaved(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<Page<ReelRecord>> {
    return this.listByRelation(this.saveModel, viewerId, params);
  }

  /** Shared by listLiked and listSaved: relation-recency order, hydrated, exclusion-filtered. */
  private async listByRelation(
    relationModel: Model<ReelLikeDocument> | Model<ReelSaveDocument>,
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<Page<ReelRecord>> {
    const userId = toObjectId(viewerId);
    if (!userId) return { items: [], nextCursor: null };
    const offset = this.parseCursor(params.cursor);

    const total = await relationModel.countDocuments({ userId }).exec();
    if (total === 0) return { items: [], nextCursor: null };

    const relations = await relationModel
      .find({ userId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<Array<{ videoId: Types.ObjectId }>>()
      .exec();
    const ordered = await this.reelsInOrder(
      relations.map((r) => r.videoId),
      viewerId,
      params.excludeCreatorIds,
    );

    const nextOffset = offset + params.limit;
    return {
      items: await this.hydrate(ordered, viewerId),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * The reels behind a list of relations, in the relation order, dropping any the viewer may not
   * see (excluded creator, or no longer published). Likes and saves can only be recorded on
   * published reels, but this keeps historical or edge-case relations from surfacing a
   * non-published reel.
   */
  private async reelsInOrder(
    videoIds: Types.ObjectId[],
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<ReelLean[]> {
    const reels = await this.reelModel
      .find({
        _id: { $in: videoIds },
        ...this.excludeFilter(excludeCreatorIds),
        ...this.visibilityFilter(viewerId),
      })
      .lean<ReelLean[]>()
      .exec();
    const byId = new Map(reels.map((r) => [r._id.toString(), r]));
    return videoIds
      .map((id) => byId.get(id.toString()))
      .filter((reel): reel is ReelLean => reel !== undefined);
  }

  /**
   * `targetUserId`'s reposts, newest-repost-first (the public tab). A reposted reel that has since
   * left the published state drops out through the standard visibility filter.
   */
  async listReposted(
    viewerId: string,
    targetUserId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<Page<ReelRecord>> {
    const reposterId = toObjectId(targetUserId);
    if (!reposterId) return { items: [], nextCursor: null };
    const offset = this.parseCursor(params.cursor);

    const total = await this.repostModel.countDocuments({ reposterId }).exec();
    if (total === 0) return { items: [], nextCursor: null };

    const relations = await this.repostModel
      .find({ reposterId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<Array<{ videoId: Types.ObjectId }>>()
      .exec();
    const ordered = await this.reelsInOrder(
      relations.map((r) => r.videoId),
      viewerId,
      params.excludeCreatorIds,
    );
    const items = await this.hydrate(ordered, viewerId);

    // Every item here was reposted BY the target account, so it is always the primary
    // attribution. The badge also counts the OTHER viewer-relevant reposters (followed accounts,
    // plus the viewer) of the same video, so it matches the For You stack everywhere.
    const [owner] = await this.accounts.findByIdsLean(
      [targetUserId],
      ['username', 'name', 'avatarUrl'],
    );
    const ownerReposter: RepostReposter = owner
      ? summaryOf(owner)
      : { id: targetUserId, username: '', name: '', avatarUrl: null };
    const relevant = await this.getRelevantRepostersForVideos(
      viewerId,
      items.map((item) => item.id),
      params.excludeCreatorIds,
      targetUserId,
    );
    for (const item of items) {
      const others = (relevant.get(item.id) ?? []).filter(
        (r) => r.id !== targetUserId,
      );
      const stack = [ownerReposter, ...others];
      item.repostedBy = ownerReposter;
      item.repostersCount = stack.length;
      item.topReposters = stack.slice(0, 3);
    }

    const nextOffset = offset + params.limit;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * For a set of videos, the reposters relevant to the viewer (accounts the viewer follows, the
   * viewer, and `alwaysIncludeUserId`), each video's list most-recent-first and block-filtered.
   * Powers the multi-reposter badge on scoped surfaces such as the profile Reposts list.
   */
  private async getRelevantRepostersForVideos(
    viewerId: string,
    videoIds: string[],
    excludeCreatorIds: string[],
    alwaysIncludeUserId?: string,
  ): Promise<Map<string, RepostReposter[]>> {
    const viewerObjectId = toObjectId(viewerId);
    const videoObjectIds = toObjectIds(videoIds);
    if (!viewerObjectId || videoObjectIds.length === 0) return new Map();

    const follows = await this.followModel
      .find({ followerId: viewerObjectId })
      .select({ followeeId: 1 })
      .lean<Array<{ followeeId: Types.ObjectId }>>()
      .exec();
    const relevantIds = toObjectIds([
      ...new Set([
        ...follows.map((f) => f.followeeId.toString()),
        viewerId,
        ...(alwaysIncludeUserId ? [alwaysIncludeUserId] : []),
      ]),
    ]);

    const reposts = await this.repostModel
      .find({
        videoId: { $in: videoObjectIds },
        reposterId: { $in: relevantIds },
      })
      .sort({ createdAt: -1, _id: -1 })
      .lean<Array<{ videoId: Types.ObjectId; reposterId: Types.ObjectId }>>()
      .exec();
    if (reposts.length === 0) return new Map();

    const accounts = await this.accounts.findByIdsLean(
      [...new Set(reposts.map((r) => r.reposterId.toString()))],
      ['username', 'name', 'avatarUrl'],
    );
    const accountById = new Map(accounts.map((a) => [a._id.toString(), a]));
    const excludeSet = new Set(excludeCreatorIds);

    const byVideo = new Map<string, RepostReposter[]>();
    for (const repost of reposts) {
      const reposterId = repost.reposterId.toString();
      if (excludeSet.has(reposterId)) continue;
      const account = accountById.get(reposterId);
      if (!account) continue;
      const videoId = repost.videoId.toString();
      const list = byVideo.get(videoId);
      if (list) list.push(summaryOf(account));
      else byVideo.set(videoId, [summaryOf(account)]);
    }
    return byVideo;
  }

  async searchReels(params: {
    viewerId: string;
    q: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>> {
    const offset = this.parseCursor(params.cursor);
    const filter: Record<string, unknown> = {
      hashtagsNormalized: { $regex: escapeRegex(params.q) },
      ...this.excludeFilter(params.excludeCreatorIds),
      ...this.visibilityFilter(params.viewerId),
    };
    const total = await this.reelModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };
    const docs = await this.reelModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<ReelLean[]>()
      .exec();
    const nextOffset = offset + params.limit;
    return {
      items: await this.hydrate(docs, params.viewerId),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  async searchUsers(params: {
    viewerId: string;
    q: string;
    cursor?: string;
    limit: number;
    excludeUserIds: string[];
  }): Promise<Page<UserSearchResultDto>> {
    const offset = this.parseCursor(params.cursor);
    const { total, items } = await this.accounts.searchByNormalized({
      normalizedQuery: params.q,
      excludeIds: [params.viewerId, ...params.excludeUserIds],
      skip: offset,
      limit: params.limit,
    });
    if (total === 0) return { items: [], nextCursor: null };

    const viewerObjectId = toObjectId(params.viewerId);
    const followed = viewerObjectId
      ? await this.followModel
          .find({
            followerId: viewerObjectId,
            followeeId: { $in: items.map((account) => account._id) },
          })
          .select({ followeeId: 1 })
          .lean<Array<{ followeeId: Types.ObjectId }>>()
          .exec()
      : [];
    const followedSet = new Set(followed.map((f) => f.followeeId.toString()));

    const nextOffset = offset + params.limit;
    return {
      items: items.map((account) => ({
        ...summaryOf(account),
        viewerFollowing: followedSet.has(account._id.toString()),
      })),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * The caller's followees, most-recently-followed first, on the `{followerId, createdAt}` index.
   * Excluded followees are dropped defensively (a block does not delete the follow relation).
   * Order comes from the Follow relation, so followees are hydrated then re-sorted to match.
   */
  async getFollowingUsers(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeUserIds: string[];
  }): Promise<Page<FollowedUserDto>> {
    const viewerObjectId = toObjectId(params.viewerId);
    if (!viewerObjectId) return { items: [], nextCursor: null };

    const excludeIds = toObjectIds(params.excludeUserIds);
    const filter: Record<string, unknown> = {
      followerId: viewerObjectId,
      ...(excludeIds.length > 0 ? { followeeId: { $nin: excludeIds } } : {}),
    };

    const offset = this.parseCursor(params.cursor);
    const total = await this.followModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };

    const follows = await this.followModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<Array<{ followeeId: Types.ObjectId }>>()
      .exec();

    const accounts = await this.accounts.findByIdsLean(
      follows.map((f) => f.followeeId.toString()),
      ['username', 'name', 'avatarUrl'],
    );
    const accountById = new Map(accounts.map((a) => [a._id.toString(), a]));
    const items = follows
      .map((f) => accountById.get(f.followeeId.toString()))
      .filter((account): account is NonNullable<typeof account> => !!account)
      .map(summaryOf);

    const nextOffset = offset + params.limit;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * Everyone who reposted `reelId`, most-recent-first. The reel must be visible to the viewer
   * (published, or theirs); reposters the viewer blocked are filtered out.
   */
  async listReposters(
    reelId: string,
    params: {
      viewerId: string;
      cursor?: string;
      limit: number;
      excludeUserIds: string[];
    },
  ): Promise<Page<FollowedUserDto> | null> {
    const videoId = toObjectId(reelId);
    if (!videoId) return null;

    const reel = await this.reelModel
      .findOne({ _id: videoId, ...this.visibilityFilter(params.viewerId) })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    if (!reel) return null;

    const excludeIds = toObjectIds(params.excludeUserIds);
    const filter: Record<string, unknown> = {
      videoId,
      ...(excludeIds.length > 0 ? { reposterId: { $nin: excludeIds } } : {}),
    };

    const offset = this.parseCursor(params.cursor);
    const total = await this.repostModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };

    const reposts = await this.repostModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<Array<{ reposterId: Types.ObjectId }>>()
      .exec();

    const accounts = await this.accounts.findByIdsLean(
      reposts.map((r) => r.reposterId.toString()),
      ['username', 'name', 'avatarUrl'],
    );
    const accountById = new Map(accounts.map((a) => [a._id.toString(), a]));
    const items = reposts
      .map((r) => accountById.get(r.reposterId.toString()))
      .filter((account): account is NonNullable<typeof account> => !!account)
      .map(summaryOf);

    const nextOffset = offset + params.limit;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * Cascade order: the creator's counter first, then the relation documents, then reel-scoped
   * notification events, then the reel document itself. Owner-only, any status. Sequential
   * writes, with no transactions: the final guarded delete makes a retry safe. Deleting the media
   * is the caller's job: this method deletes data and nothing else.
   */
  async deleteReelCascade(
    id: string,
    viewerId: string,
  ): Promise<ReelDeletion | 'forbidden' | null> {
    const videoId = toObjectId(id);
    if (!videoId) return null;
    const reel = await this.reelModel.findById(videoId).lean<ReelLean>().exec();
    if (!reel) return null;
    if (reel.creatorId.toString() !== viewerId) return 'forbidden';

    if (reel.likesCount > 0) {
      await this.accounts.incrementCounters(viewerId, {
        totalLikes: -reel.likesCount,
      });
    }

    // Likes, saves, views, shares, comments, reposts and reports all go with the reel (FR-032).
    await Promise.all([
      this.likeModel.deleteMany({ videoId }).exec(),
      this.saveModel.deleteMany({ videoId }).exec(),
      this.viewModel.deleteMany({ videoId }).exec(),
      this.guestViewModel.deleteMany({ videoId }).exec(),
      this.shareModel.deleteMany({ videoId }).exec(),
      this.commentModel.deleteMany({ videoId }).exec(),
      this.repostModel.deleteMany({ videoId }).exec(),
      this.reportModel.deleteMany({ videoId }).exec(),
    ]);
    await this.notificationEventModel.deleteMany({ reelId: videoId }).exec();
    await this.reelModel.deleteOne({ _id: videoId }).exec();

    return snapshotOf(reel);
  }

  async reportReel(
    id: string,
    viewerId: string,
    reason: ReelReportReasonValue,
    customReason: string | undefined,
    autoHideThreshold: number,
  ): Promise<'reported' | 'duplicate' | 'hidden' | 'self' | null> {
    const videoId = toObjectId(id);
    const userId = toObjectId(viewerId);
    if (!videoId || !userId) return null;

    // Reports are accepted only against published reels: non-published reels follow the
    // unknown-reel path.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .select({ creatorId: 1 })
      .lean<{ creatorId: Types.ObjectId }>()
      .exec();
    if (!reel) return null;
    if (reel.creatorId.equals(userId)) return 'self';

    try {
      await this.reportModel.create({
        videoId,
        reporterId: userId,
        reason: REPORT_REASONS[reason],
        // Only `other` carries a custom reason.
        customReason: reason === 'other' ? customReason : undefined,
      });
    } catch (error) {
      // A duplicate-key race: this reporter's report is already recorded, so it is a no-op.
      if (!isDuplicateKeyError(error)) throw error;
      return 'duplicate';
    }

    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: videoId },
        { $inc: { reportsCount: 1 } },
        { returnDocument: 'after' },
      )
      .select({ reportsCount: 1 })
      .lean<{ reportsCount: number }>()
      .exec();

    if (updated && updated.reportsCount >= autoHideThreshold) {
      // Guarded: the precondition excludes reels already moved out of `published` (by this same
      // threshold check racing another report, or by any other writer) and reels an operator
      // ever restored. Under concurrent reports crossing the threshold at the same instant, only
      // one update actually matches and flips the status; the others are harmless no-ops. That is
      // what makes the hide, and its side effects, fire exactly once.
      const hidden = await this.reelModel
        .findOneAndUpdate(
          {
            _id: videoId,
            status: ReelStatus.PUBLISHED,
            adminRestored: { $ne: true },
          },
          { $set: { status: ReelStatus.HIDDEN } },
        )
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId }>()
        .exec();
      if (hidden) return 'hidden';
    }
    return 'reported';
  }

  async countRecentReelReports(
    reporterId: string,
    since: Date,
  ): Promise<number> {
    const userId = toObjectId(reporterId);
    if (!userId) return 0;
    return this.reportModel
      .countDocuments({ reporterId: userId, createdAt: { $gte: since } })
      .exec();
  }

  /** The operator review backlog: hidden reels, newest-hidden-first. */
  async listHiddenReels(params: {
    cursor?: string;
    limit: number;
  }): Promise<Page<AdminHiddenReelRecord>> {
    const offset = this.parseCursor(params.cursor);
    const filter = { status: ReelStatus.HIDDEN };
    const total = await this.reelModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };

    // `updatedAt` advances on the hide transition (timestamps: true), so sorting by it
    // descending is "most recently hidden first", on the same `{status, updatedAt}` index the
    // pending sweep uses.
    const docs = await this.reelModel
      .find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean<ReelLean[]>()
      .exec();

    const reelIds = docs.map((d) => d._id);
    const [creators, reports] = await Promise.all([
      this.accounts.findByIdsLean(
        [...new Set(docs.map((d) => d.creatorId.toString()))],
        ['username'],
      ),
      this.reportModel
        .find({ videoId: { $in: reelIds } })
        .sort({ createdAt: 1 })
        .lean<
          Array<{
            videoId: Types.ObjectId;
            reporterId: Types.ObjectId;
            reason: string;
            customReason?: string;
            createdAt?: Date;
          }>
        >()
        .exec(),
    ]);
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));
    const reportsByVideo = new Map<string, typeof reports>();
    for (const report of reports) {
      const key = report.videoId.toString();
      const existing = reportsByVideo.get(key);
      if (existing) existing.push(report);
      else reportsByVideo.set(key, [report]);
    }

    const nextOffset = offset + params.limit;
    return {
      items: docs.map((d) => ({
        id: d._id.toString(),
        creator: {
          id: d.creatorId.toString(),
          username: creatorById.get(d.creatorId.toString())?.username ?? '',
        },
        media: mediaOf(d),
        description: d.description,
        hiddenAt: iso(d.updatedAt),
        reportsCount: d.reportsCount,
        reports: (reportsByVideo.get(d._id.toString()) ?? []).map((r) => ({
          reporterId: r.reporterId.toString(),
          reason: r.reason,
          customReason: r.customReason ?? null,
          createdAt: iso(r.createdAt),
        })),
      })),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * Operator-only `hidden -> published | rejected`. `restore` sets `adminRestored`: permanent
   * auto-hide immunity. `reportsCount` is left untouched, kept for audit.
   */
  async adminModerateReel(
    id: string,
    action: 'restore' | 'reject',
  ): Promise<ReelSnapshot | 'not_hidden' | null> {
    const videoId = toObjectId(id);
    if (!videoId) return null;
    const exists = await this.reelModel.exists({ _id: videoId });
    if (!exists) return null;

    const update =
      action === 'restore'
        ? { $set: { status: ReelStatus.PUBLISHED, adminRestored: true } }
        : { $set: { status: ReelStatus.REJECTED } };

    const updated = await this.reelModel
      .findOneAndUpdate({ _id: videoId, status: ReelStatus.HIDDEN }, update, {
        returnDocument: 'after',
      })
      .lean<ReelLean>()
      .exec();
    // Not hidden: already resolved, or a concurrent operator action decided it first. Never
    // double-fire.
    if (!updated) return 'not_hidden';
    return snapshotOf(updated);
  }

  /**
   * Explicit repost: always sets the relation. A duplicate insert (unique index) is caught and
   * treated as already-reposted, the same idempotency as the rest of this file's toggles.
   */
  async repostReel(
    id: string,
    viewerId: string,
  ): Promise<{ reposted: true } | 'self' | null> {
    const videoId = toObjectId(id);
    const userId = toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // Reposting is only possible on published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .select({ creatorId: 1 })
      .lean<{ creatorId: Types.ObjectId }>()
      .exec();
    if (!reel) return null;
    if (reel.creatorId.equals(userId)) return 'self';

    try {
      await this.repostModel.create({ reposterId: userId, videoId });
    } catch (error) {
      // Already reposted: an idempotent no-op.
      if (!isDuplicateKeyError(error)) throw error;
    }
    return { reposted: true };
  }

  async unrepostReel(
    id: string,
    viewerId: string,
  ): Promise<{ reposted: false } | null> {
    const videoId = toObjectId(id);
    const userId = toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // Not tied to publication status: an owner can always remove their own repost, even if the
    // source reel later left `published`.
    const exists = await this.reelModel.exists({ _id: videoId });
    if (!exists) return null;

    await this.repostModel.deleteOne({ reposterId: userId, videoId }).exec();
    return { reposted: false };
  }

  // ── Screening support ───────────────────────────────────────────────────

  private candidateOf(reel: ReelLean): ModerationCandidate {
    return {
      ...snapshotOf(reel),
      description: reel.description,
      mentions: reel.mentions.map((m) => ({
        userId: m.userId.toString(),
        username: m.username,
      })),
      createdAt: reel.createdAt ?? new Date(),
    };
  }

  async getModerationCandidate(
    id: string,
  ): Promise<ModerationCandidate | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    const reel = await this.reelModel
      .findById(objectId)
      .lean<ReelLean>()
      .exec();
    return reel ? this.candidateOf(reel) : null;
  }

  async publishPending(id: string): Promise<ModerationCandidate | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: objectId, status: ReelStatus.PENDING_MODERATION },
        { $set: { status: ReelStatus.PUBLISHED, publishedAt: new Date() } },
        { returnDocument: 'after' },
      )
      .lean<ReelLean>()
      .exec();
    return updated ? this.candidateOf(updated) : null;
  }

  async rejectPending(
    id: string,
    outcome: ModerationOutcome,
  ): Promise<ModerationCandidate | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: objectId, status: ReelStatus.PENDING_MODERATION },
        {
          $set: {
            status: ReelStatus.REJECTED,
            moderation: {
              verdict: outcome.verdict,
              flaggedSource: outcome.flaggedSource,
              categories: outcome.categories ?? [],
              providerRef: outcome.providerRef,
              completedAt: new Date(),
            },
          },
        },
        { returnDocument: 'after' },
      )
      .lean<ReelLean>()
      .exec();
    return updated ? this.candidateOf(updated) : null;
  }

  async findStalePendingIds(staleMs: number): Promise<string[]> {
    const stale = await this.reelModel
      .find({
        status: ReelStatus.PENDING_MODERATION,
        updatedAt: { $lt: new Date(Date.now() - staleMs) },
      })
      .select({ _id: 1 })
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return stale.map((doc) => doc._id.toString());
  }

  // ── Lifecycle support ───────────────────────────────────────────────────

  async getSnapshot(id: string): Promise<ReelSnapshot | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    const reel = await this.reelModel
      .findById(objectId)
      .select({ creatorId: 1, status: 1, media: 1, hashtagsNormalized: 1 })
      .lean<ReelLean>()
      .exec();
    return reel ? snapshotOf(reel) : null;
  }

  async setMediaLocation(
    id: string,
    location: 'private' | 'public',
  ): Promise<void> {
    const objectId = toObjectId(id);
    if (!objectId) return;
    await this.reelModel
      .updateOne({ _id: objectId }, { $set: { 'media.location': location } })
      .exec();
  }

  async listPublishedByCreator(
    creatorId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ReelSnapshot[]> {
    const creator = toObjectId(creatorId);
    if (!creator) return [];
    const after = afterId ? toObjectId(afterId) : null;
    const reels = await this.reelModel
      .find({
        creatorId: creator,
        status: ReelStatus.PUBLISHED,
        ...(after ? { _id: { $gt: after } } : {}),
      })
      .sort({ _id: 1 })
      .limit(limit)
      .select({ creatorId: 1, status: 1, media: 1, hashtagsNormalized: 1 })
      .lean<ReelLean[]>()
      .exec();
    return reels.map(snapshotOf);
  }
}
