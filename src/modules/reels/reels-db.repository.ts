import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ErrorCode } from '../../common/errors/error-codes';
import { isDuplicateKeyError } from '../../common/mongo/duplicate-key';
import { escapeRegex } from '../../common/text/escape-regex';
import { AccountsRepository } from '../accounts/accounts.repository';
import {
  decodeFeedCursor,
  decodeListCursor,
  encodeFeedCursor,
  FEED_TOP,
  MAX_INJECTED,
} from './feed/feed-cursor';
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
import {
  ReelProductTap,
  ReelProductTapDocument,
} from './schemas/reel-product-tap.schema';
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

/** A comment as shown to one viewer, with what that viewer may do with it. */
function commentDto(
  comment: {
    id: string;
    authorId: string;
    text: string;
    createdAt: Date | undefined;
    author: { name?: string; avatarUrl?: string | null } | undefined;
  },
  viewerId: string,
  reelCreatorId: string,
): CommentDto {
  const signedIn = viewerId !== '';
  const isAuthor = signedIn && comment.authorId === viewerId;
  return {
    id: comment.id,
    authorId: comment.authorId,
    authorName: comment.author?.name ?? 'Unknown',
    authorAvatarUrl: comment.author?.avatarUrl ?? null,
    text: comment.text,
    createdAt: iso(comment.createdAt),
    viewerCanDelete: isAuthor || (signedIn && reelCreatorId === viewerId),
    viewerCanReport: signedIn && !isAuthor,
  };
}

