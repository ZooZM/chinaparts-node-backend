/**
 * Abstract data-access contract for the reels feature, bound to `ReelsDbRepository` in
 * `reels.module.ts`.
 *
 * Two rules shape every signature here (research R22):
 * - A repository only reads and writes data. It never calls a service, never builds a media URL,
 *   and never triggers a side effect. Operations that can change a reel's status return the
 *   outcome, and `ReelsService` runs the side effects through `ReelLifecycleService`.
 * - Reels leave the repository as `ReelRecord`s carrying media *keys*. `ReelPresenter` turns them
 *   into `ReelDto`s with URLs, because a URL depends on who is asking and on the creator's standing.
 */
import type { AccountType } from '../../common/http/viewer-request';

// ── Plain shapes ────────────────────────────────────────────────────────────────────────────

export type ReelStatusValue =
  'pending_moderation' | 'published' | 'rejected' | 'hidden';

export interface ReelMentionRecord {
  userId: string;
  username: string;
}

/** Object keys of a reel's files, and which bucket they currently sit in. */
export interface ReelMediaRecord {
  videoKey: string;
  thumbnailKey: string;
  location: 'private' | 'public';
}

/** An account as shown next to a reel, a comment, or in a list. `avatarUrl: null` is a placeholder. */
export interface AccountSummary {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
}

export interface Page<T> {
  items: T[];
  /** Opaque. `null` means the end of the list (the For You feed never ends). */
  nextCursor: string | null;
}

// ── Reels ───────────────────────────────────────────────────────────────────────────────────

export interface ReelRecord {
  id: string;
  media: ReelMediaRecord;
  createdAt: string;
  description: string;
  hashtags: string[];
  mentions: ReelMentionRecord[];
  creator: AccountSummary & {
    accountType: AccountType;
    viewerFollowing: boolean;
  };
  // Always present. Non-owners only ever receive `published`: every other status 404s or is
  // filtered out before reaching a record.
  status: ReelStatusValue;
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  viewerLiked: boolean;
  viewerSaved: boolean;
  // Non-null only on For You repost-injected items and on Reposts-list items: the most recent
  // relevant reposter.
  repostedBy: AccountSummary | null;
  // Viewer-relative (FR-060): the reposters the viewer follows, plus the viewer. `repostersCount`
  // is never a total, and both are 0 and [] for signed-out visitors and where there is no repost
  // context.
  repostersCount: number;
  topReposters: AccountSummary[];
  // True whenever the caller (not just a followee) has reposted this reel.
  viewerReposted: boolean;
}

/** The response shape: a record with its keys turned into URLs for this viewer. */
export interface ReelDto extends Omit<ReelRecord, 'media'> {
  videoUrl: string;
  thumbnailUrl: string;
}

/** Everything a status or standing side effect needs to know about a reel. */
export interface ReelSnapshot {
  id: string;
  creatorId: string;
  status: ReelStatusValue;
  media: ReelMediaRecord;
  hashtagsNormalized: string[];
}

// ── Comments ────────────────────────────────────────────────────────────────────────────────

export interface CommentDto {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  text: string;
  createdAt: string;
}

// ── Profiles ────────────────────────────────────────────────────────────────────────────────

export interface ProfileRecord {
  user: AccountSummary & { accountType: AccountType; bio: string };
  stats: { followers: number; following: number; totalLikes: number };
  // `status` is always present. Non-self grids only contain `published` items; the owner's own
  // grid uses it to show Processing, Removed and Under review badges.
  videos: { id: string; media: ReelMediaRecord; status: ReelStatusValue }[];
  viewer: { following: boolean; isSelf: boolean };
}

export interface CreatorProfileDto {
  user: ProfileRecord['user'];
  stats: ProfileRecord['stats'];
  videos: { id: string; thumbnailUrl: string; status: ReelStatusValue }[];
  viewer: ProfileRecord['viewer'];
}

export interface UserSearchResultDto extends AccountSummary {
  viewerFollowing: boolean;
}

/** A followee or a reposter, for the mention-suggestion overlay and the reposters sheet. */
export type FollowedUserDto = AccountSummary;

// ── Moderation ──────────────────────────────────────────────────────────────────────────────

/** Mirrors the report-reason enum's values, kept plain so this file imports no schema. */
export type ReelReportReasonValue =
  'spam' | 'nudity' | 'violence' | 'hate_speech' | 'other';

/** One entry in a report-hidden reel's audit trail. */
export interface AdminReportSummary {
  reporterId: string;
  reason: string;
  customReason: string | null;
  createdAt: string;
}

