import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Reel, ReelDocument, ReelStatus } from './schemas/reel.schema';
import {
  ReelReport,
  ReelReportDocument,
  ReelReportReason,
} from './schemas/reel-report.schema';
import { ReelRepost, ReelRepostDocument } from './schemas/reel-repost.schema';
import {
  NotificationEvent,
  NotificationEventDocument,
} from './schemas/notification-event.schema';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { ReelLike, ReelLikeDocument } from './schemas/reel-like.schema';
import { ReelSave, ReelSaveDocument } from './schemas/reel-save.schema';
import { ReelView, ReelViewDocument } from './schemas/reel-view.schema';
import { ReelShare, ReelShareDocument } from './schemas/reel-share.schema';
import {
  ReelComment,
  ReelCommentDocument,
} from './schemas/reel-comment.schema';
import { Follow, FollowDocument } from './schemas/follow.schema';
import {
  AdminHiddenReelDto,
  CommentDto,
  CreatorProfileDto,
  FollowedUserDto,
  ReelDto,
  ReelReportReasonValue,
  ReelsRepository,
  ReelVideoRecord,
  UserSearchResultDto,
} from './reels.repository';

/** v6: one viewer-relevant reposter (followed ∪ self) for the badge stack. */
interface RepostReposter {
  id: string;
  username: string;
  name: string;
  avatarUrl: string;
}

/** v6: per-video repost attribution — primary label + avatar stack + count. */
interface RepostAttribution {
  primary: RepostReposter;
  top: RepostReposter[];
  count: number;
}

