import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { LimitsService } from '../../src/common/config/limits';
import { QUEUE_MEDIA_VISIBILITY } from '../../src/common/queues/queue-names';
import { StorageService } from '../../src/common/storage/storage.service';
import type {
  CommentDto,
  Page,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { ADMIN_KEY, createTestApp, TestApp } from '../utils/app';
import {
  createPublishedReel,
  drainQueue,
  reelModel,
  runSync,
} from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';

const THRESHOLD = 3;
const DAILY_LIMIT = 3;

interface QueueItem {
  commentId: string;
  reelId: string;
  text: string;
  author: { id: string; username: string; accountType: string };
  openReportsCount: number;
  lastReportedAt: string;
  reports: Array<{
    reporterId: string;
    reason: string;
    customReason: string | null;
    createdAt: string;
  }>;
}

/** FR-052 to FR-059 and research R16: reports, auto-hide, and the operator's queues. */
describe('Moderation (e2e)', () => {
  let testApp: TestApp;
  let storage: StorageService;

  beforeAll(async () => {
    testApp = await createTestApp({
      env: {
        REEL_REPORT_AUTOHIDE_THRESHOLD: String(THRESHOLD),
        REEL_REPORT_DAILY_LIMIT: String(DAILY_LIMIT),
      },
    });
    storage = testApp.app.get(StorageService);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const customer = () => createPerson(testApp, 'customer');
  const seller = () => createPerson(testApp, 'seller');
  const publicCopy = (reelId: string) =>
    storage.head(storage.publicBucket, `reels/${reelId}/video.mp4`);

  const reportReel = (
    who: Person,
    reelId: string,
    body: Record<string, unknown> = { reason: 'spam' },
  ) =>
    api().post<{ reported: boolean; alreadyReported: boolean }>(
      `/api/reels/${reelId}/report`,
      { token: who.token, body },
    );
  const reportComment = (
    who: Person,
    reelId: string,
    commentId: string,
    body: Record<string, unknown> = { reason: 'spam' },
  ) =>
    api().post<{ reported: boolean; alreadyReported: boolean }>(
      `/api/reels/${reelId}/comments/${commentId}/report`,
      { token: who.token, body },
    );
  const commentOn = async (who: Person, reelId: string, text = 'a comment') =>
    (
      await api().post<{ comment: CommentDto }>(
        `/api/reels/${reelId}/comments`,
        {
          token: who.token,
          body: { text },
        },
      )
    ).data.comment.id;
  const hideByReports = async (reelId: string) => {
    for (let i = 0; i < THRESHOLD; i += 1) {
      expect((await reportReel(await customer(), reelId)).status).toBe(201);
    }
  };
  const queue = () =>
    api().get<Page<QueueItem>>('/api/reels/moderation/comments', {
      adminKey: ADMIN_KEY,
      query: { limit: 50 },
    });
  const moderateComment = (commentId: string, action: string) =>
    api().patch(`/api/reels/comments/${commentId}/moderation`, {
      adminKey: ADMIN_KEY,
      body: { action },
    });
  const moderateReel = (reelId: string, action: string) =>
    api().patch<{ id: string; status: string }>(
      `/api/reels/${reelId}/moderation`,
      {
        adminKey: ADMIN_KEY,
        body: { action },
      },
    );

  describe('reporting a reel (FR-053)', () => {
    it('needs text for "other", and refuses text over the limit', async () => {
      const creator = await seller();
      const reporter = await customer();
      const reel = await createPublishedReel(testApp, creator.externalId);
      const max = testApp.app.get(LimitsService).maxReportReasonLength;

      const missing = await reportReel(reporter, reel.id, { reason: 'other' });
      expect([missing.status, missing.error]).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
      const tooLong = await reportReel(reporter, reel.id, {
        reason: 'other',
        customReason: 'x'.repeat(max + 1),
      });
      expect([tooLong.status, tooLong.error]).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
      const unknownReason = await reportReel(reporter, reel.id, {
        reason: 'boring',
      });
      expect(unknownReason.status).toBe(400);

      const fine = await reportReel(reporter, reel.id, {
        reason: 'other',
        customReason: 'x'.repeat(max),
      });
      expect(fine.status).toBe(201);
    });

    it('treats a repeat as a quiet success, and never counts it twice', async () => {
      const creator = await seller();
      const reporter = await customer();
      const reel = await createPublishedReel(testApp, creator.externalId);

      const first = await reportReel(reporter, reel.id);
      const repeat = await reportReel(reporter, reel.id);

      expect(first.data).toEqual({ reported: true, alreadyReported: false });
      expect(repeat.data).toEqual({ reported: true, alreadyReported: true });
      expect(
        (await reelModel(testApp).findById(reel.id).exec())?.reportsCount,
      ).toBe(1);
    });
  });

  describe('the shared daily limit (FR-055)', () => {
    it('counts reel reports and comment reports together, and a repeat stays a quiet success', async () => {
      const creator = await seller();
      const author = await customer();
      const reporter = await customer();
      const reels = [
        await createPublishedReel(testApp, creator.externalId),
        await createPublishedReel(testApp, creator.externalId),
      ];
      const commentIds = [
        await commentOn(author, reels[0].id, 'first'),
        await commentOn(author, reels[0].id, 'second'),
      ];

      expect((await reportReel(reporter, reels[0].id)).status).toBe(201);
      expect((await reportReel(reporter, reels[1].id)).status).toBe(201);
      expect(
        (await reportComment(reporter, reels[0].id, commentIds[0])).status,
      ).toBe(201);

      // The limit is three, whichever kind. A fourth of either kind is refused...
      const comment = await reportComment(reporter, reels[0].id, commentIds[1]);
      expect([comment.status, comment.error]).toEqual([
        429,
        'REPORT_DAILY_LIMIT',
      ]);
      const third = await createPublishedReel(testApp, creator.externalId);
      const reel = await reportReel(reporter, third.id);
      expect([reel.status, reel.error]).toEqual([429, 'REPORT_DAILY_LIMIT']);
      // ...and records nothing.
      expect(
        (await reelModel(testApp).findById(third.id).exec())?.reportsCount,
      ).toBe(0);

      // Saying it again is not a new report, so it is not refused.
      const repeatReel = await reportReel(reporter, reels[0].id);
      expect([repeatReel.status, repeatReel.data.alreadyReported]).toEqual([
        201,
        true,
      ]);
      const repeatComment = await reportComment(
        reporter,
        reels[0].id,
        commentIds[0],
      );
      expect([
        repeatComment.status,
        repeatComment.data.alreadyReported,
      ]).toEqual([201, true]);
    });
  });

  describe('auto-hide (FR-056, FR-058)', () => {
    it('hides a reel at the threshold, takes down its public file, and shows the owner it is hidden', async () => {
      const creator = await seller();
      const viewer = await customer();
      const reel = await createPublishedReel(testApp, creator.externalId);
      expect(await publicCopy(reel.id)).not.toBeNull();

      await hideByReports(reel.id);

      const stranger = await api().get(`/api/reels/${reel.id}`, {
        token: viewer.token,
      });
      expect(stranger.status).toBe(404);
      const own = await api().get<ReelDto>(`/api/reels/${reel.id}`, {
        token: creator.token,
      });
      expect(own.data.status).toBe('hidden');
      expect(await publicCopy(reel.id)).toBeNull();
    });

    it('brings the public file back on restore, and more reports never hide it again', async () => {
      const creator = await seller();
      const reel = await createPublishedReel(testApp, creator.externalId);
      await hideByReports(reel.id);
      expect(await publicCopy(reel.id)).toBeNull();

      const restore = await moderateReel(reel.id, 'restore');
      expect([restore.status, restore.data.status]).toEqual([200, 'published']);
      expect(await publicCopy(reel.id)).not.toBeNull();

      await reportReel(await customer(), reel.id);
      await reportReel(await customer(), reel.id);
      const own = await api().get<ReelDto>(`/api/reels/${reel.id}`, {
        token: creator.token,
      });
      expect(own.data.status).toBe('published');
      expect(await publicCopy(reel.id)).not.toBeNull();
    });

    it('keeps the media private when a reel is restored while its creator is suspended', async () => {
      const creator = await seller();
      const reel = await createPublishedReel(testApp, creator.externalId);
      await hideByReports(reel.id);

      await testApp.infra.rootQuery(
        "UPDATE sellers SET status = 'suspended' WHERE id = ?",
        [creator.externalId],
      );
      await runSync(testApp);
      await drainQueue(testApp, QUEUE_MEDIA_VISIBILITY);

      const restore = await moderateReel(reel.id, 'restore');
      expect([restore.status, restore.data.status]).toEqual([200, 'published']);
      // Published, but the creator is out of good standing, so the file stays where it was.
      expect(await publicCopy(reel.id)).toBeNull();
      const doc = await reelModel(testApp).findById(reel.id).exec();
      expect(doc?.media.location).toBe('private');
    });

    it('lists a hidden reel for the operator, and a restore of a reel that is not hidden is a conflict', async () => {
      const creator = await seller();
      const reel = await createPublishedReel(testApp, creator.externalId);

      const early = await moderateReel(reel.id, 'restore');
      expect([early.status, early.error]).toEqual([409, 'REEL_NOT_HIDDEN']);

      await hideByReports(reel.id);
      const list = await api().get<Page<{ id: string; reportsCount: number }>>(
        '/api/reels/moderation/hidden',
        { adminKey: ADMIN_KEY, query: { limit: 50 } },
      );
      expect(
        list.data.items.find((item) => item.id === reel.id)?.reportsCount,
      ).toBe(THRESHOLD);
    });
  });

  describe('the operator surface (FR-059)', () => {
    it.each([
      ['the hidden reels', '/api/reels/moderation/hidden'],
      ['the reported comments', '/api/reels/moderation/comments'],
    ])('%s refuse a user session and accept the key', async (_label, path) => {
      const member = await customer();
      const noKey = await api().get(path, { token: member.token });
      expect([noKey.status, noKey.error]).toEqual([401, 'ADMIN_KEY_INVALID']);
      const wrongKey = await api().get(path, { adminKey: 'nope' });
      expect([wrongKey.status, wrongKey.error]).toEqual([
        401,
        'ADMIN_KEY_INVALID',
      ]);
      const ok = await api().get(path, { adminKey: ADMIN_KEY });
      expect(ok.status).toBe(200);
    });

    it('refuses a user session on the comment action too', async () => {
      const member = await customer();
      const res = await api().patch(
        `/api/reels/comments/${new Types.ObjectId().toString()}/moderation`,
        {
          token: member.token,
          body: { action: 'remove' },
        },
      );
      expect([res.status, res.error]).toEqual([401, 'ADMIN_KEY_INVALID']);
    });
  });

  describe('reporting a comment (EP23) and the operator queue (EP31, EP32)', () => {
    async function reportedComment() {
      const creator = await seller();
      const author = await customer();
      const reel = await createPublishedReel(testApp, creator.externalId);
      const commentId = await commentOn(
        author,
        reel.id,
        'a reportable comment',
      );
      return { creator, author, reel, commentId };
    }

    it('puts the comment in the queue, with who wrote it and who reported it', async () => {
      const { author, reel, commentId } = await reportedComment();
      const reporter = await customer();

      expect(
        (
          await reportComment(reporter, reel.id, commentId, {
            reason: 'other',
            customReason: 'rude',
          })
        ).status,
      ).toBe(201);

      const item = (await queue()).data.items.find(
        (entry) => entry.commentId === commentId,
      );
      expect(item).toMatchObject({
        commentId,
        reelId: reel.id,
        text: 'a reportable comment',
        author: { id: author.id, accountType: 'customer' },
        openReportsCount: 1,
      });
      expect(item?.reports).toEqual([
        expect.objectContaining({
          reporterId: reporter.id,
          reason: 'other',
          customReason: 'rude',
        }),
      ]);
      expect(typeof item?.lastReportedAt).toBe('string');
    });

    it('counts each reporter once, and lists the most recently reported comment first', async () => {
      const first = await reportedComment();
      const second = await reportedComment();
      await reportComment(await customer(), first.reel.id, first.commentId);
      await reportComment(await customer(), second.reel.id, second.commentId);
      await reportComment(await customer(), first.reel.id, first.commentId);

      const items = (await queue()).data.items;
      const positions = [first.commentId, second.commentId].map((id) =>
        items.findIndex((entry) => entry.commentId === id),
      );

      // `first` was reported last, so it is ahead of `second`.
      expect(positions[0]).toBeGreaterThanOrEqual(0);
      expect(positions[0]).toBeLessThan(positions[1]);
      expect(items[positions[0]].openReportsCount).toBe(2);
      expect(items[positions[1]].openReportsCount).toBe(1);
    });

    it('is refused for your own comment, and for a comment that is not there', async () => {
      const { author, reel, commentId } = await reportedComment();

      const own = await reportComment(author, reel.id, commentId);
      expect([own.status, own.error]).toEqual([
        400,
        'CANNOT_REPORT_OWN_COMMENT',
      ]);
      const missing = await reportComment(
        await customer(),
        reel.id,
        new Types.ObjectId().toString(),
      );
      expect([missing.status, missing.error]).toEqual([
        404,
        'COMMENT_NOT_FOUND',
      ]);
      const noReel = await reportComment(
        await customer(),
        new Types.ObjectId().toString(),
        commentId,
      );
      expect([noReel.status, noReel.error]).toEqual([404, 'REEL_NOT_FOUND']);
    });

    it('needs text for "other", like a reel report, and a session', async () => {
      const { reel, commentId } = await reportedComment();
      const reporter = await customer();

      const missing = await reportComment(reporter, reel.id, commentId, {
        reason: 'other',
      });
      expect([missing.status, missing.error]).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
      const anonymous = await api().post(
        `/api/reels/${reel.id}/comments/${commentId}/report`,
        {
          body: { reason: 'spam' },
        },
      );
      expect([anonymous.status, anonymous.error]).toEqual([
        401,
        'AUTH_REQUIRED',
      ]);
    });

    it('is a quiet success to report a comment again', async () => {
      const { reel, commentId } = await reportedComment();
      const reporter = await customer();

      const first = await reportComment(reporter, reel.id, commentId);
      const repeat = await reportComment(reporter, reel.id, commentId);

      expect(first.data.alreadyReported).toBe(false);
      expect(repeat.data.alreadyReported).toBe(true);
      const item = (await queue()).data.items.find(
        (entry) => entry.commentId === commentId,
      );
      expect(item?.openReportsCount).toBe(1);
    });

    it('is not possible on a reel the reporter cannot see', async () => {
      const { creator, reel, commentId } = await reportedComment();
      const reporter = await customer();
      await api().post(`/api/users/${creator.id}/block`, {
        token: reporter.token,
      });

      const res = await reportComment(reporter, reel.id, commentId);

      expect([res.status, res.error]).toEqual([404, 'REEL_NOT_FOUND']);
    });

    it('is removed by the operator: soft-deleted, the count goes down, and it leaves the queue', async () => {
      const { reel, commentId } = await reportedComment();
      await reportComment(await customer(), reel.id, commentId);
      expect(
        (await reelModel(testApp).findById(reel.id).exec())?.commentsCount,
      ).toBe(1);

      const res = await moderateComment(commentId, 'remove');

      expect(res.status).toBe(200);
      expect(
        (await reelModel(testApp).findById(reel.id).exec())?.commentsCount,
      ).toBe(0);
      expect(
        (await queue()).data.items.some(
          (entry) => entry.commentId === commentId,
        ),
      ).toBe(false);
      // Kept for audit, never served.
      const stored = await testApp.app
        .get<Connection>(getConnectionToken())
        .db?.collection('reel_comments')
        .findOne({ _id: new Types.ObjectId(commentId) });
      expect(stored?.deletedByRole).toBe('operator');
      const read = await api().get<{ items: CommentDto[] }>(
        `/api/reels/${reel.id}/comments`,
      );
      expect(read.data.items.map((item) => item.id)).not.toContain(commentId);
    });

    it('is dismissed by the operator: kept, and off the list until someone new reports it', async () => {
      const { reel, commentId } = await reportedComment();
      await reportComment(await customer(), reel.id, commentId);

      const res = await moderateComment(commentId, 'dismiss');

      expect(res.status).toBe(200);
      expect(
        (await reelModel(testApp).findById(reel.id).exec())?.commentsCount,
      ).toBe(1);
      expect(
        (await queue()).data.items.some(
          (entry) => entry.commentId === commentId,
        ),
      ).toBe(false);
      const read = await api().get<{ items: CommentDto[] }>(
        `/api/reels/${reel.id}/comments`,
      );
      expect(read.data.items.map((item) => item.id)).toContain(commentId);

      // A new reporter puts it back, with only the new report open.
      await reportComment(await customer(), reel.id, commentId);
      const item = (await queue()).data.items.find(
        (entry) => entry.commentId === commentId,
      );
      expect(item?.openReportsCount).toBe(1);
    });

    it('answers 404 for an action on a comment that is not there or already removed', async () => {
      const { reel, commentId } = await reportedComment();
      await reportComment(await customer(), reel.id, commentId);
      await moderateComment(commentId, 'remove');

      for (const id of [
        commentId,
        new Types.ObjectId().toString(),
        'not-an-id',
      ]) {
        const res = await moderateComment(id, 'remove');
        expect([id, res.status, res.error]).toEqual([
          id,
          404,
          'COMMENT_NOT_FOUND',
        ]);
      }
    });

    it('refuses an action that is not remove or dismiss', async () => {
      const { commentId } = await reportedComment();
      const res = await moderateComment(commentId, 'ban');
      expect([res.status, res.error]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('pages by cursor, newest report first, with no repeat', async () => {
      const made: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const { reel, commentId } = await reportedComment();
        await reportComment(await customer(), reel.id, commentId);
        made.push(commentId);
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      let guard = 0;
      do {
        const res = await api().get<Page<QueueItem>>(
          '/api/reels/moderation/comments',
          {
            adminKey: ADMIN_KEY,
            query: { limit: 2, cursor: cursor ?? undefined },
          },
        );
        expect(res.status).toBe(200);
        collected.push(...res.data.items.map((item) => item.commentId));
        cursor = res.data.nextCursor;
        guard += 1;
      } while (cursor !== null && guard < 50);

      expect(new Set(collected).size).toBe(collected.length);
      const mine = collected.filter((id) => made.includes(id));
      expect(mine).toEqual([...made].reverse());
    });
  });

  describe('retention (R16)', () => {
    it('removes the reports with the reel when its owner deletes it', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await createPublishedReel(testApp, creator.externalId);
      const commentId = await commentOn(author, reel.id);
      await reportReel(await customer(), reel.id);
      await reportComment(await customer(), reel.id, commentId);
      const db = testApp.app.get<Connection>(getConnectionToken()).db;
      const count = async (collection: string) =>
        db
          ?.collection(collection)
          .countDocuments({ videoId: new Types.ObjectId(reel.id) });
      expect(await count('reel_reports')).toBe(1);
      expect(await count('reel_comment_reports')).toBe(1);

      const deleted = await api().delete(`/api/reels/${reel.id}`, {
        token: creator.token,
      });

      expect(deleted.status).toBe(200);
      expect(await count('reel_reports')).toBe(0);
      expect(await count('reel_comment_reports')).toBe(0);
      expect(await count('reel_comments')).toBe(0);
    });

    it('keeps the reports through hiding and restoring', async () => {
      const creator = await seller();
      const reel = await createPublishedReel(testApp, creator.externalId);
      await hideByReports(reel.id);
      await moderateReel(reel.id, 'restore');

      const reports = await testApp.app
        .get<Connection>(getConnectionToken())
        .db?.collection('reel_reports')
        .countDocuments({ videoId: new Types.ObjectId(reel.id) });
      expect(reports).toBe(THRESHOLD);
    });
  });
});
