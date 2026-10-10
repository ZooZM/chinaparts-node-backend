/**
 * Abstract data-access contract for the Reels feature (specs/021-reels-video-feed).
 *
 * v2: bound to `ReelsDbRepository` (Mongoose) in `reels.module.ts` — the
 * mock store has been retired (FR-032/FR-033, clarified: real database this
 * phase). The shape here is unchanged in spirit from v1 so `ReelsService`
 * and the controllers did not need to change their calling conventions.
 */

export interface ReelCreatorRecord {
  id: string;
  name: string;
  username: string;
  avatarUrl: string;
  bio: string;
}

export interface ReelMentionRecord {
  userId: string;
  username: string;
}

export interface ReelVideoRecord {
  id: string;
  creatorId: string;
  videoUrl: string;
  thumbnailUrl: string;
  description: string;
  hashtags: string[];
  mentions: ReelMentionRecord[];
  createdAt: string;
}

export interface ReelCommentRecord {
  id: string;
  videoId: string;
  authorId: string;
  text: string;
  createdAt: string;
}

export interface ReelDto {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  createdAt: string;
  description: string;
  hashtags: string[];
  mentions: ReelMentionRecord[];
  creator: {
    id: string;
    name: string;
    username: string;
    avatarUrl: string;
    viewerFollowing: boolean;
  };
  // v3 (FR-061): always present. Non-owners only ever receive `published`
  // (every other status 404s or is filtered out before reaching a DTO).
  status: 'pending_moderation' | 'published' | 'rejected' | 'hidden';
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  viewerLiked: boolean;
  viewerSaved: boolean;
  // v4 (FR-076): non-null only on For You repost-injected items (and v6
  // profile Reposts-list items). The primary/most-recent relevant reposter.
  repostedBy: { id: string; username: string; name: string; avatarUrl: string } | null;
  // v6: viewer-relevant reposters (people the viewer follows, ∪ the viewer),
  // driving the multi-reposter badge — `repostersCount` is the total of that
  // relevant set, `topReposters` are up to 3 of them (most-recent-first) for
  // the stacked-avatar display. Both 0/[] on surfaces without repost context.
  repostersCount: number;
  topReposters: { id: string; username: string; name: string; avatarUrl: string }[];
  // v4 (FR-073): drives the action-column Repost button's active state —
  // true whenever the CALLER (not just any followee) has reposted this reel.
  viewerReposted: boolean;
}

export interface CommentDto {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string;
  text: string;
  createdAt: string;
}

export interface CreatorProfileDto {
  user: {
    id: string;
    name: string;
    username: string;
    avatarUrl: string;
    bio: string;
  };
  stats: { followers: number; following: number; totalLikes: number };
  // v3: `status` always present. Non-self grids only ever contain
  // `published` items (FR-061) — the field is harmless there, but the
  // self grid uses it to render Processing/Removed badges (FR-065).
  videos: {
    id: string;
    thumbnailUrl: string;
    status: 'pending_moderation' | 'published' | 'rejected' | 'hidden';
  }[];
  viewer: { following: boolean; isSelf: boolean };
}

export interface UserSearchResultDto {
  id: string;
  username: string;
  name: string;
  avatarUrl: string;
  viewerFollowing: boolean;
}

/** v5 (FR-084): a followee entry for the mention-suggestion overlay. */
export interface FollowedUserDto {
  id: string;
  username: string;
  name: string;
  avatarUrl: string;
}

/** v4 (FR-069): mirrors `ReelReportReason` schema enum's string values — kept
 * as a plain union here so this abstract-contract file stays free of any
 * Mongoose/schema import (consistent with the rest of the file). */
export type ReelReportReasonValue =
  | 'spam'
  | 'nudity'
  | 'violence'
  | 'hate_speech'
  | 'other';

/** v4 (FR-071): one entry in a report-hidden reel's audit trail. */
export interface AdminReportSummary {
  reporterId: string;
  reason: string;
  customReason: string | null;
  createdAt: string;
}