/**
 * Mongoose-backed `ReelsRepository` (v2 — replaces `ReelsMockStore`).
 *
 * Cursor convention (unchanged from v1 mock): an opaque, ever-increasing
 * integer offset encoded as a string. The main feed wraps the offset modulo
 * the catalog size so `nextCursor` is never null (FR-007); scoped
 * feeds/lists (creator, hashtag, liked, saved, search) are finite and stop
 * once the offset reaches the filtered count.
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
    @InjectModel(ReelShare.name)
    private readonly shareModel: Model<ReelShareDocument>,
    @InjectModel(ReelComment.name)
    private readonly commentModel: Model<ReelCommentDocument>,
    @InjectModel(Follow.name)
    private readonly followModel: Model<FollowDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(NotificationEvent.name)
    private readonly notificationEventModel: Model<NotificationEventDocument>,
    @InjectModel(ReelReport.name)
    private readonly reportModel: Model<ReelReportDocument>,
    @InjectModel(ReelRepost.name)
    private readonly repostModel: Model<ReelRepostDocument>,
    private readonly configService: ConfigService,
  ) {}

  // ── Id helpers ─────────────────────────────────────────────────────────

  private toObjectId(id: string): Types.ObjectId | null {
    if (!Types.ObjectId.isValid(id)) return null;
    return new Types.ObjectId(id);
  }

  private parseCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException('Invalid cursor');
    }
    return parsed;
  }

  // ── Hydration (raw docs -> ReelDto, batched to avoid N+1) ───────────────

  private async hydrate(
    reels: ReelDocument[],
    viewerId: string,
  ): Promise<ReelDto[]> {
    if (reels.length === 0) return [];
    const viewerObjectId = this.toObjectId(viewerId);
    const creatorIds = [...new Set(reels.map((r) => r.creatorId.toString()))];
    const videoIds = reels.map((r) => r._id);

    const [creators, followed, liked, saved, reposted] = await Promise.all([
      this.userModel
        .find({ _id: { $in: creatorIds.map((id) => new Types.ObjectId(id)) } })
        .select('_id name username avatarUrl')
        .lean()
        .exec(),
      viewerObjectId
        ? this.followModel
            .find({
              followerId: viewerObjectId,
              followeeId: {
                $in: creatorIds.map((id) => new Types.ObjectId(id)),
              },
            })
            .lean()
            .exec()
        : [],
      viewerObjectId
        ? this.likeModel
            .find({ userId: viewerObjectId, videoId: { $in: videoIds } })
            .lean()
            .exec()
        : [],
      viewerObjectId
        ? this.saveModel
            .find({ userId: viewerObjectId, videoId: { $in: videoIds } })
            .lean()
            .exec()
        : [],
      // v4 (FR-073): whether the CALLER reposted this reel (drives the
      // action-column button's active state) — independent of whether the
      // item is a For You repost-injected copy (that's `repostedBy` below).
      viewerObjectId
        ? this.repostModel
            .find({ reposterId: viewerObjectId, videoId: { $in: videoIds } })
            .lean()
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
      return {
        id: r._id.toString(),
        videoUrl: r.videoUrl,
        thumbnailUrl: r.thumbnailUrl,
        createdAt: (r.createdAt as Date).toISOString(),
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
          avatarUrl: creator?.avatarUrl ?? '',
          viewerFollowing: followedSet.has(r.creatorId.toString()),
        },
        status: r.status,
        viewsCount: r.viewsCount,
        likesCount: r.likesCount,
        commentsCount: r.commentsCount,
        sharesCount: r.sharesCount,
        viewerLiked: likedSet.has(r._id.toString()),
        viewerSaved: savedSet.has(r._id.toString()),
        // v4: default null — the For You merge (listFeed) overwrites this
        // on its repost-injected items only; every other path (including
        // the Following feed) always serves organic items.
        repostedBy: null,
        // v6: viewer-relevant reposters (followed ∪ self) — count + a few
        // avatars for the badge stack; overwritten on the For You + profile
        // reposts-list paths, 0/[] everywhere else.
        repostersCount: 0,
        topReposters: [],
        viewerReposted: repostedSet.has(r._id.toString()),
      };
    });
  }

  private toRecord(r: ReelDocument): ReelVideoRecord {
    return {
      id: r._id.toString(),
      creatorId: r.creatorId.toString(),
      videoUrl: r.videoUrl,
      thumbnailUrl: r.thumbnailUrl,
      description: r.description,
      hashtags: r.hashtags,
      mentions: r.mentions.map((m) => ({
        userId: m.userId.toString(),
        username: m.username,
      })),
      createdAt: (r.createdAt as Date).toISOString(),
    };
  }

  private excludeFilter(excludeCreatorIds: string[]) {
    if (excludeCreatorIds.length === 0) return {};
    return {
      creatorId: {
        $nin: excludeCreatorIds
          .map((id) => this.toObjectId(id))
          .filter((id): id is Types.ObjectId => id !== null),
      },
    };
  }

  /**
   * v3 (FR-061): composes with every other read filter via plain object
   * merge — MongoDB ANDs sibling top-level keys, so this narrows any query
   * to "published, OR mine" regardless of what else the caller filters on.
   * Applied to every read path (data-model.md v3 "Visibility & block
   * filtering" — never enforced client-side).
   */
  private visibilityFilter(viewerId: string): Record<string, unknown> {
    const viewerObjectId = this.toObjectId(viewerId);
    if (!viewerObjectId) return { status: ReelStatus.PUBLISHED };
    return {
      $or: [{ status: ReelStatus.PUBLISHED }, { creatorId: viewerObjectId }],
    };
  }

  /**
   * v4 (FR-076, R20): reels reposted by users the viewer follows (or the
   * viewer themselves), attributed to the MOST RECENT qualifying reposter
   * per reel. Reposter-edge blocks are applied here (FR-078) — independent
   * of the creator-edge `excludeCreatorIds` filter the caller also applies.
   * "Still followed" is implicit: `followeeIds` is read fresh on every
   * call, so an unfollow removes the injection on the very next request.
   */
  private async getRepostAttributions(
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<Map<string, RepostAttribution>> {
    const viewerObjectId = this.toObjectId(viewerId);
    if (!viewerObjectId) return new Map();

    const follows = await this.followModel
      .find({ followerId: viewerObjectId })
      .select('followeeId')
      .lean()
      .exec();
    const reposterIds = [
      ...new Set([
        ...follows.map((f) => f.followeeId.toString()),
        viewerId,
      ]),
    ]
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);
    if (reposterIds.length === 0) return new Map();

    const reposts = await this.repostModel
      .find({ reposterId: { $in: reposterIds } })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    if (reposts.length === 0) return new Map();

    // Most-recent-first order already sorted above; collect ALL relevant
    // reposters per videoId (v6 — the badge shows a count + a few avatars),
    // preserving recency order.
    const repostsByVideo = new Map<string, (typeof reposts)[number][]>();
    for (const r of reposts) {
      const key = r.videoId.toString();
      const list = repostsByVideo.get(key);
      if (list) {
        list.push(r);
      } else {
        repostsByVideo.set(key, [r]);
      }
    }

    const videoIds = [...repostsByVideo.keys()].map((id) => this.toObjectId(id));
    const reposterIdsNeeded = [
      ...new Set(reposts.map((r) => r.reposterId.toString())),
    ].map((id) => this.toObjectId(id));

    const [reels, reposterUsers] = await Promise.all([
      this.reelModel
        .find({
          _id: { $in: videoIds },
          ...this.excludeFilter(excludeCreatorIds),
          status: ReelStatus.PUBLISHED,
        })
        .select('_id')
        .lean()
        .exec(),
      this.userModel
        .find({ _id: { $in: reposterIdsNeeded } })
        .select('_id username name avatarUrl')
        .lean()
        .exec(),
    ]);
    const visibleVideoIds = new Set(reels.map((r) => r._id.toString()));
    const excludeReposterSet = new Set(excludeCreatorIds);
    const reposterById = new Map(reposterUsers.map((u) => [u._id.toString(), u]));

    const attributions = new Map<string, RepostAttribution>();
    for (const [videoId, list] of repostsByVideo) {
      if (!visibleVideoIds.has(videoId)) continue; // source no longer published/blocked
      const relevant: RepostReposter[] = [];
      for (const repost of list) {
        const reposterId = repost.reposterId.toString();
        if (excludeReposterSet.has(reposterId)) continue; // FR-078 reposter-edge block
        const reposter = reposterById.get(reposterId);
        if (!reposter) continue;
        relevant.push({
          id: reposterId,
          username: reposter.username ?? '',
          name: reposter.name,
          avatarUrl: reposter.avatarUrl ?? '',
        });
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

  // ── ReelsRepository ────────────────────────────────────────────────────

  async createReel(params: {
    creatorId: string;
    videoUrl: string;
    thumbnailUrl: string;
    description: string;
    hashtags: string[];
    mentions: { userId: string; username: string }[];
  }): Promise<ReelDto> {
    const doc = await this.reelModel.create({
      creatorId: new Types.ObjectId(params.creatorId),
      videoUrl: params.videoUrl,
      thumbnailUrl: params.thumbnailUrl,
      description: params.description,
      hashtags: params.hashtags,
      mentions: params.mentions.map((m) => ({
        userId: new Types.ObjectId(m.userId),
        username: m.username,
      })),
      status: ReelStatus.PENDING_MODERATION,
    });
    const [hydrated] = await this.hydrate([doc], params.creatorId);
    return hydrated;
  }

  async listFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    creatorId?: string;
    hashtag?: string;
    excludeCreatorIds: string[];
  }): Promise<{ items: ReelDto[]; nextCursor: string | null }> {
    const offset = this.parseCursor(params.cursor);
    const filter: Record<string, unknown> = {};

    if (params.creatorId) {
      // A specific creatorId and the $nin exclusion both target the same
      // field — they can't be merged. If the requested creator is blocked,
      // the scoped feed is simply empty (FR-053); otherwise filter by the
      // exact id (no need for $nin against a single already-known-safe id).
      if (params.excludeCreatorIds.includes(params.creatorId)) {
        return { items: [], nextCursor: null };
      }
      const creatorObjectId = this.toObjectId(params.creatorId);
      if (!creatorObjectId) return { items: [], nextCursor: null };
      filter.creatorId = creatorObjectId;
    } else {
      Object.assign(filter, this.excludeFilter(params.excludeCreatorIds));
    }
    if (params.hashtag) {
      filter.hashtags = params.hashtag.toLowerCase();
    }
    // v3 (FR-061): published, or mine — composes with whichever of the
    // filters above are already set.
    Object.assign(filter, this.visibilityFilter(params.viewerId));

    const isScoped = Boolean(params.creatorId || params.hashtag);
    const total = await this.reelModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };

    if (isScoped) {
      // Finite: creator-scoped and hashtag-scoped feeds terminate (FR-007 clarification, FR-047a).
      const docs = await this.reelModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(offset)
        .limit(params.limit)
        .exec();
      const nextOffset = offset + params.limit;
      return {
        items: await this.hydrate(docs, params.viewerId),
        nextCursor: nextOffset < total ? String(nextOffset) : null,
      };
    }

    // Main feed loops the catalog indefinitely — nextCursor is never null (FR-007).
    const sorted = await this.reelModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .exec();

    // v4 (FR-076): this IS the For You feed — merge in followees' (+ the
    // viewer's own) reposts. Scoped feeds (creatorId/hashtag) never reach
    // this branch, matching FR-075's "Following has no reposts" rule and
    // FR-026/FR-047a's existing creator/hashtag-scoped semantics.
    const attributions = await this.getRepostAttributions(
      params.viewerId,
      params.excludeCreatorIds,
    );

    const docs: ReelDocument[] = [];
    const byId = new Map(sorted.map((d) => [d._id.toString(), d]));
    if (offset === 0 && attributions.size > 0) {
      // R20: reposts are surfaced with priority on the very first page —
      // the simplest faithful reading of "distribution to followers" for a
      // catalog small enough that natural rotation would otherwise bury
      // them. Any residual duplicate on a later loop cycle is absorbed by
      // the client-side pagination dedup (ReelsFeedBloc, T158).
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
    // Attach repost attribution to whichever page items carry one (the
    // prepended ones on page 0, or any natural-rotation item on later
    // pages/loop cycles that matches). v6: also the count + avatar stack.
    for (const item of items) {
      const attribution = attributions.get(item.id);
      if (attribution) {
        item.repostedBy = attribution.primary;
        item.repostersCount = attribution.count;
        item.topReposters = attribution.top;
      }
    }

    return {
      items,
      nextCursor: String(offset + params.limit),
    };
  }

  /**
   * v4 (FR-075): originals only, from users the viewer follows. Blocked
   * followees are filtered out of the id list up front (rather than
   * combining `$in`/`$nin` on the same `creatorId` field, which Mongo
   * can't merge via plain-object `Object.assign`).
   */
  async listFollowingFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<{ items: ReelDto[]; nextCursor: string | null }> {
    const viewerObjectId = this.toObjectId(params.viewerId);
    if (!viewerObjectId) return { items: [], nextCursor: null };

    const follows = await this.followModel
      .find({ followerId: viewerObjectId })
      .select('followeeId')
      .lean()
      .exec();
    const excludeSet = new Set(params.excludeCreatorIds);
    const followeeIds = follows
      .map((f) => f.followeeId.toString())
      .filter((id) => !excludeSet.has(id))
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);
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
  ): Promise<ReelDto | null> {
    const objectId = this.toObjectId(id);
    if (!objectId) return null;
    const doc = await this.reelModel
      .findOne({
        _id: objectId,
        ...this.excludeFilter(excludeCreatorIds),
        ...this.visibilityFilter(viewerId),
      })
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
    reel: ReelVideoRecord;
  } | null> {
    const videoId = this.toObjectId(id);
    const userId = this.toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // v3 (FR-064): engagement is only possible on published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;

    const existing = await this.likeModel
      .findOneAndDelete({ userId, videoId })
      .exec();

    let liked: boolean;
    if (existing) {
      liked = false;
      reel.likesCount = Math.max(0, reel.likesCount - 1);
      await this.userModel
        .updateOne({ _id: reel.creatorId }, { $inc: { totalLikes: -1 } })
        .exec();
    } else {
      try {
        await this.likeModel.create({ userId, videoId });
        liked = true;
        reel.likesCount += 1;
        await this.userModel
          .updateOne({ _id: reel.creatorId }, { $inc: { totalLikes: 1 } })
          .exec();
      } catch {
        // Duplicate-key race (rapid double-tap) — another request already
        // inserted the like; treat as already-liked, no double count.
        liked = true;
      }
    }
    await reel.save();

    return {
      liked,
      likesCount: reel.likesCount,
      reel: this.toRecord(reel),
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
    const videoId = this.toObjectId(id);
    if (!videoId) return null;
    // v3 (FR-064): a non-published reel has no comments — nothing to serve.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;

    const offset = this.parseCursor(params.cursor);
    const filter: Record<string, unknown> = { videoId };
    if (params.excludeAuthorIds.length > 0) {
      filter.authorId = {
        $nin: params.excludeAuthorIds
          .map((aid) => this.toObjectId(aid))
          .filter((aid): aid is Types.ObjectId => aid !== null),
      };
    }
    const total = await this.commentModel.countDocuments(filter).exec();
    const docs = await this.commentModel
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .exec();

    const authorIds = [...new Set(docs.map((d) => d.authorId.toString()))];
    const authors = await this.userModel
      .find({ _id: { $in: authorIds.map((aid) => new Types.ObjectId(aid)) } })
      .select('_id name avatarUrl')
      .lean()
      .exec();
    const authorById = new Map(authors.map((a) => [a._id.toString(), a]));

    const nextOffset = offset + params.limit;
    return {
      items: docs.map((c) => {
        const author = authorById.get(c.authorId.toString());
        return {
          id: c._id.toString(),
          authorId: c.authorId.toString(),
          authorName: author?.name ?? 'Unknown',
          authorAvatarUrl: author?.avatarUrl ?? '',
          text: c.text,
          createdAt: (c.createdAt as Date).toISOString(),
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
    const videoId = this.toObjectId(id);
    const authorId = this.toObjectId(viewerId);
    if (!videoId || !authorId) return null;
    // v3 (FR-064): no engagement on non-published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;

    const created = await this.commentModel.create({ videoId, authorId, text });
    reel.commentsCount += 1;
    await reel.save();

    const author = await this.userModel
      .findById(authorId)
      .select('name avatarUrl')
      .lean()
      .exec();

    return {
      comment: {
        id: created._id.toString(),
        authorId: viewerId,
        authorName: author?.name ?? 'Unknown',
        authorAvatarUrl: author?.avatarUrl ?? '',
        text: created.text,
        createdAt: (created.createdAt as Date).toISOString(),
      },
      commentsCount: reel.commentsCount,
    };
  }

  async recordShare(
    id: string,
    viewerId: string,
  ): Promise<{ sharesCount: number } | null> {
    const videoId = this.toObjectId(id);
    const userId = this.toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // v3 (FR-064): no engagement on non-published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;

    await this.shareModel.create({ userId, videoId });
    reel.sharesCount += 1;
    await reel.save();
    return { sharesCount: reel.sharesCount };
  }

  async getProfile(
    userId: string,
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<CreatorProfileDto | null> {
    const targetId = this.toObjectId(userId);
    if (!targetId) return null;
    if (excludeCreatorIds.includes(userId)) return null;

    const user = await this.userModel.findById(targetId).exec();
    if (!user) return null;

    const viewerObjectId = this.toObjectId(viewerId);
    const isSelf = userId === viewerId;
    // v3 (FR-061/FR-065): others see only published videos in the grid;
    // the owner sees their own reels in every status (Processing/Removed
    // badges are rendered client-side from the `status` field below).
    const videos = await this.reelModel
      .find({
        creatorId: targetId,
        ...(isSelf ? {} : { status: ReelStatus.PUBLISHED }),
      })
      .sort({ createdAt: -1, _id: -1 })
      .select('_id thumbnailUrl status')
      .lean()
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
        id: user._id.toString(),
        name: user.name,
        username: user.username ?? '',
        avatarUrl: user.avatarUrl ?? '',
        bio: user.bio ?? '',
      },
      stats: {
        followers: user.followersCount,
        following: user.followingCount,
        totalLikes: user.totalLikes,
      },
      videos: videos.map((v) => ({
        id: v._id.toString(),
        thumbnailUrl: v.thumbnailUrl,
        status: v.status,
      })),
      viewer: {
        following: isFollowing,
        isSelf,
      },
    };
  }

  async toggleFollow(
    userId: string,
    viewerId: string,
  ): Promise<{ following: boolean; followersCount: number } | 'self' | null> {
    if (userId === viewerId) return 'self';
    const followeeId = this.toObjectId(userId);
    const followerId = this.toObjectId(viewerId);
    if (!followeeId || !followerId) return null;
    const followee = await this.userModel.findById(followeeId).exec();
    if (!followee) return null;

    const existing = await this.followModel
      .findOneAndDelete({ followerId, followeeId })
      .exec();

    let following: boolean;
    if (existing) {
      following = false;
      await this.userModel
        .updateOne({ _id: followeeId }, { $inc: { followersCount: -1 } })
        .exec();
      await this.userModel
        .updateOne({ _id: followerId }, { $inc: { followingCount: -1 } })
        .exec();
      followee.followersCount = Math.max(0, followee.followersCount - 1);
    } else {
      try {
        await this.followModel.create({ followerId, followeeId });
        following = true;
        await this.userModel
          .updateOne({ _id: followeeId }, { $inc: { followersCount: 1 } })
          .exec();
        await this.userModel
          .updateOne({ _id: followerId }, { $inc: { followingCount: 1 } })
          .exec();
        followee.followersCount += 1;
      } catch {
        following = true;
      }
    }

    return { following, followersCount: followee.followersCount };
  }

  async recordView(
    id: string,
    viewerId: string,
  ): Promise<{ viewsCount: number } | null> {
    const videoId = this.toObjectId(id);
    const userId = this.toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // v3 (FR-064): no engagement on non-published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;

    try {
      await this.viewModel.create({ userId, videoId });
      reel.viewsCount += 1;
      await reel.save();
    } catch {
      // Duplicate-key: already viewed by this user — no increment (FR-048 dedup).
    }
    return { viewsCount: reel.viewsCount };
  }

  async toggleSave(
    id: string,
    viewerId: string,
  ): Promise<{ saved: boolean } | null> {
    const videoId = this.toObjectId(id);
    const userId = this.toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // v3 (FR-064): no engagement on non-published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;

    const existing = await this.saveModel
      .findOneAndDelete({ userId, videoId })
      .exec();
    if (existing) return { saved: false };

    try {
      await this.saveModel.create({ userId, videoId });
      return { saved: true };
    } catch {
      return { saved: true };
    }
  }

  async listLiked(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<{ items: ReelDto[]; nextCursor: string | null }> {
    return this.listByRelation(this.likeModel, viewerId, params);
  }

  async listSaved(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<{ items: ReelDto[]; nextCursor: string | null }> {
    return this.listByRelation(this.saveModel, viewerId, params);
  }

  /** Shared implementation for listLiked/listSaved: relation-recency order, hydrated, block-filtered. */
  private async listByRelation(
    relationModel: Model<ReelLikeDocument> | Model<ReelSaveDocument>,
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<{ items: ReelDto[]; nextCursor: string | null }> {
    const userId = this.toObjectId(viewerId);
    if (!userId) return { items: [], nextCursor: null };
    const offset = this.parseCursor(params.cursor);

    const total = await relationModel.countDocuments({ userId }).exec();
    if (total === 0) return { items: [], nextCursor: null };

    const relations = await relationModel
      .find({ userId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean()
      .exec();
    const videoIds = relations.map((r) => r.videoId);
    // v3 defense-in-depth: likes/saves can only be recorded on published
    // reels going forward (FR-064), but this keeps historical/edge-case
    // relations from ever surfacing a non-published reel.
    const reels = await this.reelModel
      .find({
        _id: { $in: videoIds },
        ...this.excludeFilter(params.excludeCreatorIds),
        ...this.visibilityFilter(viewerId),
      })
      .exec();
    const reelById = new Map<string, ReelDocument>(
      reels.map((r) => [r._id.toString(), r as unknown as ReelDocument]),
    );
    // Preserve relation-recency order; drop any reel excluded by the block filter.
    const ordered = videoIds
      .map((id) => reelById.get(id.toString()))
      .filter((r) => r !== undefined);

    const nextOffset = offset + params.limit;
    return {
      items: await this.hydrate(ordered, viewerId),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * v6: [targetUserId]'s reposts, newest-repost-first (public tab). Rides the
   * existing `reel_reposts` `{reposterId, createdAt}` index. Block + published
   * visibility is filtered for [viewerId]; a reposted reel that has since left
   * the published state (hidden/rejected/deleted) drops out via the standard
   * `visibilityFilter`. Mirrors `listByRelation` but keys on `reposterId` and
   * targets an arbitrary user rather than the caller.
   */
  async listReposted(
    viewerId: string,
    targetUserId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<{ items: ReelDto[]; nextCursor: string | null }> {
    const reposterId = this.toObjectId(targetUserId);
    if (!reposterId) return { items: [], nextCursor: null };
    const offset = this.parseCursor(params.cursor);

    const total = await this.repostModel.countDocuments({ reposterId }).exec();
    if (total === 0) return { items: [], nextCursor: null };

    const relations = await this.repostModel
      .find({ reposterId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .lean()
      .exec();
    const videoIds = relations.map((r) => r.videoId);
    const reels = await this.reelModel
      .find({
        _id: { $in: videoIds },
        ...this.excludeFilter(params.excludeCreatorIds),
        ...this.visibilityFilter(viewerId),
      })
      .exec();
    const reelById = new Map<string, ReelDocument>(
      reels.map((r) => [r._id.toString(), r as unknown as ReelDocument]),
    );
    // Preserve repost-recency order; drop any reel filtered out above.
    const ordered = videoIds
      .map((id) => reelById.get(id.toString()))
      .filter((r): r is ReelDocument => r !== undefined);

    const items = await this.hydrate(ordered, viewerId);

    // v6: every item here was reposted BY the target user (always the primary
    // attribution / "[name] reposted"), but the badge also counts the OTHER
    // viewer-relevant reposters (people the viewer follows, ∪ self) of the
    // same video — so it matches the For You "N reposted" stack everywhere.
    const ownerUser = await this.userModel
      .findById(reposterId)
      .select('username name avatarUrl')
      .lean()
      .exec();
    const ownerReposter: RepostReposter = {
      id: targetUserId,
      username: ownerUser?.username ?? '',
      name: ownerUser?.name ?? '',
      avatarUrl: ownerUser?.avatarUrl ?? '',
    };
    const relevant = await this.getRelevantRepostersForVideos(
      viewerId,
      items.map((i) => i.id),
      params.excludeCreatorIds,
      targetUserId,
    );
    for (const item of items) {
      const others = (relevant.get(item.id) ?? []).filter((r) => r.id !== targetUserId);
      const ordered2 = [ownerReposter, ...others];
      item.repostedBy = ownerReposter;
      item.repostersCount = ordered2.length;
      item.topReposters = ordered2.slice(0, 3);
    }

    const nextOffset = offset + params.limit;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * v6: for a specific set of [videoIds], the reposters relevant to the viewer
   * — people the viewer follows, ∪ the viewer, ∪ [alwaysIncludeUserId] — each
   * video's list most-recent-first, reposter-edge block-filtered. Powers the
   * multi-reposter badge stack on scoped surfaces (the profile Reposts list).
   */
  private async getRelevantRepostersForVideos(
    viewerId: string,
    videoIds: string[],
    excludeCreatorIds: string[],
    alwaysIncludeUserId?: string,
  ): Promise<Map<string, RepostReposter[]>> {
    const viewerObjectId = this.toObjectId(viewerId);
    const videoObjectIds = videoIds
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);
    if (!viewerObjectId || videoObjectIds.length === 0) return new Map();

    const follows = await this.followModel
      .find({ followerId: viewerObjectId })
      .select('followeeId')
      .lean()
      .exec();
    const relevantIds = [
      ...new Set([
        ...follows.map((f) => f.followeeId.toString()),
        viewerId,
        ...(alwaysIncludeUserId ? [alwaysIncludeUserId] : []),
      ]),
    ]
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);

    const reposts = await this.repostModel
      .find({ videoId: { $in: videoObjectIds }, reposterId: { $in: relevantIds } })
      .sort({ createdAt: -1, _id: -1 })
      .lean()
      .exec();
    if (reposts.length === 0) return new Map();

    const neededUserIds = [
      ...new Set(reposts.map((r) => r.reposterId.toString())),
    ].map((id) => this.toObjectId(id));
    const users = await this.userModel
      .find({ _id: { $in: neededUserIds } })
      .select('username name avatarUrl')
      .lean()
      .exec();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));
    const excludeSet = new Set(excludeCreatorIds);

    const byVideo = new Map<string, RepostReposter[]>();
    for (const r of reposts) {
      const reposterId = r.reposterId.toString();
      if (excludeSet.has(reposterId)) continue;
      const u = userById.get(reposterId);
      if (!u) continue;
      const videoId = r.videoId.toString();
      const list = byVideo.get(videoId);
      const entry: RepostReposter = {
        id: reposterId,
        username: u.username ?? '',
        name: u.name,
        avatarUrl: u.avatarUrl ?? '',
      };
      if (list) {
        list.push(entry);
      } else {
        byVideo.set(videoId, [entry]);
      }
    }
    return byVideo;
  }

  async searchReels(params: {
    viewerId: string;
    q: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<{ items: ReelDto[]; nextCursor: string | null }> {
    const offset = this.parseCursor(params.cursor);
    const escaped = params.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter: Record<string, unknown> = {
      hashtags: { $regex: escaped, $options: 'i' },
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
  }): Promise<{ items: UserSearchResultDto[]; nextCursor: string | null }> {
    const offset = this.parseCursor(params.cursor);
    const escaped = params.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const excludeIds = [params.viewerId, ...params.excludeUserIds]
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);
    const filter = {
      _id: { $nin: excludeIds },
      $or: [
        { username: { $regex: escaped, $options: 'i' } },
        { name: { $regex: escaped, $options: 'i' } },
      ],
    };
    const total = await this.userModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };
    const docs = await this.userModel
      .find(filter)
      .sort({ name: 1, _id: 1 })
      .skip(offset)
      .limit(params.limit)
      .lean()
      .exec();

    const viewerObjectId = this.toObjectId(params.viewerId);
    const followed = viewerObjectId
      ? await this.followModel
          .find({
            followerId: viewerObjectId,
            followeeId: { $in: docs.map((d) => d._id) },
          })
          .lean()
          .exec()
      : [];
    const followedSet = new Set(followed.map((f) => f.followeeId.toString()));

    const nextOffset = offset + params.limit;
    return {
      items: docs.map((u) => ({
        id: u._id.toString(),
        username: u.username ?? '',
        name: u.name,
        avatarUrl: u.avatarUrl ?? '',
        viewerFollowing: followedSet.has(u._id.toString()),
      })),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * v5 (FR-084, R24): the caller's followees, most-recently-followed first —
   * rides the existing `{followerId, createdAt}` index. Blocked followees
   * are excluded defensively (a block does not delete the follow relation).
   * Order comes from the `Follow` relation, not the `User` collection, so
   * followees are hydrated then re-sorted to match the paged follow order.
   */
  async getFollowingUsers(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeUserIds: string[];
  }): Promise<{ items: FollowedUserDto[]; nextCursor: string | null }> {
    const viewerObjectId = this.toObjectId(params.viewerId);
    if (!viewerObjectId) return { items: [], nextCursor: null };

    const excludeIds = params.excludeUserIds
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);
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
      .lean()
      .exec();
    const orderedFolloweeIds = follows.map((f) => f.followeeId.toString());

    const users = await this.userModel
      .find({ _id: { $in: follows.map((f) => f.followeeId) } })
      .select('username name avatarUrl')
      .lean()
      .exec();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    const items: FollowedUserDto[] = orderedFolloweeIds
      .map((id) => userById.get(id))
      .filter((u): u is NonNullable<typeof u> => u !== undefined)
      .map((u) => ({
        id: u._id.toString(),
        username: u.username ?? '',
        name: u.name,
        avatarUrl: u.avatarUrl ?? '',
      }));

    const nextOffset = offset + params.limit;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * v6: everyone who reposted [reelId], most-recent-first — the reposters
   * bottom sheet. The reel must be visible to the viewer (published, not
   * blocked); reposters the viewer blocked are filtered out.
   */
  async listReposters(
    reelId: string,
    params: { viewerId: string; cursor?: string; limit: number; excludeUserIds: string[] },
  ): Promise<{ items: FollowedUserDto[]; nextCursor: string | null } | null> {
    const videoId = this.toObjectId(reelId);
    if (!videoId) return null;

    // Gate on the reel being visible to the viewer (published / owner).
    const reel = await this.reelModel
      .findOne({ _id: videoId, ...this.visibilityFilter(params.viewerId) })
      .select('_id')
      .lean()
      .exec();
    if (!reel) return null;

    const excludeIds = params.excludeUserIds
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);
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
      .lean()
      .exec();
    const orderedReposterIds = reposts.map((r) => r.reposterId.toString());

    const users = await this.userModel
      .find({ _id: { $in: reposts.map((r) => r.reposterId) } })
      .select('username name avatarUrl')
      .lean()
      .exec();
    const userById = new Map(users.map((u) => [u._id.toString(), u]));

    const items: FollowedUserDto[] = orderedReposterIds
      .map((id) => userById.get(id))
      .filter((u): u is NonNullable<typeof u> => u !== undefined)
      .map((u) => ({
        id: u._id.toString(),
        username: u.username ?? '',
        name: u.name,
        avatarUrl: u.avatarUrl ?? '',
      }));

    const nextOffset = offset + params.limit;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * v3 (FR-067, R19 cascade order): counter adjustment first, then relation
   * docs, then reel-scoped notification events, then the reel doc itself,
   * then media files (best-effort). Owner-only, any status. Sequential
   * writes (no transactions — standalone Mongo, same posture as R9); the
   * final guarded doc-delete makes retries safe.
   */
  async deleteReel(
    id: string,
    viewerId: string,
  ): Promise<
    { deleted: true; videoUrl: string; thumbnailUrl: string } | 'forbidden' | null
  > {
    const videoId = this.toObjectId(id);
    if (!videoId) return null;
    const reel = await this.reelModel.findById(videoId).exec();
    if (!reel) return null;
    if (reel.creatorId.toString() !== viewerId) return 'forbidden';

    if (reel.likesCount > 0) {
      await this.userModel
        .updateOne(
          { _id: reel.creatorId },
          { $inc: { totalLikes: -reel.likesCount } },
        )
        .exec();
    }

    await Promise.all([
      this.likeModel.deleteMany({ videoId }).exec(),
      this.saveModel.deleteMany({ videoId }).exec(),
      this.viewModel.deleteMany({ videoId }).exec(),
      this.shareModel.deleteMany({ videoId }).exec(),
      this.commentModel.deleteMany({ videoId }).exec(),
    ]);
    await this.notificationEventModel.deleteMany({ reelId: videoId }).exec();

    const { videoUrl, thumbnailUrl } = reel;
    await this.reelModel.deleteOne({ _id: videoId }).exec();

    await Promise.all([
      this.unlinkIfLocal(videoUrl),
      this.unlinkIfLocal(thumbnailUrl),
    ]);

    return { deleted: true, videoUrl, thumbnailUrl };
  }

  /**
   * v4 (FR-069/FR-070): report a published reel. A duplicate (unique index
   * on {videoId, reporterId}) is an idempotent no-op — no re-count, no
   * re-check. A real insert `$inc`s `reportsCount`; crossing
   * `REEL_REPORT_AUTOHIDE_THRESHOLD` fires a guarded `published -> hidden`
   * transition (precondition also excludes `adminRestored: true` reels —
   * "one auto-hide per reel ever", FR-070). The daily rate limit
   * (`REEL_REPORT_DAILY_LIMIT`) uses a rolling 24h window, not calendar-day,
   * to avoid timezone/midnight-reset ambiguity.
   */
  async reportReel(
    id: string,
    viewerId: string,
    reason: ReelReportReasonValue,
    customReason: string | undefined,
  ): Promise<
    { reported: true; alreadyReported: boolean } | 'self' | 'rate_limited' | null
  > {
    const videoId = this.toObjectId(id);
    const userId = this.toObjectId(viewerId);
    if (!videoId || !userId) return null;

    // v4 (FR-069): reports are accepted only against published reels —
    // non-published reels follow the unknown-reel path (FR-061).
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;
    if (reel.creatorId.equals(userId)) return 'self';

    const dailyLimit =
      this.configService.get<number>('REEL_REPORT_DAILY_LIMIT') ?? 20;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await this.reportModel
      .countDocuments({ reporterId: userId, createdAt: { $gte: since } })
      .exec();
    if (recentCount >= dailyLimit) return 'rate_limited';

    try {
      await this.reportModel.create({
        videoId,
        reporterId: userId,
        reason,
        // Only `other` carries a custom reason (data-model.md v4: "absent otherwise").
        customReason:
          reason === ReelReportReason.OTHER ? customReason : undefined,
      });
    } catch {
      // Duplicate-key race — another request already recorded this
      // reporter's report for this reel; idempotent no-op (FR-069).
      return { reported: true, alreadyReported: true };
    }

    const threshold =
      this.configService.get<number>('REEL_REPORT_AUTOHIDE_THRESHOLD') ?? 25;
    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: videoId },
        { $inc: { reportsCount: 1 } },
        { returnDocument: 'after' },
      )
      .exec();

    if (updated && updated.reportsCount >= threshold) {
      // FR-070: guarded — precondition excludes reels already moved out of
      // `published` (by this same threshold check racing another report, or
      // by any other writer) and reels an admin has ever restored. Under a
      // concurrent report crossing the threshold at the same instant, only
      // one of these updates actually matches and flips the status; the
      // other is a harmless no-op — exactly-once (SC-021).
      await this.reelModel
        .findOneAndUpdate(
          {
            _id: videoId,
            status: ReelStatus.PUBLISHED,
            adminRestored: { $ne: true },
          },
          { $set: { status: ReelStatus.HIDDEN } },
        )
        .exec();
    }

    return { reported: true, alreadyReported: false };
  }

  /** v4 (FR-071): admin review backlog — hidden reels, newest-hidden-first. */
  async listHiddenReels(params: {
    cursor?: string;
    limit: number;
  }): Promise<{ items: AdminHiddenReelDto[]; nextCursor: string | null }> {
    const offset = this.parseCursor(params.cursor);
    const filter = { status: ReelStatus.HIDDEN };
    const total = await this.reelModel.countDocuments(filter).exec();
    if (total === 0) return { items: [], nextCursor: null };

    // `updatedAt` advances on the hide transition (timestamps: true), so
    // sorting by it descending gives "most recently hidden first" — the
    // same { status, updatedAt } index used by the R17 pending-sweep.
    const docs = await this.reelModel
      .find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip(offset)
      .limit(params.limit)
      .exec();

    const reelIds = docs.map((d) => d._id);
    const creatorIds = [...new Set(docs.map((d) => d.creatorId.toString()))];
    const [creators, reports] = await Promise.all([
      this.userModel
        .find({ _id: { $in: creatorIds.map((id) => new Types.ObjectId(id)) } })
        .select('_id username')
        .lean()
        .exec(),
      this.reportModel
        .find({ videoId: { $in: reelIds } })
        .sort({ createdAt: 1 })
        .lean()
        .exec(),
    ]);
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));
    const reportsByVideo = new Map<string, typeof reports>();
    for (const r of reports) {
      const key = r.videoId.toString();
      const existing = reportsByVideo.get(key);
      if (existing) existing.push(r);
      else reportsByVideo.set(key, [r]);
    }

    const nextOffset = offset + params.limit;
    return {
      items: docs.map((d) => ({
        id: d._id.toString(),
        creator: {
          id: d.creatorId.toString(),
          username: creatorById.get(d.creatorId.toString())?.username ?? '',
        },
        videoUrl: d.videoUrl,
        thumbnailUrl: d.thumbnailUrl,
        description: d.description,
        hiddenAt: (d.updatedAt as Date).toISOString(),
        reportsCount: d.reportsCount,
        reports: (reportsByVideo.get(d._id.toString()) ?? []).map((r) => ({
          reporterId: r.reporterId.toString(),
          reason: r.reason,
          customReason: r.customReason ?? null,
          createdAt: (r.createdAt as Date).toISOString(),
        })),
      })),
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * v4 (FR-071): admin-only `hidden -> published|reject` transition.
   * `restore` sets `adminRestored: true` — permanent auto-hide immunity
   * (FR-070); `reportsCount` is left untouched (retained for audit).
   */
  async adminModerateReel(
    id: string,
    action: 'restore' | 'reject',
  ): Promise<{ id: string; status: string } | 'not_hidden' | null> {
    const videoId = this.toObjectId(id);
    if (!videoId) return null;
    const reel = await this.reelModel.findById(videoId).exec();
    if (!reel) return null;
    if (reel.status !== ReelStatus.HIDDEN) return 'not_hidden';

    const update =
      action === 'restore'
        ? { $set: { status: ReelStatus.PUBLISHED, adminRestored: true } }
        : { $set: { status: ReelStatus.REJECTED } };

    const updated = await this.reelModel
      .findOneAndUpdate(
        { _id: videoId, status: ReelStatus.HIDDEN },
        update,
        { returnDocument: 'after' },
      )
      .exec();
    // A concurrent admin action already decided it — never double-fire.
    if (!updated) return 'not_hidden';

    return { id: updated._id.toString(), status: updated.status };
  }

  /**
   * v4 (FR-073): explicit repost — always sets the relation. A duplicate
   * insert (unique index) is caught and treated as already-reposted, same
   * idempotency posture as the rest of this file's toggles.
   */
  async repostReel(
    id: string,
    viewerId: string,
  ): Promise<{ reposted: true } | 'self' | null> {
    const videoId = this.toObjectId(id);
    const userId = this.toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // v4 (FR-073): reposting is only possible on published reels.
    const reel = await this.reelModel
      .findOne({ _id: videoId, status: ReelStatus.PUBLISHED })
      .exec();
    if (!reel) return null;
    if (reel.creatorId.equals(userId)) return 'self';

    try {
      await this.repostModel.create({ reposterId: userId, videoId });
    } catch {
      // Duplicate-key — already reposted; idempotent no-op.
    }
    return { reposted: true };
  }

  /** v4 (FR-073): explicit un-repost — idempotent no-op if none existed. */
  async unrepostReel(
    id: string,
    viewerId: string,
  ): Promise<{ reposted: false } | null> {
    const videoId = this.toObjectId(id);
    const userId = this.toObjectId(viewerId);
    if (!videoId || !userId) return null;
    // Not tied to publication status — an owner can always remove their
    // own repost even if the source reel later left `published`.
    const reel = await this.reelModel.findById(videoId).exec();
    if (!reel) return null;

    await this.repostModel.deleteOne({ reposterId: userId, videoId }).exec();
    return { reposted: false };
  }

  /** Only uploaded reels have locally-stored media (`/uploads/...`); seeded/CDN URLs are left alone. */
  private async unlinkIfLocal(url: string): Promise<void> {
    if (!url.startsWith('/uploads/')) return;
    try {
      await unlink(join(process.cwd(), url));
    } catch {
      // Best-effort (R19) — a missing file on disk must never block deletion.
    }
  }
}