/** Operator-only. Never reaches a user-facing response. */
export interface AdminHiddenReelRecord {
  id: string;
  creator: { id: string; username: string };
  media: ReelMediaRecord;
  description: string;
  hiddenAt: string;
  reportsCount: number;
  reports: AdminReportSummary[];
}

export interface AdminHiddenReelDto extends Omit<
  AdminHiddenReelRecord,
  'media'
> {
  videoUrl: string;
  thumbnailUrl: string;
}

/** What a hard delete removed, so the caller can clean up media and the hashtag dictionary. */
export type ReelDeletion = ReelSnapshot;

/** What the screening worker needs to decide a reel, and to publish it afterwards. */
export interface ModerationCandidate extends ReelSnapshot {
  description: string;
  mentions: ReelMentionRecord[];
  createdAt: Date;
}

/** The result stored with a reel when screening flags it. */
export interface ModerationOutcome {
  verdict: 'clean' | 'flagged';
  flaggedSource?: 'video' | 'description';
  categories?: string[];
  providerRef?: string;
}

export const REELS_REPOSITORY = Symbol('REELS_REPOSITORY');

export interface ReelsRepository {
  /**
   * Creates a reel in `pending_moderation` with its media in the private bucket. The id is
   * generated by the caller so the object keys can contain it before the document exists
   * (FR-033: the document is written only after the files are stored). Hashtags and mentions
   * arrive already parsed. No notification is sent from here: mention notifications fire only at
   * the publish transition.
   */
  createReel(params: {
    id: string;
    creatorId: string;
    videoKey: string;
    thumbnailKey: string;
    description: string;
    hashtags: string[];
    hashtagsNormalized: string[];
    mentions: ReelMentionRecord[];
  }): Promise<ReelRecord>;

  /**
   * The main feed loops the catalog (nextCursor never null); creator-scoped and hashtag-scoped
   * feeds are finite. `excludeCreatorIds` is the caller's exclusion set (blocks and accounts not
   * in good standing): those creators' reels never appear.
   */
  listFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    creatorId?: string;
    hashtag?: string;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>>;

  getReel(
    id: string,
    viewerId: string,
    excludeCreatorIds: string[],
  ): Promise<ReelRecord | null>;

  toggleLike(
    id: string,
    viewerId: string,
  ): Promise<{
    liked: boolean;
    likesCount: number;
    reel: { id: string; creatorId: string };
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
  ): Promise<ProfileRecord | null>;

  toggleFollow(
    userId: string,
    viewerId: string,
  ): Promise<{ following: boolean; followersCount: number } | 'self' | null>;

  /** Dedup per (userId, videoId); only a real insert increments viewsCount. */
  recordView(
    id: string,
    viewerId: string,
  ): Promise<{ viewsCount: number } | null>;

  /**
   * A signed-out view: counted once per app installation per reel (FR-024). Returns the reel's
   * view count, or null when the reel is unknown or not published.
   */
  recordGuestView(
    id: string,
    installationId: string,
  ): Promise<{ viewsCount: number } | null>;

  /** Private toggle, no public counter. */
  toggleSave(id: string, viewerId: string): Promise<{ saved: boolean } | null>;

