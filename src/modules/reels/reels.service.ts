import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LimitsService } from '../../common/config/limits';
import { ErrorCode } from '../../common/errors/error-codes';
import type {
  AuthenticatedUser,
  ViewerContext,
} from '../../common/http/viewer-request';
import { normalizeForMatch } from '../../common/text/normalize-for-match';
import { AccountsService } from '../accounts/accounts.service';
import {
  CommentsQueryDto,
  FeedQueryDto,
  FollowingUsersQueryDto,
} from './dto/feed-query.dto';
import { SearchQueryDto } from './dto/search-query.dto';
import { HashtagStatsService } from './hashtags/hashtag-stats.service';
import { CommentReportsRepository } from './comments/comment-reports.repository';
import { ReelLifecycleService } from './lifecycle/reel-lifecycle.service';
import { ReelPresenter } from './presentation/reel-presenter.service';
import { ReelsNotificationsService } from './reels-notifications.service';
import { ReportLimitService } from './reports/report-limit.service';
import { ExclusionService } from './visibility/exclusion.service';
import { REELS_REPOSITORY } from './reels.repository';
import type {
  AdminHiddenReelDto,
  CommentDto,
  CreatorProfileDto,
  FollowedUserDto,
  Page,
  ReelDto,
  ReelReportReasonValue,
  ReelsRepository,
  UserSearchResultDto,
} from './reels.repository';

/** Page size of the mention-suggestion list: not one of the FR-070 limits. */
const FOLLOWING_USERS_PAGE = { default: 50, max: 100 };
const ADMIN_PAGE = { default: 20, max: 50 };

/**
 * Orchestrates the reels use cases. It owns the decisions: who may see what, what counts as an
 * error, and which side effects follow a transition. Data access lives in the repository, and
 * turning records into responses lives in the presenter (research R22).
 */
@Injectable()
export class ReelsService {
  constructor(
    @Inject(REELS_REPOSITORY) private readonly repository: ReelsRepository,
    private readonly accounts: AccountsService,
    private readonly exclusion: ExclusionService,
    private readonly presenter: ReelPresenter,
    private readonly lifecycle: ReelLifecycleService,
    private readonly notifications: ReelsNotificationsService,
    private readonly limits: LimitsService,
    private readonly hashtags: HashtagStatsService,
    private readonly reportLimit: ReportLimitService,
    private readonly commentReports: CommentReportsRepository,
  ) {}

  // ── Visibility ───────────────────────────────────────────────────────────

  /** Everyone whose content this viewer must not see (FR-009, FR-047), applied to every read. */
  private exclusionSet(viewerId: string): Promise<string[]> {
    return this.exclusion.forViewer(viewerId);
  }

  private idOf(viewer: ViewerContext): string {
    return viewer.user?.userId ?? '';
  }

  private async presentPage(
    page: Page<Parameters<ReelPresenter['presentOne']>[0]>,
    viewer: ViewerContext,
  ): Promise<Page<ReelDto>> {
    return {
      items: await this.presenter.present(page.items, viewer),
      nextCursor: page.nextCursor,
    };
  }

  // ── Feeds and lists ──────────────────────────────────────────────────────

