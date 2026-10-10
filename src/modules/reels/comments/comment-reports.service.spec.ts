import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { user } from '../../../common/guards/testing';
import type { AccountsService } from '../../accounts/accounts.service';
import { encodeFeedCursor } from '../feed/feed-cursor';
import { ReelReportReason } from '../schemas/reel-report.schema';
import type { ReportLimitService } from '../reports/report-limit.service';
import type { ReelSnapshot, ReelsRepository } from '../reels.repository';
import type { ExclusionService } from '../visibility/exclusion.service';
import type {
  CommentReportsRepository,
  OpenReportGroup,
} from './comment-reports.repository';
import { CommentReportsService } from './comment-reports.service';
import type { CommentsRepository } from './comments.repository';
import type { CommentsService } from './comments.service';

const reelId = new Types.ObjectId().toString();
const commentId = new Types.ObjectId().toString();
const authorId = new Types.ObjectId().toString();
const creatorId = new Types.ObjectId().toString();
const me = user({ userId: new Types.ObjectId().toString() });

function snapshot(over: Partial<ReelSnapshot> = {}): ReelSnapshot {
  return {
    id: reelId,
    creatorId,
    status: 'published',
    media: { videoKey: 'v', thumbnailKey: 't', location: 'public' },
    hashtags: [],
    hashtagsNormalized: [],
    ...over,
  };
}

function setup() {
  const reports = {
    exists: jest.fn().mockResolvedValue(false),
    add: jest.fn().mockResolvedValue('created'),
    listOpenGrouped: jest.fn().mockResolvedValue([]),
    dismissOpen: jest.fn().mockResolvedValue(1),
  };
  const comments = {
    findActive: jest.fn().mockResolvedValue({ authorId }),
    findActiveById: jest.fn().mockResolvedValue({ reelId, authorId }),
  };
  const commentsService = {
    deleteComment: jest.fn().mockResolvedValue({ deleted: true }),
  };
  const limit = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
  const exclusion = { forViewer: jest.fn().mockResolvedValue([]) };
  const accounts = { getAuthors: jest.fn().mockResolvedValue(new Map()) };
  const reels = { getSnapshot: jest.fn().mockResolvedValue(snapshot()) };
  const service = new CommentReportsService(
    reports as unknown as CommentReportsRepository,
    comments as unknown as CommentsRepository,
    commentsService as unknown as CommentsService,
    limit as unknown as ReportLimitService,
    exclusion as unknown as ExclusionService,
    accounts as unknown as AccountsService,
    reels as unknown as ReelsRepository,
  );
  return {
    service,
    reports,
    comments,
    commentsService,
    limit,
    exclusion,
    accounts,
    reels,
  };
}

const dto = { reason: ReelReportReason.SPAM };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { error: string }).error;
  }
  return 'no error';
}

