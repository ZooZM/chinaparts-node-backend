import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../../common/http/viewer-request';
import { AccountsService } from '../../accounts/accounts.service';
import { decodeListCursor, encodeFeedCursor } from '../feed/feed-cursor';
import { ReportLimitService } from '../reports/report-limit.service';
import { REELS_REPOSITORY } from '../reels.repository';
import type { Page, ReelsRepository } from '../reels.repository';
import type { ReelReportReason } from '../schemas/reel-report.schema';
import { ExclusionService } from '../visibility/exclusion.service';
import { CommentReportsRepository } from './comment-reports.repository';
import { CommentsRepository } from './comments.repository';
import { CommentsService } from './comments.service';

/** A comment in the operator's queue (contracts/rest-api.md "Operator comment queue item"). */
export interface CommentQueueItem {
  commentId: string;
  reelId: string;
  text: string;
  author: { id: string; username: string; accountType: string } | null;
  openReportsCount: number;
  lastReportedAt: string;
  reports: Array<{
    reporterId: string;
    reason: string;
    customReason: string | null;
    createdAt: string;
  }>;
}

/**
 * Reporting a comment, and the operator's queue of reported comments (FR-052, research R16, R22).
 * What counts as a valid report, the shared daily limit and the order of the checks live here; the
 * repositories only read and write.
 */
@Injectable()
export class CommentReportsService {
  constructor(
    private readonly reports: CommentReportsRepository,
    private readonly comments: CommentsRepository,
    private readonly commentsService: CommentsService,
    private readonly limit: ReportLimitService,
    private readonly exclusion: ExclusionService,
    private readonly accounts: AccountsService,
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
  ) {}

  /**
   * Reports a comment. The reel must be published and visible to the reporter, the comment must
   * exist and be visible to them too, and it must not be their own. A repeat is a quiet success and
   * is not counted against the daily limit; anything new is.
   */
  async report(
    reelId: string,
    commentId: string,
    user: AuthenticatedUser,
    dto: { reason: ReelReportReason; customReason?: string },
  ): Promise<{ reported: true; alreadyReported: boolean }> {
    const excluded = await this.exclusion.forViewer(user.userId);
    const reel = Types.ObjectId.isValid(reelId)
      ? await this.reels.getSnapshot(reelId)
      : null;
    if (
      !reel ||
      reel.status !== 'published' ||
      excluded.includes(reel.creatorId)
    ) {
      throw this.reelNotFound();
    }

    const comment = Types.ObjectId.isValid(commentId)
      ? await this.comments.findActive(reelId, commentId)
      : null;
    // A comment from someone the reporter cannot see is, to them, not there.
    if (!comment || excluded.includes(comment.authorId)) {
      throw this.commentNotFound();
    }
    if (comment.authorId === user.userId) {
      throw new BadRequestException({
        error: ErrorCode.CANNOT_REPORT_OWN_COMMENT,
        message: 'Cannot report your own comment',
      });
    }

    if (await this.reports.exists(commentId, user.userId)) {
      return { reported: true, alreadyReported: true };
    }
    await this.limit.assertWithinLimit(user.userId);

    const outcome = await this.reports.add({
      commentId,
      reelId,
      reporterId: user.userId,
      reason: dto.reason,
      customReason: dto.customReason,
    });
    return { reported: true, alreadyReported: outcome === 'duplicate' };
  }

  /** Comments with open reports, most recently reported first (EP31). */
  async listQueue(query: {
    cursor?: string;
    limit: number;
  }): Promise<Page<CommentQueueItem>> {
    const cursor = decodeListCursor(query.cursor);
    const groups = await this.reports.listOpenGrouped({
      after: cursor
        ? { lastReportedAt: cursor.createdAt, commentId: cursor.id }
        : undefined,
      limit: query.limit,
    });
    const page = groups.slice(0, query.limit);
    const last = page[page.length - 1];
    const authors = await this.accounts.getAuthors(
      page.map((group) => group.authorId),
    );

    return {
      items: page.map((group) => ({
        commentId: group.commentId,
        reelId: group.reelId,
        text: group.text,
        author: authors.get(group.authorId) ?? null,
        openReportsCount: group.openReportsCount,
        lastReportedAt: group.lastReportedAt.toISOString(),
        reports: group.reports.map((report) => ({
          ...report,
          createdAt: report.createdAt.toISOString(),
        })),
      })),
      nextCursor:
        groups.length > query.limit && last
          ? encodeFeedCursor({
              pass: 0,
              createdAt: last.lastReportedAt,
              id: last.commentId,
            })
          : null,
    };
  }

  /** The operator removes the comment: a soft delete, the reel's count goes down (EP32). */
  async remove(commentId: string): Promise<{ id: string; action: 'remove' }> {
    const comment = await this.comments.findActiveById(commentId);
    if (!comment) throw this.commentNotFound();
    await this.commentsService.deleteComment(comment.reelId, commentId, {
      operator: true,
    });
    return { id: commentId, action: 'remove' };
  }

  /** The operator keeps the comment and closes its open reports (EP32). Safe to repeat. */
  async dismiss(commentId: string): Promise<{ id: string; action: 'dismiss' }> {
    const comment = await this.comments.findActiveById(commentId);
    if (!comment) throw this.commentNotFound();
    await this.reports.dismissOpen(commentId);
    return { id: commentId, action: 'dismiss' };
  }

  private reelNotFound(): NotFoundException {
    return new NotFoundException({
      error: ErrorCode.REEL_NOT_FOUND,
      message: 'Reel not found',
    });
  }

  private commentNotFound(): NotFoundException {
    return new NotFoundException({
      error: ErrorCode.COMMENT_NOT_FOUND,
      message: 'Comment not found',
    });
  }
}