/** Where a reel sits in a newest-first list, for a cursor that continues after it. */
function positionOf(reel: ReelLean): { createdAt: Date; id: string } {
  return { createdAt: reel.createdAt ?? new Date(0), id: reel._id.toString() };
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
 * Cursors: the feeds (For You, creator, hashtag) use the keyset cursors of research R9, through
 * `feed-cursor.ts`. The other lists still use an opaque, ever-increasing integer offset encoded as
 * a string, and move to keyset paging story by story.
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
    @InjectModel(ReelProductTap.name)
    private readonly productTapModel: Model<ReelProductTapDocument>,
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
        'externalId',
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
        productLinks: [...(r.productLinks ?? [])]
          .sort((a, b) => a.position - b.position)
          .map((link) => ({
            productId: link.productId,
            position: link.position,
          })),
        creatorExternalId: creator?.externalId ?? 0,
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
   * The accounts whose reposts a viewer sees: the ones they follow, and themselves. Read fresh on
   * every request, so an unfollow removes a repost from the feed on the very next one. A signed-out
   * visitor has none.
   */
  private async repostSourceIds(
    viewerId: string,
    extra: string[] = [],
  ): Promise<Types.ObjectId[]> {
    const viewerObjectId = toObjectId(viewerId);
    if (!viewerObjectId) return [];
    const follows = await this.followModel
      .find({ followerId: viewerObjectId })
      .select({ followeeId: 1 })
      .lean<Array<{ followeeId: Types.ObjectId }>>()
      .exec();
    return toObjectIds([
      ...new Set([
        ...follows.map((f) => f.followeeId.toString()),
        viewerId,
        ...extra,
      ]),
    ]);
  }

  /**
   * The reels to put at the top of the first For You page (FR-017): published reels that someone
   * the viewer follows (or the viewer) reposted, most recently reposted first, from at most the
   * `MAX_INJECTED` latest reposts. A reposter the viewer blocked, and a reel whose creator is
   * excluded, never qualify (FR-078).
   */
  private async repostSeeds(
    sourceIds: Types.ObjectId[],
    excludeCreatorIds: string[],
    limit: number,
  ): Promise<ReelLean[]> {
    const excluded = new Set(excludeCreatorIds);
    const reposters = sourceIds.filter((id) => !excluded.has(id.toString()));
    if (reposters.length === 0) return [];

    const reposts = await this.repostModel
      .find({ reposterId: { $in: reposters } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_INJECTED)
      .select({ videoId: 1 })
      .lean<Array<{ videoId: Types.ObjectId }>>()
      .exec();
    const candidates = [...new Set(reposts.map((r) => r.videoId.toString()))];
    if (candidates.length === 0) return [];

    const reels = await this.reelModel
      .find({
        _id: { $in: toObjectIds(candidates) },
        status: ReelStatus.PUBLISHED,
        ...this.excludeFilter(excludeCreatorIds),
      })
      .lean<ReelLean[]>()
      .exec();
    const byId = new Map(reels.map((reel) => [reel._id.toString(), reel]));
    return candidates
      .map((id) => byId.get(id))
      .filter((reel): reel is ReelLean => reel !== undefined)
      .slice(0, limit);
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
    productIds?: number[];
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
      productLinks: (params.productIds ?? []).map((productId, position) => ({
        productId,
        position,
        tapsCount: 0,
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

  /**
   * The For You feed, or a creator or hashtag feed (research R9).
   *
   * The scoped feeds end. For You never does (FR-020): it is passed through the catalog newest
   * first, and when a pass runs out the page is filled from the top of the next one.
   */
  async listFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    creatorId?: string;
    hashtag?: string;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>> {
    return params.creatorId || params.hashtag
      ? this.listScopedFeed(params)
      : this.listForYou(params);
  }

  /**
   * `(createdAt, _id)` strictly before a position: the next page of a newest-first list. It is a
   * keyset condition, so it uses the `{status, createdAt, _id}` indexes at any depth.
   */
  private before(position: {
    createdAt: Date;
    id: string;
  }): Record<string, unknown> {
    return {
      $or: [
        { createdAt: { $lt: position.createdAt } },
        {
          createdAt: position.createdAt,
          _id: { $lt: new Types.ObjectId(position.id) },
        },
      ],
    };
  }

  /** A creator's reels or a hashtag's reels: finite, owners see their own in every state. */
  private async listScopedFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    creatorId?: string;
    hashtag?: string;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>> {
    // A bad cursor is the caller's mistake whatever the scope turns out to hold.
    const position = decodeListCursor(params.cursor);
    const empty: Page<ReelRecord> = { items: [], nextCursor: null };

    const scope: Record<string, unknown> = {};
    if (params.creatorId) {
      // A specific creator and the exclusion both target `creatorId` and cannot be merged: an
      // excluded creator's feed is simply empty.
      if (params.excludeCreatorIds.includes(params.creatorId)) return empty;
      const creatorObjectId = toObjectId(params.creatorId);
      if (!creatorObjectId) return empty;
      scope.creatorId = creatorObjectId;
    } else {
      Object.assign(scope, this.excludeFilter(params.excludeCreatorIds));
    }
    if (params.hashtag) scope.hashtagsNormalized = params.hashtag;

    const conditions: Record<string, unknown>[] = [
      scope,
      this.visibilityFilter(params.viewerId),
    ];
    if (position) conditions.push(this.before(position));

    // One more than the page, to know whether there is a next one without counting.
    const docs = await this.reelModel
      .find({ $and: conditions })
      .sort({ createdAt: -1, _id: -1 })
      .limit(params.limit + 1)
      .lean<ReelLean[]>()
      .exec();
    const page = docs.slice(0, params.limit);
    const last = page[page.length - 1];
    return {
      items: await this.hydrate(page, params.viewerId),
      nextCursor:
        docs.length > params.limit && last
          ? encodeFeedCursor({
              pass: 0,
              createdAt: last.createdAt ?? new Date(0),
              id: last._id.toString(),
            })
          : null,
    };
  }

  /**
   * For You: published reels, newest first, from creators the viewer may see (FR-017), looping
   * (FR-020).
   *
   * - The first page of the first pass opens with the reels that followed accounts reposted. Their
   *   ids travel in the cursor and are skipped for the rest of the pass, so each is shown once.
   * - A pass is the catalog from the top to the bottom. When it runs out, the page is topped up
   *   from the top of the next pass, skipping what the page already has.
   * - The only time the cursor is `null` is a catalog with nothing in it.
   */
  private async listForYou(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>> {
    const cursor =
      params.cursor === undefined ? undefined : decodeFeedCursor(params.cursor);
    const published: Record<string, unknown> = {
      status: ReelStatus.PUBLISHED,
      ...this.excludeFilter(params.excludeCreatorIds),
    };
    const sourceIds = await this.repostSourceIds(params.viewerId);

    let pass = cursor?.pass ?? 0;
    let injected = cursor?.injected ?? [];
    let position = cursor
      ? { createdAt: cursor.createdAt, id: cursor.id }
      : FEED_TOP;

    const items: ReelLean[] = [];
    if (!cursor) {
      const seeds = await this.repostSeeds(
        sourceIds,
        params.excludeCreatorIds,
        params.limit,
      );
      items.push(...seeds);
      injected = seeds.map((seed) => seed._id.toString());
    }

    // `limit(0)` means "no limit" to MongoDB, so a page already full of seeds must not ask.
    const find = (
      condition: Record<string, unknown>,
      take: number,
    ): Promise<ReelLean[]> =>
      take > 0
        ? this.reelModel
            .find({ $and: [published, condition] })
            .sort({ createdAt: -1, _id: -1 })
            .limit(take)
            .lean<ReelLean[]>()
            .exec()
        : Promise.resolve([]);
    const skip = (): Types.ObjectId[] =>
      toObjectIds([
        ...items.map((item) => item._id.toString()),
        ...(pass === 0 ? injected : []),
      ]);

    // The rest of the current pass, after the cursor.
    const rest = await find(
      { ...this.before(position), _id: { $nin: skip() } },
      params.limit - items.length,
    );
    items.push(...rest);
    if (rest.length > 0) position = positionOf(rest[rest.length - 1]);

    // The pass ran out: carry on from the top of the next one.
    if (items.length < params.limit) {
      pass += 1;
      injected = [];
      position = FEED_TOP;
      const wrapped = await find(
        { _id: { $nin: skip() } },
        params.limit - items.length,
      );
      items.push(...wrapped);
      if (wrapped.length > 0)
        position = positionOf(wrapped[wrapped.length - 1]);
    }

    if (items.length === 0) return { items: [], nextCursor: null };

    const records = await this.hydrate(items, params.viewerId);
    const reposters = await this.getRelevantRepostersForVideos(
      records.map((record) => record.id),
      sourceIds,
      params.excludeCreatorIds,
    );
    for (const record of records) {
      const list = reposters.get(record.id);
      if (!list || list.length === 0) continue;
      record.repostedBy = list[0];
      record.repostersCount = list.length;
      record.topReposters = list.slice(0, 3);
    }
    return {
      items: records,
      nextCursor: encodeFeedCursor({
        pass,
        ...position,
        injected: pass === 0 ? injected : [],
      }),
    };
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
    params: {
      viewerId: string;
      cursor?: string;
      limit: number;
      excludeAuthorIds: string[];
    },
  ): Promise<{
    items: CommentDto[];
    nextCursor: string | null;
    commentsCount: number;
  } | null> {
    const position = decodeListCursor(params.cursor);
    const videoId = toObjectId(id);
    if (!videoId) return null;
    // A non-published reel has no comments to serve.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .select({ commentsCount: 1, creatorId: 1 })
      .lean<{ commentsCount: number; creatorId: Types.ObjectId }>()
      .exec();
    if (!reel) return null;

    const conditions: Record<string, unknown>[] = [
      { videoId, deletedAt: null },
    ];
    if (params.excludeAuthorIds.length > 0) {
      conditions.push({
        authorId: { $nin: toObjectIds(params.excludeAuthorIds) },
      });
    }
    if (position) conditions.push(this.before(position));

    const docs = await this.commentModel
      .find({ $and: conditions })
      .sort({ createdAt: -1, _id: -1 })
      .limit(params.limit + 1)
      .lean<
        Array<{
          _id: Types.ObjectId;
          authorId: Types.ObjectId;
          text: string;
          createdAt?: Date;
        }>
      >()
      .exec();
    const page = docs.slice(0, params.limit);
    const last = page[page.length - 1];

    const authors = await this.accounts.findByIdsLean(
      [...new Set(page.map((d) => d.authorId.toString()))],
      ['name', 'avatarUrl'],
    );
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));
    const reelCreatorId = reel.creatorId.toString();

    return {
      items: page.map((c) => {
        const author = authorById.get(c.authorId.toString());
        return commentDto(
          {
            id: c._id.toString(),
            authorId: c.authorId.toString(),
            text: c.text,
            createdAt: c.createdAt,
            author,
          },
          params.viewerId,
          reelCreatorId,
        );
      }),
      nextCursor:
        docs.length > params.limit && last
          ? encodeFeedCursor({
              pass: 0,
              createdAt: last.createdAt ?? new Date(0),
              id: last._id.toString(),
            })
          : null,
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
      .select({ commentsCount: 1, creatorId: 1 })
      .lean<{ commentsCount: number; creatorId: Types.ObjectId }>()
      .exec();
    const [author] = await this.accounts.findByIdsLean(
      [viewerId],
      ['name', 'avatarUrl'],
    );

    return {
      comment: commentDto(
        {
          id: created._id.toString(),
          authorId: viewerId,
          text: created.text,
          createdAt: created.createdAt,
          author,
        },
        viewerId,
        updated?.creatorId.toString() ?? '',
      ),
      commentsCount: updated?.commentsCount ?? 0,
    };
  }

  async setProductLinks(reelId: string, productIds: number[]): Promise<void> {
    const videoId = toObjectId(reelId);
    if (!videoId) return;
    const current = await this.reelModel
      .findById(videoId)
      .select({ productLinks: 1 })
      .lean<{
        productLinks?: Array<{ productId: number; tapsCount: number }>;
      }>()
      .exec();
    // A product that stays linked keeps the taps it has earned (FR-038).
    const taps = new Map(
      (current?.productLinks ?? []).map((link) => [
        link.productId,
        link.tapsCount,
      ]),
    );
    await this.reelModel
      .updateOne(
        { _id: videoId },
        {
          $set: {
            productLinks: productIds.map((productId, position) => ({
              productId,
              position,
              tapsCount: taps.get(productId) ?? 0,
            })),
          },
        },
      )
      .exec();
  }

  async recordProductTap(params: {
    reelId: string;
    productId: number;
    viewerId: string;
    installationId?: string;
    excludeCreatorIds: string[];
  }): Promise<'recorded' | 'not_linked' | null> {
    const videoId = toObjectId(params.reelId);
    if (!videoId) return null;
    const reel = await this.reelModel
      .findOne({
        _id: videoId,
        status: ReelStatus.PUBLISHED,
        ...this.excludeFilter(params.excludeCreatorIds),
      })
      .select({ productLinks: 1 })
      .lean<{ productLinks?: Array<{ productId: number }> }>()
      .exec();
    if (!reel) return null;
    if (
      !(reel.productLinks ?? []).some((l) => l.productId === params.productId)
    ) {
      return 'not_linked';
    }

    await this.productTapModel.create({
      videoId,
      productId: params.productId,
      viewerId: toObjectId(params.viewerId),
      installationId: params.installationId ?? null,
    });
    await this.reelModel
      .updateOne(
        { _id: videoId, 'productLinks.productId': params.productId },
        { $inc: { 'productLinks.$.tapsCount': 1 } },
      )
      .exec();
    return 'recorded';
  }

  async adjustCommentsCount(id: string, delta: number): Promise<void> {
    const videoId = toObjectId(id);
    if (!videoId || delta === 0) return;
    await this.reelModel
      .updateOne(
        // A decrement never takes the stored count below zero.
        delta < 0
          ? { _id: videoId, commentsCount: { $gt: 0 } }
          : { _id: videoId },
        { $inc: { commentsCount: delta } },
      )
      .exec();
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
    const position = decodeListCursor(params.cursor);
    const userId = toObjectId(viewerId);
    if (!userId) return { items: [], nextCursor: null };

    // One more than the page, to know whether there is a next one without counting.
    const relations = await relationModel
      .find(
        position ? { $and: [{ userId }, this.before(position)] } : { userId },
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(params.limit + 1)
      .lean<
        Array<{
          _id: Types.ObjectId;
          videoId: Types.ObjectId;
          createdAt?: Date;
        }>
      >()
      .exec();
    const page = relations.slice(0, params.limit);
    const last = page[page.length - 1];
    const ordered = await this.reelsInOrder(
      page.map((r) => r.videoId),
      viewerId,
      params.excludeCreatorIds,
    );

    return {
      items: await this.hydrate(ordered, viewerId),
      nextCursor:
        relations.length > params.limit && last
          ? encodeFeedCursor({
              pass: 0,
              createdAt: last.createdAt ?? new Date(0),
              id: last._id.toString(),
            })
          : null,
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
    const ownerReposter: AccountSummary = owner
      ? summaryOf(owner)
      : { id: targetUserId, username: '', name: '', avatarUrl: null };
    const relevant = await this.getRelevantRepostersForVideos(
      items.map((item) => item.id),
      await this.repostSourceIds(viewerId, [targetUserId]),
      params.excludeCreatorIds,
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
   * For a set of videos, the reposters among `sourceIds` (the accounts the viewer follows, the
   * viewer, and any the caller adds), each video's list most-recent-first and block-filtered.
   * Powers the multi-reposter badge on the For You feed and on the profile Reposts list.
   */
  private async getRelevantRepostersForVideos(
    videoIds: string[],
    sourceIds: Types.ObjectId[],
    excludeCreatorIds: string[],
  ): Promise<Map<string, AccountSummary[]>> {
    const videoObjectIds = toObjectIds(videoIds);
    if (sourceIds.length === 0 || videoObjectIds.length === 0) return new Map();

    const reposts = await this.repostModel
      .find({
        videoId: { $in: videoObjectIds },
        reposterId: { $in: sourceIds },
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

    const byVideo = new Map<string, AccountSummary[]>();
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
      this.productTapModel.deleteMany({ videoId }).exec(),
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