describe('CommentReportsService (research R16, R22)', () => {
  describe('report', () => {
    it("records a report of another account's comment", async () => {
      const { service, reports, limit } = setup();

      await expect(service.report(reelId, commentId, me, dto)).resolves.toEqual(
        {
          reported: true,
          alreadyReported: false,
        },
      );

      expect(limit.assertWithinLimit).toHaveBeenCalledWith(me.userId);
      expect(reports.add).toHaveBeenCalledWith({
        commentId,
        reelId,
        reporterId: me.userId,
        reason: ReelReportReason.SPAM,
        customReason: undefined,
      });
    });

    it('passes the text of an "other" report on', async () => {
      const { service, reports } = setup();
      await service.report(reelId, commentId, me, {
        reason: ReelReportReason.OTHER,
        customReason: 'rude',
      });
      expect(reports.add).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: ReelReportReason.OTHER,
          customReason: 'rude',
        }),
      );
    });

    it('is a quiet success for a repeat, checked before the limit and without writing', async () => {
      const { service, reports, limit } = setup();
      reports.exists.mockResolvedValue(true);

      await expect(service.report(reelId, commentId, me, dto)).resolves.toEqual(
        {
          reported: true,
          alreadyReported: true,
        },
      );

      expect(limit.assertWithinLimit).not.toHaveBeenCalled();
      expect(reports.add).not.toHaveBeenCalled();
    });

    it('is a quiet success when two identical reports race and the second loses', async () => {
      const { service, reports } = setup();
      reports.add.mockResolvedValue('duplicate');
      await expect(service.report(reelId, commentId, me, dto)).resolves.toEqual(
        {
          reported: true,
          alreadyReported: true,
        },
      );
    });

    it('refuses your own comment', async () => {
      const { service, comments, reports } = setup();
      comments.findActive.mockResolvedValue({ authorId: me.userId });

      const error = await service
        .report(reelId, commentId, me, dto)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        ((error as BadRequestException).getResponse() as { error: string })
          .error,
      ).toBe('CANNOT_REPORT_OWN_COMMENT');
      expect(reports.add).not.toHaveBeenCalled();
    });

    it.each([
      ['a reel that does not exist', { reel: null }],
      [
        'a reel that is not published',
        { reel: snapshot({ status: 'hidden' }) },
      ],
      [
        'a reel whose creator the reporter cannot see',
        { excluded: [creatorId] },
      ],
    ])('is REEL_NOT_FOUND for %s', async (_label, setupOver) => {
      const { service, reels, exclusion, reports } = setup();
      if ('reel' in setupOver)
        reels.getSnapshot.mockResolvedValue(setupOver.reel);
      if ('excluded' in setupOver)
        exclusion.forViewer.mockResolvedValue(setupOver.excluded);

      expect(await codeOf(service.report(reelId, commentId, me, dto))).toBe(
        'REEL_NOT_FOUND',
      );
      expect(reports.add).not.toHaveBeenCalled();
    });

    it('is REEL_NOT_FOUND for an id that is not an id, without a lookup', async () => {
      const { service, reels } = setup();
      expect(await codeOf(service.report('nope', commentId, me, dto))).toBe(
        'REEL_NOT_FOUND',
      );
      expect(reels.getSnapshot).not.toHaveBeenCalled();
    });

    it.each([
      ['a comment that is missing or deleted', null],
      ['a comment by an account the reporter cannot see', 'excluded-author'],
    ])('is COMMENT_NOT_FOUND for %s', async (_label, kind) => {
      const { service, comments, exclusion } = setup();
      if (kind === null) comments.findActive.mockResolvedValue(null);
      else exclusion.forViewer.mockResolvedValue([authorId]);

      expect(await codeOf(service.report(reelId, commentId, me, dto))).toBe(
        'COMMENT_NOT_FOUND',
      );
    });

    it('is COMMENT_NOT_FOUND for a comment id that is not an id', async () => {
      const { service, comments } = setup();
      expect(await codeOf(service.report(reelId, 'nope', me, dto))).toBe(
        'COMMENT_NOT_FOUND',
      );
      expect(comments.findActive).not.toHaveBeenCalled();
    });

    it('lets the daily limit stop a new report, and records nothing', async () => {
      const { service, limit, reports } = setup();
      limit.assertWithinLimit.mockRejectedValue(
        new HttpException({ error: 'REPORT_DAILY_LIMIT' }, 429),
      );

      expect(await codeOf(service.report(reelId, commentId, me, dto))).toBe(
        'REPORT_DAILY_LIMIT',
      );
      expect(reports.add).not.toHaveBeenCalled();
    });
  });

  describe('listQueue', () => {
    const group = (over: Partial<OpenReportGroup> = {}): OpenReportGroup => ({
      commentId,
      reelId,
      text: 'a comment',
      authorId,
      openReportsCount: 2,
      lastReportedAt: new Date('2026-10-01T10:00:00.000Z'),
      reports: [
        {
          reporterId: 'r1',
          reason: 'spam',
          customReason: null,
          createdAt: new Date('2026-10-01T10:00:00.000Z'),
        },
      ],
      ...over,
    });

    it('describes each comment with its author and its reports', async () => {
      const { service, reports, accounts } = setup();
      reports.listOpenGrouped.mockResolvedValue([group()]);
      accounts.getAuthors.mockResolvedValue(
        new Map([
          [
            authorId,
            { id: authorId, username: 'sara', accountType: 'customer' },
          ],
        ]),
      );

      const page = await service.listQueue({ limit: 20 });

      expect(page).toEqual({
        items: [
          {
            commentId,
            reelId,
            text: 'a comment',
            author: { id: authorId, username: 'sara', accountType: 'customer' },
            openReportsCount: 2,
            lastReportedAt: '2026-10-01T10:00:00.000Z',
            reports: [
              {
                reporterId: 'r1',
                reason: 'spam',
                customReason: null,
                createdAt: '2026-10-01T10:00:00.000Z',
              },
            ],
          },
        ],
        nextCursor: null,
      });
    });

    it('gives a cursor only when there is a next page, built from the last item shown', async () => {
      const { service, reports } = setup();
      const ids = [0, 1, 2].map(() => new Types.ObjectId().toString());
      reports.listOpenGrouped.mockResolvedValue(
        ids.map((id, index) =>
          group({
            commentId: id,
            lastReportedAt: new Date(Date.UTC(2026, 9, 1, 10 - index)),
          }),
        ),
      );

      const page = await service.listQueue({ limit: 2 });

      expect(page.items.map((item) => item.commentId)).toEqual([
        ids[0],
        ids[1],
      ]);
      expect(page.nextCursor).toBe(
        encodeFeedCursor({
          pass: 0,
          createdAt: new Date(Date.UTC(2026, 9, 1, 9)),
          id: ids[1],
        }),
      );
    });

    it('continues after a cursor, and refuses one that is not a list cursor', async () => {
      const { service, reports } = setup();
      const cursor = encodeFeedCursor({
        pass: 0,
        createdAt: new Date('2026-10-01T09:00:00.000Z'),
        id: commentId,
      });

      await service.listQueue({ cursor, limit: 20 });

      expect(reports.listOpenGrouped).toHaveBeenCalledWith({
        after: {
          lastReportedAt: new Date('2026-10-01T09:00:00.000Z'),
          commentId,
        },
        limit: 20,
      });
      expect(
        await codeOf(service.listQueue({ cursor: 'garbage!', limit: 20 })),
      ).toBe('INVALID_CURSOR');
    });

    it('shows a comment whose author is gone, with no author', async () => {
      const { service, reports } = setup();
      reports.listOpenGrouped.mockResolvedValue([group()]);
      const page = await service.listQueue({ limit: 20 });
      expect(page.items[0].author).toBeNull();
    });
  });

  describe('remove', () => {
    it("deletes the comment as the operator, on the comment's own reel", async () => {
      const { service, commentsService } = setup();

      await expect(service.remove(commentId)).resolves.toEqual({
        id: commentId,
        action: 'remove',
      });

      expect(commentsService.deleteComment).toHaveBeenCalledWith(
        reelId,
        commentId,
        {
          operator: true,
        },
      );
    });

    it('is COMMENT_NOT_FOUND for a comment that is missing or already deleted', async () => {
      const { service, comments, commentsService } = setup();
      comments.findActiveById.mockResolvedValue(null);

      expect(await codeOf(service.remove(commentId))).toBe('COMMENT_NOT_FOUND');
      expect(commentsService.deleteComment).not.toHaveBeenCalled();
    });
  });

  describe('dismiss', () => {
    it('closes the open reports and keeps the comment', async () => {
      const { service, reports, commentsService } = setup();

      await expect(service.dismiss(commentId)).resolves.toEqual({
        id: commentId,
        action: 'dismiss',
      });

      expect(reports.dismissOpen).toHaveBeenCalledWith(commentId);
      expect(commentsService.deleteComment).not.toHaveBeenCalled();
    });

    it('is safe to repeat: nothing open is still a success', async () => {
      const { service, reports } = setup();
      reports.dismissOpen.mockResolvedValue(0);
      await expect(service.dismiss(commentId)).resolves.toBeDefined();
    });

    it('is COMMENT_NOT_FOUND for a comment that is not there', async () => {
      const { service, comments } = setup();
      comments.findActiveById.mockResolvedValue(null);
      expect(await codeOf(service.dismiss(commentId))).toBe(
        'COMMENT_NOT_FOUND',
      );
    });
  });

  it('knows its error types', () => {
    expect(NotFoundException).toBeDefined();
  });
});