  /** Caller-scoped, newest-liked-first. */
  listLiked(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<Page<ReelRecord>>;

  /** Caller-scoped, newest-saved-first. */
  listSaved(
    viewerId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<Page<ReelRecord>>;

  /**
   * `targetUserId`'s reposts, newest-repost-first: the public Reposts profile tab. Unlike
   * liked/saved this is not owner-scoped, because reposting is a public distribution mechanic;
   * `viewerId` still drives block and published-visibility filtering.
   */
  listReposted(
    viewerId: string,
    targetUserId: string,
    params: { cursor?: string; limit: number; excludeCreatorIds: string[] },
  ): Promise<Page<ReelRecord>>;

  /** Reels whose normalized hashtags contain `q`. */
  searchReels(params: {
    viewerId: string;
    q: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>>;

  /** Accounts whose handle or name contain `q`, excluding the caller and the exclusion set. */
  searchUsers(params: {
    viewerId: string;
    q: string;
    cursor?: string;
    limit: number;
    excludeUserIds: string[];
  }): Promise<Page<UserSearchResultDto>>;

  /**
   * The caller's followees, most-recently-followed first: the post-details `@`-mention
   * suggestion overlay.
   */
  getFollowingUsers(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeUserIds: string[];
  }): Promise<Page<FollowedUserDto>>;

  /**
   * Everyone who reposted `reelId`, most-recent-first: the reposters bottom sheet. Block-filtered
   * for the viewer; null when the reel is unknown or not visible.
   */
  listReposters(
    reelId: string,
    params: {
      viewerId: string;
      cursor?: string;
      limit: number;
      excludeUserIds: string[];
    },
  ): Promise<Page<FollowedUserDto> | null>;

  /**
   * Owner-only cascade delete in any status: relation documents, reel-scoped notification events,
   * the creator's `totalLikes`, and the reel document. Returns a snapshot so the caller can remove
   * the media and decrement the hashtag dictionary, `'forbidden'` when `viewerId` is not the
   * creator, or null when the reel is unknown. This method deletes data and nothing else.
   */
  deleteReelCascade(
    id: string,
    viewerId: string,
  ): Promise<ReelDeletion | 'forbidden' | null>;

  /**
   * Records a report against a `published` reel: at most one per (reel, reporter), and a
   * duplicate has no side effects. A real insert `$inc`s `reportsCount`, and when that reaches
   * `autoHideThreshold` the reel transitions `published -> hidden` through a guarded update that
   * fires exactly once under concurrent reports and never for a reel an operator restored.
   *
   * Returns `'hidden'` when this report hid the reel, so the caller can run the side effects;
   * `'self'` when the caller is the creator; null when the reel is unknown or not published.
   * The daily report limit is the caller's business (`countRecentReelReports`), not this method's.
   */
  reportReel(
    id: string,
    viewerId: string,
    reason: ReelReportReasonValue,
    customReason: string | undefined,
    autoHideThreshold: number,
  ): Promise<'reported' | 'duplicate' | 'hidden' | 'self' | null>;

  /** Reel reports by `reporterId` since `since`: half of the shared daily limit (FR-055). */
  countRecentReelReports(reporterId: string, since: Date): Promise<number>;

  /**
   * Original reels by accounts the viewer follows. Never reposts (`repostedBy` is always null).
   * Finite, newest-first, with the standard visibility and exclusion filtering.
   */
  listFollowingFeed(params: {
    viewerId: string;
    cursor?: string;
    limit: number;
    excludeCreatorIds: string[];
  }): Promise<Page<ReelRecord>>;

  /** The operator review backlog: hidden reels, newest-hidden-first, with every report. */
  listHiddenReels(params: {
    cursor?: string;
    limit: number;
  }): Promise<Page<AdminHiddenReelRecord>>;

  /**
   * Operator-only transition out of `hidden`. `restore` sets `adminRestored` (permanent auto-hide
   * immunity); `reject` moves the reel to `rejected`. Guarded on `status: 'hidden'`:
   * `'not_hidden'` when the reel exists but is not hidden (already resolved, or a race); null when
   * unknown. Returns the updated snapshot so the caller can run the side effects.
   */
  adminModerateReel(
    id: string,
    action: 'restore' | 'reject',
  ): Promise<ReelSnapshot | 'not_hidden' | null>;

  /**
   * Explicit repost, not a toggle: always sets the relation (a duplicate is a no-op). `'self'`
   * for the creator; null when the reel is unknown or not published.
   */
  repostReel(
    id: string,
    viewerId: string,
  ): Promise<{ reposted: true } | 'self' | null>;

  /**
   * Explicit un-repost: a no-op when there was none. Null only when the reel is unknown: an owner
   * can always remove their own repost, whatever the reel's status.
   */
  unrepostReel(
    id: string,
    viewerId: string,
  ): Promise<{ reposted: false } | null>;

  // ── Screening support (the only caller is `ReelsModerationService`) ───────────────────────

  getModerationCandidate(id: string): Promise<ModerationCandidate | null>;

  /**
   * Guarded `pending_moderation -> published`: only one of any number of concurrent or retried
   * attempts matches, so the side effects that follow fire exactly once. Null when the reel is
   * gone or was already decided.
   */
  publishPending(id: string): Promise<ModerationCandidate | null>;

  /** Guarded `pending_moderation -> rejected`, storing the screening result. Null as above. */
  rejectPending(
    id: string,
    outcome: ModerationOutcome,
  ): Promise<ModerationCandidate | null>;

  /** Reels stuck in `pending_moderation` for longer than `staleMs`: the retry sweep's input. */
  findStalePendingIds(staleMs: number): Promise<string[]>;

  // ── Lifecycle support (the only callers are `ReelLifecycleService` and its processors) ────

  getSnapshot(id: string): Promise<ReelSnapshot | null>;

  /** Records which bucket a reel's files are in. */
  setMediaLocation(id: string, location: 'private' | 'public'): Promise<void>;

  /** One page of a creator's published reels, for re-applying media visibility after a standing change. */
  listPublishedByCreator(
    creatorId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ReelSnapshot[]>;
}
