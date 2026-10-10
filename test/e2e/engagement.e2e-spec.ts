import { Types } from 'mongoose';
import { LimitsService } from '../../src/common/config/limits';
import { NotificationEventType } from '../../src/modules/reels/schemas/notification-event.schema';
import type {
  CommentDto,
  Page,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import {
  createPublishedReel,
  notificationEventModel,
  reelModel,
  runSync,
} from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';
import { issueToken } from '../utils/tokens';

interface CommentPage {
  items: CommentDto[];
  nextCursor: string | null;
  commentsCount: number;
}

/** FR-040 to FR-042 and the comment rules of FR-008: likes, comments, saves, shares. */
describe('Engagement (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const customer = () => createPerson(testApp, 'customer');
  const seller = () => createPerson(testApp, 'seller');
  const ids = (page: Page<{ id: string }>) => page.items.map((item) => item.id);
  const reelOf = (creator: Person) =>
    createPublishedReel(testApp, creator.externalId);

  const comment = (who: Person, reelId: string, text: string) =>
    api().post<{ comment: CommentDto; commentsCount: number }>(
      `/api/reels/${reelId}/comments`,
      { token: who.token, body: { text } },
    );
  const comments = (reelId: string, who?: { token: string }, query = {}) =>
    api().get<CommentPage>(`/api/reels/${reelId}/comments`, {
      token: who?.token,
      query,
    });
  const deleteComment = (
    who: { token: string },
    reelId: string,
    commentId: string,
  ) =>
    api().delete<{ deleted: boolean }>(
      `/api/reels/${reelId}/comments/${commentId}`,
      { token: who.token },
    );
  const commentsCount = async (reelId: string) =>
    (await reelModel(testApp).findById(reelId).exec())?.commentsCount;

  describe('likes', () => {
    it('toggles by one each way, and re-liking sends no second notification', async () => {
      const creator = await seller();
      const fan = await customer();
      const reel = await reelOf(creator);
      const toggle = () =>
        api().post<{ liked: boolean; likesCount: number }>(
          `/api/reels/${reel.id}/like`,
          { token: fan.token },
        );
      const likeEvents = () =>
        notificationEventModel(testApp)
          .find({
            type: NotificationEventType.REEL_LIKE,
            reelId: new Types.ObjectId(reel.id),
          })
          .exec();

      const first = await toggle();
      expect(first.data).toEqual({ liked: true, likesCount: 1 });
      expect(await likeEvents()).toHaveLength(1);

      const second = await toggle();
      expect(second.data).toEqual({ liked: false, likesCount: 0 });

      const third = await toggle();
      expect(third.data).toEqual({ liked: true, likesCount: 1 });
      // Liking again after undoing it is not news (FR-054).
      expect(await likeEvents()).toHaveLength(1);
    });
  });

  describe('comments', () => {
    it('come back newest first and page by cursor without a repeat or a gap', async () => {
      const creator = await seller();
      const reader = await customer();
      const author = await customer();
      const reel = await reelOf(creator);
      const posted: string[] = [];
      for (let i = 1; i <= 12; i += 1) {
        posted.push(
          (await comment(author, reel.id, `comment ${i}`)).data.comment.id,
        );
      }
      const newestFirst = [...posted].reverse();

      const collected: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = await comments(reel.id, reader, {
          limit: 5,
          cursor: cursor ?? undefined,
        });
        expect(page.status).toBe(200);
        expect(page.data.commentsCount).toBe(12);
        collected.push(...ids(page.data));
        cursor = page.data.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(collected).toEqual(newestFirst);
      expect(pages).toBe(3);
    });

    it('are paged by default and clamped to the maximum', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const limits = testApp.app.get(LimitsService);
      const total = limits.clampPageSize('comments', 1_000) + 3;
      for (let i = 0; i < total; i += 1) {
        await comment(author, reel.id, `c${i}`);
      }

      const byDefault = await comments(reel.id, author);
      expect(byDefault.data.items).toHaveLength(
        limits.clampPageSize('comments'),
      );
      const clamped = await comments(reel.id, author, { limit: 100 });
      expect(clamped.data.items).toHaveLength(50);
    });

    it.each([
      ['an empty comment', ''],
      ['a comment of only whitespace', '   \n  '],
    ])('refuses %s', async (_label, text) => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);

      const res = await comment(author, reel.id, text);
      expect([res.status, res.error]).toEqual([400, 'VALIDATION_FAILED']);
      expect(await commentsCount(reel.id)).toBe(0);
    });

    it('refuses a comment over the length limit, and accepts one at it', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const max = testApp.app.get(LimitsService).maxCommentLength;

      const over = await comment(author, reel.id, 'x'.repeat(max + 1));
      expect([over.status, over.error]).toEqual([400, 'VALIDATION_FAILED']);
      const exact = await comment(author, reel.id, 'x'.repeat(max));
      expect(exact.status).toBe(201);
    });
  });

  describe('saves and shares', () => {
    it('keep saves private: nobody else sees them, and there is no public count (FR-041)', async () => {
      const creator = await seller();
      const saver = await customer();
      const other = await customer();
      const reel = await reelOf(creator);

      await api().post(`/api/reels/${reel.id}/save`, { token: saver.token });

      const seenByOther = await api().get<ReelDto>(`/api/reels/${reel.id}`, {
        token: other.token,
      });
      expect(seenByOther.data.viewerSaved).toBe(false);
      expect(
        Object.keys(seenByOther.data).filter((key) => /save/i.test(key)),
      ).toEqual(['viewerSaved']);
      const otherList = await api().get<Page<ReelDto>>('/api/reels/saved', {
        token: other.token,
      });
      expect(otherList.data.items).toEqual([]);
      const ownList = await api().get<Page<ReelDto>>('/api/reels/saved', {
        token: saver.token,
      });
      expect(ids(ownList.data)).toEqual([reel.id]);
    });

    it('count each Copy Link as a share (EP15)', async () => {
      const creator = await seller();
      const sharer = await customer();
      const reel = await reelOf(creator);

      const first = await api().post<{ sharesCount: number }>(
        `/api/reels/${reel.id}/share`,
        { token: sharer.token },
      );
      const second = await api().post<{ sharesCount: number }>(
        `/api/reels/${reel.id}/share`,
        { token: sharer.token },
      );
      expect([first.data.sharesCount, second.data.sharesCount]).toEqual([1, 2]);
    });
  });

  describe('the Liked and Saved lists', () => {
    it('leave out a reel that is no longer published, and bring it back if it is', async () => {
      const creator = await seller();
      const fan = await customer();
      const kept = await reelOf(creator);
      const gone = await reelOf(creator);
      for (const reel of [kept, gone]) {
        await api().post(`/api/reels/${reel.id}/like`, { token: fan.token });
        await api().post(`/api/reels/${reel.id}/save`, { token: fan.token });
      }
      const lists = async () => [
        ids(
          (
            await api().get<Page<ReelDto>>('/api/reels/liked', {
              token: fan.token,
            })
          ).data,
        ),
        ids(
          (
            await api().get<Page<ReelDto>>('/api/reels/saved', {
              token: fan.token,
            })
          ).data,
        ),
      ];
      // Newest relation first.
      expect(await lists()).toEqual([
        [gone.id, kept.id],
        [gone.id, kept.id],
      ]);

      await reelModel(testApp).updateOne(
        { _id: gone.id },
        { $set: { status: 'hidden' } },
      );
      expect(await lists()).toEqual([[kept.id], [kept.id]]);

      await reelModel(testApp).updateOne(
        { _id: gone.id },
        { $set: { status: 'published' } },
      );
      expect(await lists()).toEqual([
        [gone.id, kept.id],
        [gone.id, kept.id],
      ]);
    });

    it('page by cursor without a repeat or a gap, and end', async () => {
      const creator = await seller();
      const fan = await customer();
      const liked: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const reel = await reelOf(creator);
        await api().post(`/api/reels/${reel.id}/like`, { token: fan.token });
        liked.push(reel.id);
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = await api().get<Page<ReelDto>>('/api/reels/liked', {
          token: fan.token,
          query: { limit: 3, cursor: cursor ?? undefined },
        });
        expect(page.status).toBe(200);
        collected.push(...ids(page.data));
        cursor = page.data.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(collected).toEqual([...liked].reverse());
      expect(pages).toBe(3);
    });
  });

  describe('deleting a comment (EP22)', () => {
    it('by its author takes the count down once', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const posted = await comment(author, reel.id, 'to be deleted');
      expect(await commentsCount(reel.id)).toBe(1);

      const res = await deleteComment(author, reel.id, posted.data.comment.id);

      expect([res.status, res.data.deleted]).toEqual([200, true]);
      expect(await commentsCount(reel.id)).toBe(0);
      expect((await comments(reel.id, author)).data.items).toEqual([]);
    });

    it("by the reel's owner takes the count down once, whoever wrote it", async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const posted = await comment(author, reel.id, 'someone else wrote this');

      const res = await deleteComment(creator, reel.id, posted.data.comment.id);

      expect(res.status).toBe(200);
      expect(await commentsCount(reel.id)).toBe(0);
    });

    it('by anyone else is refused', async () => {
      const creator = await seller();
      const author = await customer();
      const bystander = await customer();
      const otherSeller = await seller();
      const reel = await reelOf(creator);
      const posted = await comment(author, reel.id, 'not yours to remove');
      const pendingSeller = {
        token: await issueToken(testApp.infra, 'seller', 3),
      };

      for (const who of [bystander, otherSeller, pendingSeller]) {
        const res = await deleteComment(who, reel.id, posted.data.comment.id);
        expect([res.status, res.error]).toEqual([403, 'COMMENT_NOT_DELETABLE']);
      }
      expect(await commentsCount(reel.id)).toBe(1);
    });

    it('answers 404 for a comment that is already deleted, or never was', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const posted = await comment(author, reel.id, 'once');
      await deleteComment(author, reel.id, posted.data.comment.id);

      const again = await deleteComment(
        author,
        reel.id,
        posted.data.comment.id,
      );
      expect([again.status, again.error]).toEqual([404, 'COMMENT_NOT_FOUND']);
      const never = await deleteComment(
        author,
        reel.id,
        new Types.ObjectId().toString(),
      );
      expect([never.status, never.error]).toEqual([404, 'COMMENT_NOT_FOUND']);
      // A comment id that belongs to another reel is not found on this one.
      const otherReel = await reelOf(creator);
      const elsewhere = await comment(author, otherReel.id, 'on another reel');
      const wrongReel = await deleteComment(
        author,
        reel.id,
        elsewhere.data.comment.id,
      );
      expect([wrongReel.status, wrongReel.error]).toEqual([
        404,
        'COMMENT_NOT_FOUND',
      ]);
    });

    it('under five at once takes the count down exactly once', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      await comment(author, reel.id, 'a bystander comment');
      const posted = await comment(author, reel.id, 'deleted five times');
      expect(await commentsCount(reel.id)).toBe(2);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          deleteComment(author, reel.id, posted.data.comment.id),
        ),
      );

      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(
        results.filter(
          (res) => res.status === 404 && res.error === 'COMMENT_NOT_FOUND',
        ),
      ).toHaveLength(4);
      expect(await commentsCount(reel.id)).toBe(1);
    });

    it('is also once when the author and the owner delete at the same moment', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const posted = await comment(author, reel.id, 'two deleters');

      const results = await Promise.all([
        deleteComment(author, reel.id, posted.data.comment.id),
        deleteComment(creator, reel.id, posted.data.comment.id),
      ]);

      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(await commentsCount(reel.id)).toBe(0);
    });
  });

  describe('standing (FR-008)', () => {
    it('lets an author out of good standing delete their own comment, but not write a new one', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const posted = await comment(author, reel.id, 'written in good standing');

      await testApp.infra.rootQuery(
        'UPDATE customers SET status = 0 WHERE id = ?',
        [author.externalId],
      );
      await runSync(testApp);

      const blocked = await comment(author, reel.id, 'a new one');
      expect([blocked.status, blocked.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
      const removed = await deleteComment(
        author,
        reel.id,
        posted.data.comment.id,
      );
      expect(removed.status).toBe(200);
      expect(await commentsCount(reel.id)).toBe(0);
    });

    it("needs a suspended reel owner to be in good standing to delete someone else's comment", async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);
      const posted = await comment(
        author,
        reel.id,
        "on a suspended seller's reel",
      );

      await testApp.infra.rootQuery(
        "UPDATE sellers SET status = 'suspended' WHERE id = ?",
        [creator.externalId],
      );
      await runSync(testApp);

      const res = await deleteComment(creator, reel.id, posted.data.comment.id);
      expect([res.status, res.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
      // The reel is out of view for everyone else now, so the count has not moved.
      expect(await commentsCount(reel.id)).toBe(1);
    });
  });

  describe('what a viewer may do with a comment (viewerCanDelete, viewerCanReport)', () => {
    it('is right for the author, the reel owner, another user and a guest', async () => {
      const creator = await seller();
      const author = await customer();
      const other = await customer();
      const reel = await reelOf(creator);
      await comment(author, reel.id, 'who can do what');

      const flagsFor = async (who?: Person) => {
        const [item] = (await comments(reel.id, who)).data.items;
        return [item.viewerCanDelete, item.viewerCanReport];
      };

      expect(await flagsFor(author)).toEqual([true, false]);
      expect(await flagsFor(creator)).toEqual([true, true]);
      expect(await flagsFor(other)).toEqual([false, true]);
      expect(await flagsFor(undefined)).toEqual([false, false]);
    });

    it('is also right on the comment just posted', async () => {
      const creator = await seller();
      const author = await customer();
      const reel = await reelOf(creator);

      const posted = await comment(author, reel.id, 'just now');
      expect(posted.data.comment.viewerCanDelete).toBe(true);
      expect(posted.data.comment.viewerCanReport).toBe(false);
    });
  });

  describe('the write limit', () => {
    let limited: TestApp;

    beforeAll(async () => {
      limited = await createTestApp({
        env: { WRITE_RATE_LIMIT_PER_MINUTE: '3' },
      });
    }, 120_000);

    afterAll(async () => {
      await limited.close();
    });

    it('stops the fourth comment of a minute with 429 RATE_LIMITED', async () => {
      const creator = await createPerson(limited, 'seller');
      const author = await createPerson(limited, 'customer');
      const reel = await createPublishedReel(limited, creator.externalId);
      const post = () =>
        limited.api.post(`/api/reels/${reel.id}/comments`, {
          token: author.token,
          body: { text: 'again' },
        });

      for (let i = 1; i <= 3; i += 1) {
        expect([i, (await post()).status]).toEqual([i, 201]);
      }
      const fourth = await post();
      expect([fourth.status, fourth.error]).toEqual([429, 'RATE_LIMITED']);
    });
  });
});