/** v4 (FR-071): admin-only shape — never reaches a normal user-facing DTO. */
export interface AdminHiddenReelDto {
  id: string;
  creator: { id: string; username: string };
  videoUrl: string;
  thumbnailUrl: string;
  description: string;
  hiddenAt: string;
  reportsCount: number;
  reports: AdminReportSummary[];
}

export const REELS_REPOSITORY = Symbol('REELS_REPOSITORY');

export interface ReelsRepository {
  /**
   * v3 (FR-060): creates a reel in `pending_moderation`. Hashtags/mentions
   * are parsed by the caller (reused `reels-text.util.ts`, same as the
   * seeder) and passed in already-resolved; no notifications are sent from
   * here — mention notifications fire only at the publish transition
   * (FR-063), owned by the moderation worker.
   */
  createReel(params: {
    creatorId: string;
    videoUrl: string;
    thumbnailUrl: string;
    description: string;
    hashtags: string[];
    mentions: { userId: string; username: string }[];
  }): Promise<ReelDto>;

  /**
   * FR-007/FR-009: main feed loops the catalog (nextCursor never null);
   * creator-scoped and hashtag-scoped feeds are finite.
   * FR-052/053: `excludeCreatorIds` is the caller's mutual block set —
   * excluded creators' reels never appear in the page.
   */
  listFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    creatorId?: string;
    hashtag?: string;
    excludeCreatorIds: string[];
  }): Promise<{ items: ReelDto[]; nextCursor: string | null }>;

  getReel(
    id: string,
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<ReelDto | null>;

  toggleLike(
    id: string,
    viewerId: string,
  ): Promise<{
    liked: boolean;
    likesCount: number;
    reel: ReelVideoRecord;
  } | null>;

  listComments(
    id: string,
    params: { cursor?: string; limit: number; excludeAuthorIds: string[] },
  ): Promise<{
    items: CommentDto[];
    nextCursor: string | null;
    commentsCount: number;
  } | null>;

  addComment(
    id: string,
    viewerId: string,
    text: string,
  ): Promise<{ comment: CommentDto; commentsCount: number } | null>;

  recordShare(
    id: string,
    viewerId: string,
  ): Promise<{ sharesCount: number } | null>;

  getProfile(
    userId: string,
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<CreatorProfileDto | null>;

  toggleFollow(
    userId: string,
    viewerId: string,
  ): Promise<{ following: boolean; followersCount: number } | 'self' | null>;

  /** FR-048: dedup per (userId, videoId); only a real insert increments viewsCount. */
  recordView(
    id: string,
    viewerId: string,
  ): Promise<{ viewsCount: number } | null>;

  /** FR-049: private toggle, no public counter. */
  toggleSave(id: string, viewerId: string): Promise<{ saved: boolean } | null>;

  /** FR-051: caller-scoped, newest-liked-first. */
  listLiked(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<{ items: ReelDto[]; nextCursor: string | null }>;

  /** FR-050: caller-scoped, newest-saved-first. */
  listSaved(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<{ items: ReelDto[]; nextCursor: string | null }>;

  /**
   * v6: [targetUserId]'s reposts, newest-repost-first — the public Reposts
   * profile tab. Unlike liked/saved this is NOT owner-scoped (reposting is a
   * public distribution mechanic); [viewerId] still drives block + published
   * visibility filtering.
   */
  listReposted(
    viewerId: string,
    targetUserId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<{ items: ReelDto[]; nextCursor: string | null }>;

  /** FR-057: reels whose hashtags contain `q` (case-insensitive substring). */
  searchReels(params: {
    viewerId: string;
    q: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<{ items: ReelDto[]; nextCursor: string | null }>;

  /** FR-057: users whose username/name contain `q`, excluding the caller + block set. */
  searchUsers(params: {
    viewerId: string;
    q: string;
    cursor?: string;
    limit: number;
    excludeUserIds: string[];
  }): Promise<{ items: UserSearchResultDto[]; nextCursor: string | null }>;

  /**
   * v5 (FR-084): the caller's followees, most-recently-followed first —
   * powers the post-details `@`-mention suggestion overlay (R24).
   */
  getFollowingUsers(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeUserIds: string[];
  }): Promise<{ items: FollowedUserDto[]; nextCursor: string | null }>;

  /**
   * v6: everyone who reposted [reelId], most-recent-first — the reposters
   * bottom sheet. Block-filtered for the viewer; `null` when the reel is
   * unknown/not visible.
   */
  listReposters(
    reelId: string,
    params: { viewerId: string; cursor?: string; limit: number; excludeUserIds: string[] },
  ): Promise<{ items: FollowedUserDto[]; nextCursor: string | null } | null>;

  /**
   * v3 (FR-067): owner-only cascade delete — relation docs, reel-scoped
   * notification events, the creator's `totalLikes` counter, and the reel
   * doc itself. Returns the media URLs so the caller can unlink the files;
   * `'forbidden'` when `viewerId` is not the creator; `null` when unknown.
   */
  deleteReel(
    id: string,
    viewerId: string,
  ): Promise<
    { deleted: true; videoUrl: string; thumbnailUrl: string } | 'forbidden' | null
  >;

  /**
   * v4 (FR-069/FR-070): records a report against a `published` reel (at
   * most one per (reel, reporter) — `alreadyReported: true` on a duplicate,
   * no side effects). A real (non-duplicate) insert `$inc`s the reel's
   * `reportsCount`; when that crosses `REEL_REPORT_AUTOHIDE_THRESHOLD` the
   * reel transitions `published -> hidden` via a guarded update (exactly
   * once under concurrent reports; permanently skipped once the reel
   * carries `adminRestored: true` — FR-070 "one auto-hide per reel ever").
   * Returns `'self'` if the caller is the reel's creator, `'rate_limited'`
   * if the caller has hit `REEL_REPORT_DAILY_LIMIT`, `null` if the reel is
   * unknown/non-published.
   */
  reportReel(
    id: string,
    viewerId: string,
    reason: ReelReportReasonValue,
    customReason: string | undefined,
  ): Promise<
    { reported: true; alreadyReported: boolean } | 'self' | 'rate_limited' | null
  >;

  /**
   * v4 (FR-075): original reels created by users the viewer follows — NEVER
   * reposts (`repostedBy` always null here). Finite, newest-first, standard
   * visibility + block filtering.
   */
  listFollowingFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<{ items: ReelDto[]; nextCursor: string | null }>;

  /**
   * v4 (FR-071): the admin review backlog — hidden reels newest-hidden-first,
   * each with its full report list (reason/customReason/reporter/time) so
   * operators can triage without database access. Never reaches a
   * user-facing endpoint.
   */
  listHiddenReels(params: {
    cursor?: string;
    limit: number;
  }): Promise<{ items: AdminHiddenReelDto[]; nextCursor: string | null }>;

  /**
   * v4 (FR-071): admin-only transition out of `hidden`. `restore` sets
   * `adminRestored: true` (permanent auto-hide immunity, FR-070); `reject`
   * moves the reel into the existing `rejected` presentation. Guarded
   * (precondition `status: 'hidden'`) — `'not_hidden'` when the reel exists
   * but isn't currently hidden (already resolved, or a race); `null` when
   * unknown.
   */
  adminModerateReel(
    id: string,
    action: 'restore' | 'reject',
  ): Promise<{ id: string; status: string } | 'not_hidden' | null>;

  /**
   * v4 (FR-073): explicit repost — NOT a toggle. Always sets the relation
   * (idempotent on repeat, unique index makes a duplicate insert a no-op).
   * `'self'` when the caller is the reel's creator (no self-repost); `null`
   * when the reel is unknown/non-published.
   */
  repostReel(id: string, viewerId: string): Promise<{ reposted: true } | 'self' | null>;

  /**
   * v4 (FR-073): explicit un-repost — idempotent no-op if no repost
   * existed. `null` only when the reel itself is unknown (not tied to
   * publication status — an owner can always remove their own repost).
   */
  unrepostReel(id: string, viewerId: string): Promise<{ reposted: false } | null>;
}