  async getFeed(
    viewer: ViewerContext,
    query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    const viewerId = this.idOf(viewer);
    const hashtag = query.hashtag
      ? normalizeForMatch(query.hashtag.replace(/^#+/, ''))
      : undefined;
    const page = await this.repository.listFeed({
      viewerId,
      cursor: query.cursor,
      limit: this.limits.clampPageSize('feed', query.limit),
      creatorId: query.creatorId,
      hashtag: hashtag || undefined,
      excludeCreatorIds: await this.exclusionSet(viewerId),
    });
    return this.presentPage(page, viewer);
  }

  /** Following tab: original reels only, no reposts (FR-018). */
  async getFollowingFeed(
    user: AuthenticatedUser,
    query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    const page = await this.repository.listFollowingFeed({
      viewerId: user.userId,
      cursor: query.cursor,
      limit: this.limits.clampPageSize('feed', query.limit),
      excludeCreatorIds: await this.exclusionSet(user.userId),
    });
    return this.presentPage(page, { user });
  }

  /** The caller's followees, for the mention-suggestion overlay (FR-046). */
  async getFollowingUsers(
    user: AuthenticatedUser,
    query: FollowingUsersQueryDto,
  ): Promise<Page<FollowedUserDto>> {
    return this.repository.getFollowingUsers({
      viewerId: user.userId,
      cursor: query.cursor,
      limit: Math.min(
        query.limit ?? FOLLOWING_USERS_PAGE.default,
        FOLLOWING_USERS_PAGE.max,
      ),
      excludeUserIds: await this.exclusionSet(user.userId),
    });
  }

  /** Everyone who reposted a reel, for the reposters sheet. */
  async getReposters(
    viewer: ViewerContext,
    reelId: string,
    query: FeedQueryDto,
  ): Promise<Page<FollowedUserDto>> {
    const viewerId = this.idOf(viewer);
    const page = await this.repository.listReposters(reelId, {
      viewerId,
      cursor: query.cursor,
      limit: this.limits.clampPageSize('comments', query.limit),
      excludeUserIds: await this.exclusionSet(viewerId),
    });
    if (page === null) throw this.reelNotFound();
    return page;
  }

  async getLiked(
    user: AuthenticatedUser,
    query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    const page = await this.repository.listLiked(user.userId, {
      cursor: query.cursor,
      limit: this.limits.clampPageSize('feed', query.limit),
      excludeCreatorIds: await this.exclusionSet(user.userId),
    });
    return this.presentPage(page, { user });
  }

  async getSaved(
    user: AuthenticatedUser,
    query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    const page = await this.repository.listSaved(user.userId, {
      cursor: query.cursor,
      limit: this.limits.clampPageSize('feed', query.limit),
      excludeCreatorIds: await this.exclusionSet(user.userId),
    });
    return this.presentPage(page, { user });
  }

  /**
   * The public Reposts list of `query.userId`. Signed-in callers default to themselves; a
   * signed-out visitor must say whose list they want (FR-004, FR-061).
   */
  async getReposted(
    viewer: ViewerContext,
    query: FeedQueryDto,
  ): Promise<Page<ReelDto>> {
    const viewerId = this.idOf(viewer);
    const targetId = query.userId ?? (viewerId || undefined);
    if (!targetId) {
      throw new BadRequestException({
        error: ErrorCode.VALIDATION_FAILED,
        message: 'userId is required',
      });
    }
    const page = await this.repository.listReposted(viewerId, targetId, {
      cursor: query.cursor,
      limit: this.limits.clampPageSize('feed', query.limit),
      excludeCreatorIds: await this.exclusionSet(viewerId),
    });
    return this.presentPage(page, viewer);
  }

  /**
   * Hashtag search, on the normalized form (FR-049, FR-049a): a leading `#` does not matter, and
   * neither do spelling variants, diacritics or digit styles. The matching tags come from the
   * dictionary, and the reels from an indexed `$in` on them (research R9).
   */
  async searchReels(
    user: AuthenticatedUser,
    query: SearchQueryDto,
  ): Promise<Page<ReelDto>> {
    const q = normalizeForMatch(query.q.replace(/^#+/, '')).trim();
    const tags = await this.hashtags.findMatching(q);
    const page = await this.repository.searchReels({
      viewerId: user.userId,
      tags,
      cursor: query.cursor,
      limit: this.limits.clampPageSize('feed', query.limit),
      excludeCreatorIds: await this.exclusionSet(user.userId),
    });
    return this.presentPage(page, { user });
  }

  async searchUsers(
    user: AuthenticatedUser,
    query: SearchQueryDto,
  ): Promise<Page<UserSearchResultDto>> {
    return this.repository.searchUsers({
      viewerId: user.userId,
      q: normalizeForMatch(query.q),
      cursor: query.cursor,
      limit: this.limits.clampPageSize('feed', query.limit),
      excludeUserIds: await this.exclusionSet(user.userId),
    });
  }

  // ── A single reel ────────────────────────────────────────────────────────

  async getReel(viewer: ViewerContext, id: string): Promise<ReelDto> {
    const viewerId = this.idOf(viewer);
    const record = await this.repository.getReel(
      id,
      viewerId,
      await this.exclusionSet(viewerId),
    );
    if (!record) throw this.reelNotFound();
    return this.presenter.presentOne(record, viewer);
  }

  /** Owner-only, any status. The reel's files and its place in the hashtag dictionary go with it. */
  async deleteReel(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ deleted: true }> {
    const result = await this.repository.deleteReelCascade(id, user.userId);
    if (result === null) throw this.reelNotFound();
    if (result === 'forbidden') {
      throw new ForbiddenException({
        error: ErrorCode.NOT_REEL_OWNER,
        message: 'Only the owner can delete this reel',
      });
    }
    // Reports are kept while their reel exists and go with it (research R16).
    await this.commentReports.deleteByReel(id);
    await this.lifecycle.onDeleted(result);
    return { deleted: true };
  }

  // ── Engagement ───────────────────────────────────────────────────────────

  async toggleLike(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ liked: boolean; likesCount: number }> {
    const result = await this.repository.toggleLike(id, user.userId);
    if (!result) throw this.reelNotFound();
    if (result.liked) {
      await this.notifications.notifyReelLike({
        actorId: user.userId,
        recipientId: result.reel.creatorId,
        reelId: result.reel.id,
      });
    }
    return { liked: result.liked, likesCount: result.likesCount };
  }

  async getComments(
    viewer: ViewerContext,
    id: string,
    query: CommentsQueryDto,
  ): Promise<{
    items: CommentDto[];
    nextCursor: string | null;
    commentsCount: number;
  }> {
    const viewerId = this.idOf(viewer);
    const result = await this.repository.listComments(id, {
      viewerId,
      cursor: query.cursor,
      limit: this.limits.clampPageSize('comments', query.limit),
      excludeAuthorIds: await this.exclusionSet(viewerId),
    });
    if (!result) throw this.reelNotFound();
    return result;
  }

  async addComment(
    user: AuthenticatedUser,
    id: string,
    text: string,
  ): Promise<{ comment: CommentDto; commentsCount: number }> {
    const result = await this.repository.addComment(id, user.userId, text);
    if (!result) throw this.reelNotFound();
    return result;
  }

  /** Copy Link only (FR-042). */
  async recordShare(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ sharesCount: number }> {
    const result = await this.repository.recordShare(id, user.userId);
    if (!result) throw this.reelNotFound();
    return result;
  }

  /**
   * A view counts once per account per reel, and once per app installation for a signed-out
   * visitor (FR-024). A signed-out request without an installation id records nothing, and just
   * reports the current count.
   */
  async recordView(
    viewer: ViewerContext,
    id: string,
  ): Promise<{ viewsCount: number }> {
    let result: { viewsCount: number } | null;
    if (viewer.user) {
      result = await this.repository.recordView(id, viewer.user.userId);
    } else if (viewer.installationId) {
      result = await this.repository.recordGuestView(id, viewer.installationId);
    } else {
      const reel = await this.repository.getReel(
        id,
        '',
        await this.exclusionSet(''),
      );
      result = reel ? { viewsCount: reel.viewsCount } : null;
    }
    if (!result) throw this.reelNotFound();
    return result;
  }

  /**
   * A tap on a product card (FR-038), signed in or out. The product must be one the reel links;
   * whether it is still available is not asked, because the tap is on a card that was shown.
   */
  async recordProductTap(
    viewer: ViewerContext,
    reelId: string,
    productId: string,
  ): Promise<null> {
    const id = /^\d+$/.test(productId) ? Number(productId) : 0;
    const viewerId = this.idOf(viewer);
    const result =
      id > 0
        ? await this.repository.recordProductTap({
            reelId,
            productId: id,
            viewerId,
            installationId: viewer.installationId,
            excludeCreatorIds: await this.exclusionSet(viewerId),
          })
        : 'not_linked';
    if (result === null) throw this.reelNotFound();
    if (result === 'not_linked') {
      throw new NotFoundException({
        error: ErrorCode.PRODUCT_LINK_NOT_FOUND,
        message: 'That product is not linked to this reel',
      });
    }
    return null;
  }

  /** A private toggle with no public counter (FR-041). */
  async toggleSave(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ saved: boolean }> {
    const result = await this.repository.toggleSave(id, user.userId);
    if (!result) throw this.reelNotFound();
    return result;
  }

  // ── Reposts ──────────────────────────────────────────────────────────────

  async repostReel(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ reposted: true }> {
    const result = await this.repository.repostReel(id, user.userId);
    if (result === null) throw this.reelNotFound();
    if (result === 'self') {
      throw new BadRequestException({
        error: ErrorCode.CANNOT_REPOST_OWN_REEL,
        message: 'Cannot repost your own reel',
      });
    }
    return result;
  }

  async unrepostReel(
    user: AuthenticatedUser,
    id: string,
  ): Promise<{ reposted: false }> {
    const result = await this.repository.unrepostReel(id, user.userId);
    if (result === null) throw this.reelNotFound();
    return result;
  }

  // ── Profiles and the social graph ───────────────────────────────────────

  async getProfile(
    viewer: ViewerContext,
    userId: string,
  ): Promise<CreatorProfileDto> {
    const viewerId = this.idOf(viewer);
    const record = await this.repository.getProfile(
      userId,
      viewerId,
      await this.exclusionSet(viewerId),
    );
    if (!record) throw this.accountNotFound();
    return this.presenter.presentProfile(record, viewer);
  }

  async toggleFollow(
    user: AuthenticatedUser,
    userId: string,
  ): Promise<{ following: boolean; followersCount: number }> {
    const result = await this.repository.toggleFollow(userId, user.userId);
    if (result === 'self') {
      throw new BadRequestException({
        error: ErrorCode.CANNOT_FOLLOW_SELF,
        message: 'Cannot follow yourself',
      });
    }
    if (!result) throw this.accountNotFound();
    if (result.following) {
      await this.notifications.notifyNewFollower({
        actorId: user.userId,
        recipientId: userId,
      });
    }
    return result;
  }

  /** A directed block. It hides reels and comments both ways and touches nothing in China Parts (FR-048). */
  async toggleBlock(
    user: AuthenticatedUser,
    targetId: string,
  ): Promise<{ blocked: boolean }> {
    return this.accounts.toggleBlock(user.userId, targetId);
  }

  // ── Reporting and operator review ────────────────────────────────────────

  /**
   * Reports a reel. The daily limit (shared with comment reports, FR-055) is checked here, in the
   * service, because the repository only counts. A report that reaches the auto-hide threshold hides the reel, and the
   * lifecycle takes its public files down (FR-056).
   */
  async reportReel(
    user: AuthenticatedUser,
    id: string,
    dto: { reason: ReelReportReasonValue; customReason?: string },
  ): Promise<{ reported: true; alreadyReported: boolean }> {
    // A repeat is a quiet success and is not counted against the limit; anything new is.
    if (await this.repository.hasReportedReel(id, user.userId)) {
      return { reported: true, alreadyReported: true };
    }
    await this.reportLimit.assertWithinLimit(user.userId);

    const outcome = await this.repository.reportReel(
      id,
      user.userId,
      dto.reason,
      dto.customReason,
      this.limits.reportAutoHideThreshold,
    );
    if (outcome === null) throw this.reelNotFound();
    if (outcome === 'self') {
      throw new BadRequestException({
        error: ErrorCode.CANNOT_REPORT_OWN_REEL,
        message: 'Cannot report your own reel',
      });
    }
    if (outcome === 'hidden') {
      const snapshot = await this.repository.getSnapshot(id);
      if (snapshot) await this.lifecycle.onUnpublished(snapshot);
    }
    return { reported: true, alreadyReported: outcome === 'duplicate' };
  }

  /** The operator backlog of hidden reels. */
  async listHiddenReels(query: {
    cursor?: string;
    limit?: number;
  }): Promise<Page<AdminHiddenReelDto>> {
    const page = await this.repository.listHiddenReels({
      cursor: query.cursor,
      limit: Math.min(query.limit ?? ADMIN_PAGE.default, ADMIN_PAGE.max),
    });
    return {
      items: await this.presenter.presentHidden(page.items),
      nextCursor: page.nextCursor,
    };
  }

  /** Operator restore or reject of a hidden reel. A restore puts the files back (FR-058). */
  async adminModerateReel(
    id: string,
    action: 'restore' | 'reject',
  ): Promise<{ id: string; status: string }> {
    const result = await this.repository.adminModerateReel(id, action);
    if (result === null) throw this.reelNotFound();
    if (result === 'not_hidden') {
      throw new ConflictException({
        error: ErrorCode.REEL_NOT_HIDDEN,
        message: 'Reel is not hidden',
      });
    }
    if (action === 'restore') {
      await this.lifecycle.onRestored(result);
    } else {
      // The reel was hidden, so its tags were already taken off when it was hidden.
      await this.lifecycle.onUnpublished(result, { wasPublished: false });
    }
    return { id: result.id, status: result.status };
  }

  // ── Errors ───────────────────────────────────────────────────────────────

  private reelNotFound(): NotFoundException {
    return new NotFoundException({
      error: ErrorCode.REEL_NOT_FOUND,
      message: 'Reel not found',
    });
  }

  private accountNotFound(): NotFoundException {
    return new NotFoundException({
      error: ErrorCode.ACCOUNT_NOT_FOUND,
      message: 'Account not found',
    });
  }
}
