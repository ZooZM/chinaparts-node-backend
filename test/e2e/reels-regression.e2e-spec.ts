import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { QUEUE_REELS_MODERATION } from '../../src/common/queues/queue-names';
import { ReelsModerationService } from '../../src/modules/reels/reels-moderation.service';
import { NotificationEventType } from '../../src/modules/reels/schemas/notification-event.schema';
import type {
  AdminHiddenReelDto,
  CommentDto,
  CreatorProfileDto,
  FollowedUserDto,
  Page,
  ReelDto,
  UserSearchResultDto,
} from '../../src/modules/reels/reels.repository';
import { ADMIN_KEY, createTestApp, TestApp } from '../utils/app';
import {
  createPublishedReel,
  createReel,
  notificationEventModel,
  reelModel,
  SAMPLE_10S,
  SAMPLE_70S,
} from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';

/**
 * The behaviors the Ciro reels module's own end-to-end spec protected (`test/reels.e2e-spec.ts`),
 * ported to this service so the fork cannot quietly lose any of them. The assertions are the same
 * wherever the behavior is the same. What changed, and why:
 *
 * - Identity. Ciro signed a JWT for a `User` document. Here every caller is a China Parts account
 *   with a Sanctum session (`createPerson`), and the author of a reel is a seller, because only
 *   sellers publish (FR-025).
 * - Content. Ciro's spec relied on a seeded demo catalog. This one creates what it needs, so no
 *   test depends on data it did not make.
 * - Envelope. Responses are `{ success, data, message }`, and errors carry a sentinel (`error`).
 *   An assertion on a bare status becomes one on the sentinel as well.
 * - Guests. Ciro rejected a signed-out feed request. Signed-out visitors may now read (FR-004),
 *   so that test asserts the new rule. The public Reposts list and the reposters sheet followed.
 * - Cursors. Nothing here assumes how a cursor is built (R9 changes it), only that passing back
 *   `nextCursor` continues the list.
 * - Dropped: nothing in Ciro's spec exercised sending a reel to a chat, so there was no such
 *   assertion to drop. This service has no chat, and sharing is Copy Link only (FR-042), which the
 *   walk-through below still covers as a counter.
 *
 * Screening is driven by hand (`moderateReel`) with the queue paused, exactly as Ciro's spec did,
 * so a test never races the worker. The worker itself is covered by the moderation suites.
 */
/** Small, so a report test needs only a few accounts. */
const AUTOHIDE_THRESHOLD = 3;
const REPORT_DAILY_LIMIT = 2;

describe('Reels regression, ported from the Ciro spec (e2e)', () => {
  let testApp: TestApp;
  let moderation: ReelsModerationService;

  beforeAll(async () => {
    testApp = await createTestApp({
      env: {
        REEL_REPORT_AUTOHIDE_THRESHOLD: String(AUTOHIDE_THRESHOLD),
        REEL_REPORT_DAILY_LIMIT: String(REPORT_DAILY_LIMIT),
      },
    });
    moderation = testApp.app.get(ReelsModerationService);
    await testApp.app.get<Queue>(getQueueToken(QUEUE_REELS_MODERATION)).pause();
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const customer = (name?: string) =>
    createPerson(testApp, 'customer', name ? { firstName: name } : {});
  const seller = (name?: string) =>
    createPerson(testApp, 'seller', name ? { firstName: name } : {});
  const ids = (page: Page<{ id: string }>) => page.items.map((i) => i.id);

  /** Everyone's reels are searchable under this seller's handle. */
  async function reelBy(
    creator: Person,
    options: Parameters<typeof createPublishedReel>[2] = {},
  ) {
    return createPublishedReel(testApp, creator.externalId, options);
  }

  describe('who may call', () => {
    it('lets a signed-out visitor read the feed (FR-004; Ciro rejected this)', async () => {
      const res = await api().get('/api/reels');
      expect(res.status).toBe(200);
    });

    it('rejects a like with no session', async () => {
      const res = await api().post('/api/reels/000000000000000000000000/like');
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_REQUIRED');
    });
  });

  describe('walk-through: feed, like, view, save, comment, share, profile, follow', () => {
    it('works end to end with a real session', async () => {
      const creator = await seller('Walkthrough');
      const viewer = await customer();
      for (let i = 0; i < 6; i += 1) {
        await reelBy(creator, {
          description: `walk-through reel ${i}`,
          hashtags: ['travel'],
        });
      }

      const feed = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { limit: 5 },
      });
      expect(feed.status).toBe(200);
      expect(feed.data.items).toHaveLength(5);
      expect(feed.data.nextCursor).not.toBeNull();
      expect(feed.data.items[0].creator.username).toEqual(expect.any(String));
      expect(Array.isArray(feed.data.items[0].hashtags)).toBe(true);
      const reelId = feed.data.items[0].id;
      const creatorId = feed.data.items[0].creator.id;

      const single = await api().get<ReelDto>(`/api/reels/${reelId}`, {
        token: viewer.token,
      });
      expect(single.status).toBe(200);
      expect(single.data.id).toBe(reelId);
      expect(single.data.viewerSaved).toBe(false);

      const like = await api().post<{ liked: boolean }>(
        `/api/reels/${reelId}/like`,
        { token: viewer.token },
      );
      expect(like.status).toBe(201);
      expect(like.data.liked).toBe(true);

      const view = await api().post<{ viewsCount: number }>(
        `/api/reels/${reelId}/view`,
        { token: viewer.token },
      );
      expect(view.status).toBe(201);
      const viewAgain = await api().post<{ viewsCount: number }>(
        `/api/reels/${reelId}/view`,
        { token: viewer.token },
      );
      // FR-048: a second view by the same account does not count.
      expect(viewAgain.data.viewsCount).toBe(view.data.viewsCount);

      const save = await api().post<{ saved: boolean }>(
        `/api/reels/${reelId}/save`,
        { token: viewer.token },
      );
      expect(save.data.saved).toBe(true);

      const saved = await api().get<Page<ReelDto>>('/api/reels/saved', {
        token: viewer.token,
      });
      expect(ids(saved.data)).toContain(reelId);
      const liked = await api().get<Page<ReelDto>>('/api/reels/liked', {
        token: viewer.token,
      });
      expect(ids(liked.data)).toContain(reelId);

      const comment = await api().post<{ comment: CommentDto }>(
        `/api/reels/${reelId}/comments`,
        { token: viewer.token, body: { text: 'Great reel!' } },
      );
      expect(comment.status).toBe(201);
      expect(comment.data.comment.text).toBe('Great reel!');

      const share = await api().post<{ sharesCount: number }>(
        `/api/reels/${reelId}/share`,
        { token: viewer.token },
      );
      expect(share.data.sharesCount).toBeGreaterThan(0);

      const profile = await api().get<CreatorProfileDto>(
        `/api/users/${creatorId}/profile`,
        { token: viewer.token },
      );
      expect(profile.data.user.id).toBe(creatorId);

      const followersBefore = profile.data.stats.followers;
      const follow = await api().post<{
        following: boolean;
        followersCount: number;
      }>(`/api/users/${creatorId}/follow`, { token: viewer.token });
      expect(follow.data.following).toBe(true);
      expect(follow.data.followersCount).toBe(followersBefore + 1);
    });

    it('rejects an empty comment', async () => {
      const creator = await seller();
      const viewer = await customer();
      const reel = await reelBy(creator);

      const res = await api().post(`/api/reels/${reel.id}/comments`, {
        token: viewer.token,
        body: { text: '   ' },
      });
      expect(res.status).toBe(400);
      expect(res.error).toBe('VALIDATION_FAILED');
    });
  });

  describe('counter integrity (FR-055)', () => {
    it('double-toggling like, save and follow returns every counter to its baseline', async () => {
      const creator = await seller();
      const viewer = await customer();
      const reel = await reelBy(creator);

      const before = await api().get<ReelDto>(`/api/reels/${reel.id}`, {
        token: viewer.token,
      });
      const profileBefore = await api().get<CreatorProfileDto>(
        `/api/users/${creator.id}/profile`,
        { token: viewer.token },
      );

      const like1 = await api().post<{ liked: boolean; likesCount: number }>(
        `/api/reels/${reel.id}/like`,
        { token: viewer.token },
      );
      expect(like1.data.liked).toBe(true);
      const like2 = await api().post<{ liked: boolean; likesCount: number }>(
        `/api/reels/${reel.id}/like`,
        { token: viewer.token },
      );
      expect(like2.data.liked).toBe(false);
      expect(like2.data.likesCount).toBe(before.data.likesCount);

      const save1 = await api().post<{ saved: boolean }>(
        `/api/reels/${reel.id}/save`,
        { token: viewer.token },
      );
      expect(save1.data.saved).toBe(true);
      const save2 = await api().post<{ saved: boolean }>(
        `/api/reels/${reel.id}/save`,
        { token: viewer.token },
      );
      expect(save2.data.saved).toBe(false);

      const follow1 = await api().post<{ following: boolean }>(
        `/api/users/${creator.id}/follow`,
        { token: viewer.token },
      );
      expect(follow1.data.following).toBe(true);
      const follow2 = await api().post<{
        following: boolean;
        followersCount: number;
      }>(`/api/users/${creator.id}/follow`, { token: viewer.token });
      expect(follow2.data.following).toBe(false);
      expect(follow2.data.followersCount).toBe(
        profileBefore.data.stats.followers,
      );

      const profileAfter = await api().get<CreatorProfileDto>(
        `/api/users/${creator.id}/profile`,
        { token: viewer.token },
      );
      expect(profileAfter.data.stats.totalLikes).toBe(
        profileBefore.data.stats.totalLikes,
      );
    });
  });

  describe('search (FR-057)', () => {
    it('finds reels by hashtag substring and accounts by name substring', async () => {
      const creator = await seller('Lina');
      const viewer = await customer();
      const reel = await reelBy(creator, { hashtags: ['travelgram'] });

      const videos = await api().get<Page<ReelDto>>('/api/reels/search', {
        token: viewer.token,
        query: { q: 'trav' },
      });
      expect(videos.status).toBe(200);
      expect(ids(videos.data)).toContain(reel.id);
      expect(
        videos.data.items.every((item) =>
          item.hashtags.some((tag) => tag.toLowerCase().includes('trav')),
        ),
      ).toBe(true);

      const users = await api().get<Page<UserSearchResultDto>>(
        '/api/users/search',
        { token: viewer.token, query: { q: 'lina' } },
      );
      expect(users.status).toBe(200);
      expect(
        users.data.items.some((u) => u.username.toLowerCase().includes('lina')),
      ).toBe(true);
    });

    it('rejects a whitespace-only query', async () => {
      const viewer = await customer();
      const res = await api().get('/api/reels/search', {
        token: viewer.token,
        query: { q: '  ' },
      });
      expect(res.status).toBe(400);
      expect(res.error).toBe('VALIDATION_FAILED');
    });
  });

  describe('hashtag feed (FR-047a)', () => {
    it('is finite and scoped to the exact tag', async () => {
      const creator = await seller();
      const viewer = await customer();
      const wanted = await reelBy(creator, { hashtags: ['roadtrip'] });
      const longer = await reelBy(creator, { hashtags: ['roadtrips'] });

      const page = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { hashtag: 'roadtrip', limit: 25 },
      });
      expect(page.status).toBe(200);
      expect(page.data.nextCursor).toBeNull();
      expect(ids(page.data)).toContain(wanted.id);
      expect(ids(page.data)).not.toContain(longer.id);
      expect(
        page.data.items.every((item) => item.hashtags.includes('roadtrip')),
      ).toBe(true);
    });
  });

  describe('blocking (FR-052, FR-053)', () => {
    it('hides the reels and the profile from the blocker, and unblocking restores them', async () => {
      const creator = await seller();
      const viewer = await customer();
      await reelBy(creator);

      const before = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { creatorId: creator.id, limit: 1 },
      });
      expect(before.data.items.length).toBeGreaterThan(0);

      const block = await api().post<{ blocked: boolean }>(
        `/api/users/${creator.id}/block`,
        { token: viewer.token },
      );
      expect(block.status).toBe(201);
      expect(block.data.blocked).toBe(true);

      const after = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { creatorId: creator.id, limit: 1 },
      });
      expect(after.data.items).toHaveLength(0);

      // Indistinguishable from an account that does not exist (FR-053).
      const profile = await api().get(`/api/users/${creator.id}/profile`, {
        token: viewer.token,
      });
      expect(profile.status).toBe(404);
      expect(profile.error).toBe('ACCOUNT_NOT_FOUND');

      const unblock = await api().post<{ blocked: boolean }>(
        `/api/users/${creator.id}/block`,
        { token: viewer.token },
      );
      expect(unblock.data.blocked).toBe(false);
      const restored = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { creatorId: creator.id, limit: 1 },
      });
      expect(restored.data.items.length).toBeGreaterThan(0);
    });

    it('works both ways: the blocked account no longer sees the blocker either', async () => {
      const creator = await seller();
      const viewer = await customer();
      await reelBy(creator);

      await api().post(`/api/users/${creator.id}/block`, {
        token: viewer.token,
      });
      const viewerBySeller = await api().get(
        `/api/users/${viewer.id}/profile`,
        { token: creator.token },
      );
      expect(viewerBySeller.status).toBe(404);
    });

    it('rejects blocking yourself', async () => {
      const me = await customer();
      const res = await api().post(`/api/users/${me.id}/block`, {
        token: me.token,
      });
      expect(res.status).toBe(400);
      expect(res.error).toBe('CANNOT_BLOCK_SELF');
    });
  });

  describe('follow guard', () => {
    it('rejects following yourself', async () => {
      const me = await customer();
      const res = await api().post(`/api/users/${me.id}/follow`, {
        token: me.token,
      });
      expect(res.status).toBe(400);
      expect(res.error).toBe('CANNOT_FOLLOW_SELF');
    });
  });

  /**
   * Everything a non-owner must not be able to see or do with a reel that is not published
   * (FR-061, FR-064, FR-070): the single fetch, the creator feed, the profile grid, search, the
   * hashtag feed and every engagement action all answer as if the reel did not exist.
   */
  async function expectInvisibleToOthers(
    reelId: string,
    owner: Person,
    other: Person,
    hashtag: string,
  ) {
    const single = await api().get(`/api/reels/${reelId}`, {
      token: other.token,
    });
    expect(single.status).toBe(404);
    expect(single.error).toBe('REEL_NOT_FOUND');

    const creatorFeed = await api().get<Page<ReelDto>>('/api/reels', {
      token: other.token,
      query: { creatorId: owner.id, limit: 25 },
    });
    expect(ids(creatorFeed.data)).not.toContain(reelId);

    const profile = await api().get<CreatorProfileDto>(
      `/api/users/${owner.id}/profile`,
      { token: other.token },
    );
    expect(profile.status).toBe(200);
    expect(profile.data.videos.map((v) => v.id)).not.toContain(reelId);

    const search = await api().get<Page<ReelDto>>('/api/reels/search', {
      token: other.token,
      query: { q: hashtag },
    });
    expect(ids(search.data)).not.toContain(reelId);
    const hashtagFeed = await api().get<Page<ReelDto>>('/api/reels', {
      token: other.token,
      query: { hashtag },
    });
    expect(ids(hashtagFeed.data)).not.toContain(reelId);

    for (const action of ['like', 'view', 'save', 'share']) {
      const res = await api().post(`/api/reels/${reelId}/${action}`, {
        token: other.token,
      });
      expect([action, res.status, res.error]).toEqual([
        action,
        404,
        'REEL_NOT_FOUND',
      ]);
    }
    const comment = await api().post(`/api/reels/${reelId}/comments`, {
      token: other.token,
      body: { text: 'hello' },
    });
    expect([comment.status, comment.error]).toEqual([404, 'REEL_NOT_FOUND']);
    const comments = await api().get(`/api/reels/${reelId}/comments`, {
      token: other.token,
    });
    expect([comments.status, comments.error]).toEqual([404, 'REEL_NOT_FOUND']);
  }

  /** The owner still sees the reel, with the status the app renders a badge from (FR-072). */
  async function expectOwnerSees(
    reelId: string,
    owner: Person,
    status: string,
  ) {
    const fetched = await api().get<ReelDto>(`/api/reels/${reelId}`, {
      token: owner.token,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.data.status).toBe(status);

    const profile = await api().get<CreatorProfileDto>(
      `/api/users/${owner.id}/profile`,
      { token: owner.token },
    );
    const mine = profile.data.videos.find((v) => v.id === reelId);
    expect(mine?.status).toBe(status);
  }

  describe('moderation visibility (FR-061, FR-064)', () => {
    it('hides a pending reel from non-owners everywhere, but the owner sees it with its status', async () => {
      const owner = await seller();
      const other = await customer();
      const pending = await createReel(testApp, owner.externalId, {
        status: 'pending_moderation',
        hashtags: ['pendingtag'],
      });

      await expectInvisibleToOthers(pending.id, owner, other, 'pendingtag');
      await expectOwnerSees(pending.id, owner, 'pending_moderation');
    });

    it('hides a rejected reel the same way', async () => {
      const owner = await seller();
      const other = await customer();
      const rejected = await createReel(testApp, owner.externalId, {
        status: 'rejected',
        hashtags: ['rejectedtag'],
      });

      await expectInvisibleToOthers(rejected.id, owner, other, 'rejectedtag');
      await expectOwnerSees(rejected.id, owner, 'rejected');
    });

    it('leaves a published reel visible to everyone', async () => {
      const owner = await seller();
      const other = await customer();
      const reel = await reelBy(owner);

      const fetched = await api().get<ReelDto>(`/api/reels/${reel.id}`, {
        token: other.token,
      });
      expect(fetched.status).toBe(200);
      expect(fetched.data.status).toBe('published');
    });
  });

  describe('hidden visibility (FR-070)', () => {
    it('hides a hidden reel from non-owners everywhere, but the owner sees it with its status', async () => {
      const owner = await seller();
      const other = await customer();
      const hidden = await createReel(testApp, owner.externalId, {
        status: 'hidden',
        hashtags: ['hiddentag'],
      });

      await expectInvisibleToOthers(hidden.id, owner, other, 'hiddentag');
      await expectOwnerSees(hidden.id, owner, 'hidden');
    });
  });

  describe('reporting and auto-hide (FR-068 to FR-072)', () => {
    type ReportResult = { reported: boolean; alreadyReported: boolean };
    const report = (
      who: Person,
      reelId: string,
      body: Record<string, unknown> = { reason: 'spam' },
    ) =>
      api().post<ReportResult>(`/api/reels/${reelId}/report`, {
        token: who.token,
        body,
      });

    /** Enough different accounts to cross the auto-hide threshold. */
    async function reportToThreshold(reelId: string, reason = 'spam') {
      for (let i = 0; i < AUTOHIDE_THRESHOLD; i += 1) {
        const res = await report(await customer(), reelId, { reason });
        expect(res.status).toBe(201);
      }
    }

    it('records a report, ignores a repeat from the same account, and refuses a report of your own reel', async () => {
      const owner = await seller();
      const reporter = await customer();
      const reel = await reelBy(owner);

      const own = await report(owner, reel.id);
      expect(own.status).toBe(400);
      expect(own.error).toBe('CANNOT_REPORT_OWN_REEL');

      const first = await report(reporter, reel.id);
      expect(first.status).toBe(201);
      expect(first.data.alreadyReported).toBe(false);

      const repeat = await report(reporter, reel.id);
      expect(repeat.status).toBe(201);
      expect(repeat.data.alreadyReported).toBe(true);
    });

    it('needs text for "other", and refuses a reel that is not published', async () => {
      const owner = await seller();
      const reporter = await customer();
      const reel = await reelBy(owner);

      for (const body of [
        { reason: 'other' },
        { reason: 'other', customReason: '   ' },
      ]) {
        const res = await report(reporter, reel.id, body);
        expect(res.status).toBe(400);
        expect(res.error).toBe('VALIDATION_FAILED');
      }
      const ok = await report(reporter, reel.id, {
        reason: 'other',
        customReason: 'a real reason',
      });
      expect(ok.status).toBe(201);

      const pending = await createReel(testApp, owner.externalId, {
        status: 'pending_moderation',
      });
      const refused = await report(await customer(), pending.id);
      expect(refused.status).toBe(404);
      expect(refused.error).toBe('REEL_NOT_FOUND');
    });

    it('enforces the daily report limit and records nothing over it', async () => {
      const owner = await seller();
      const reporter = await customer();
      const [first, second, third] = [
        await reelBy(owner),
        await reelBy(owner),
        await reelBy(owner),
      ];

      expect((await report(reporter, first.id)).status).toBe(201);
      expect((await report(reporter, second.id)).status).toBe(201);
      // A different reel, so it is not the repeat that is ignored: this one hits the daily cap.
      const over = await report(reporter, third.id);
      expect(over.status).toBe(429);
      expect(over.error).toBe('REPORT_DAILY_LIMIT');

      const doc = await reelModel(testApp).findById(third.id).exec();
      expect(doc?.reportsCount).toBe(0);
    });

    it('hides at the threshold exactly once, keeps earlier engagement, and shows the reel only to its owner', async () => {
      const owner = await seller();
      const reel = await reelBy(owner);
      const liker = await customer();
      await api().post(`/api/reels/${reel.id}/like`, { token: liker.token });

      // The report that crosses the threshold never reveals that the hide fired (FR-070).
      await reportToThreshold(reel.id);

      const other = await customer();
      const fetched = await api().get(`/api/reels/${reel.id}`, {
        token: other.token,
      });
      expect(fetched.status).toBe(404);
      const feed = await api().get<Page<ReelDto>>('/api/reels', {
        token: other.token,
        query: { creatorId: owner.id, limit: 25 },
      });
      expect(ids(feed.data)).not.toContain(reel.id);
      await expectOwnerSees(reel.id, owner, 'hidden');

      const doc = await reelModel(testApp).findById(reel.id).exec();
      expect(doc?.likesCount).toBe(1);
      expect(doc?.reportsCount).toBe(AUTOHIDE_THRESHOLD);
    });

    it('lists a hidden reel for the operator with its reasons, and refuses a bad or missing key', async () => {
      const owner = await seller();
      const reel = await reelBy(owner);
      await reportToThreshold(reel.id, 'hate_speech');

      const none = await api().get('/api/reels/moderation/hidden');
      expect([none.status, none.error]).toEqual([401, 'ADMIN_KEY_INVALID']);
      const wrong = await api().get('/api/reels/moderation/hidden', {
        adminKey: 'wrong-key',
      });
      expect([wrong.status, wrong.error]).toEqual([401, 'ADMIN_KEY_INVALID']);

      const list = await api().get<Page<AdminHiddenReelDto>>(
        '/api/reels/moderation/hidden',
        { adminKey: ADMIN_KEY },
      );
      expect(list.status).toBe(200);
      const entry = list.data.items.find((i) => i.id === reel.id);
      expect(entry).toBeDefined();
      expect(entry?.reportsCount).toBe(AUTOHIDE_THRESHOLD);
      expect(entry?.reports.every((r) => r.reason === 'hate_speech')).toBe(
        true,
      );

      const patch = await api().patch(`/api/reels/${reel.id}/moderation`, {
        body: { action: 'restore' },
      });
      expect([patch.status, patch.error]).toEqual([401, 'ADMIN_KEY_INVALID']);
    });

    it('restores a hidden reel with its counts intact, and it can never be auto-hidden again', async () => {
      const owner = await seller();
      const reel = await reelBy(owner);
      const liker = await customer();
      await api().post(`/api/reels/${reel.id}/like`, { token: liker.token });
      await reportToThreshold(reel.id);
      await expectOwnerSees(reel.id, owner, 'hidden');

      const restore = await api().patch<{ id: string; status: string }>(
        `/api/reels/${reel.id}/moderation`,
        { adminKey: ADMIN_KEY, body: { action: 'restore' } },
      );
      expect(restore.status).toBe(200);
      expect(restore.data.status).toBe('published');

      // Restoring a reel that is already published is a conflict (FR-071).
      const again = await api().patch(`/api/reels/${reel.id}/moderation`, {
        adminKey: ADMIN_KEY,
        body: { action: 'restore' },
      });
      expect([again.status, again.error]).toEqual([409, 'REEL_NOT_HIDDEN']);

      const doc = await reelModel(testApp).findById(reel.id).exec();
      expect(doc?.likesCount).toBe(1);

      // One auto-hide per reel, ever: more reports (still over the threshold) leave it published.
      await report(await customer(), reel.id);
      await expectOwnerSees(reel.id, owner, 'published');
    });

    it('rejects a hidden reel for the operator, and the owner then sees it as rejected', async () => {
      const owner = await seller();
      const reel = await reelBy(owner);
      await reportToThreshold(reel.id, 'violence');

      const reject = await api().patch<{ id: string; status: string }>(
        `/api/reels/${reel.id}/moderation`,
        { adminKey: ADMIN_KEY, body: { action: 'reject' } },
      );
      expect(reject.status).toBe(200);
      expect(reject.data.status).toBe('rejected');
      await expectOwnerSees(reel.id, owner, 'rejected');

      const unknown = await api().patch(
        '/api/reels/000000000000000000000fff/moderation',
        { adminKey: ADMIN_KEY, body: { action: 'restore' } },
      );
      expect([unknown.status, unknown.error]).toEqual([404, 'REEL_NOT_FOUND']);
    });
  });

  describe('repost and the feed tabs (FR-073 to FR-078)', () => {
    const repost = (who: Person, reelId: string) =>
      api().post<{ reposted: boolean }>(`/api/reels/${reelId}/repost`, {
        token: who.token,
      });
    const unrepost = (who: Person, reelId: string) =>
      api().delete<{ reposted: boolean }>(`/api/reels/${reelId}/repost`, {
        token: who.token,
      });
    const follow = (who: Person, target: Person) =>
      api().post(`/api/users/${target.id}/follow`, { token: who.token });

    it('reposts, ignores a repeat, refuses a repost of your own reel, and un-reposts quietly', async () => {
      const owner = await seller();
      const reposter = await customer();
      const reel = await reelBy(owner);

      const own = await repost(owner, reel.id);
      expect([own.status, own.error]).toEqual([400, 'CANNOT_REPOST_OWN_REEL']);

      const first = await repost(reposter, reel.id);
      expect([first.status, first.data.reposted]).toEqual([201, true]);
      const repeat = await repost(reposter, reel.id);
      expect([repeat.status, repeat.data.reposted]).toEqual([201, true]);

      const removed = await unrepost(reposter, reel.id);
      expect([removed.status, removed.data.reposted]).toEqual([200, false]);
      // Un-reposting what is not reposted is a quiet no-op.
      const removedAgain = await unrepost(reposter, reel.id);
      expect([removedAgain.status, removedAgain.data.reposted]).toEqual([
        200,
        false,
      ]);
    });

    it('refuses to repost a pending or hidden reel', async () => {
      const owner = await seller();
      const reposter = await customer();
      for (const status of ['pending_moderation', 'hidden'] as const) {
        const reel = await createReel(testApp, owner.externalId, { status });
        const res = await repost(reposter, reel.id);
        expect([status, res.status, res.error]).toEqual([
          status,
          404,
          'REEL_NOT_FOUND',
        ]);
      }
    });

    it('puts a followee repost in For You with attribution, once, keeps it out of Following, and never notifies the creator', async () => {
      const viewer = await customer();
      const followee = await customer('Friendly');
      const creator = await seller();
      await follow(viewer, followee);

      const reel = await reelBy(creator);
      await repost(followee, reel.id);

      const forYou = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { limit: 25 },
      });
      const occurrences = forYou.data.items.filter((i) => i.id === reel.id);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].repostedBy?.username).toBe(followee.username);

      const following = await api().get<Page<ReelDto>>('/api/reels/following', {
        token: viewer.token,
        query: { limit: 25 },
      });
      expect(following.data.items.every((i) => i.repostedBy === null)).toBe(
        true,
      );
      expect(ids(following.data)).not.toContain(reel.id);

      // Reposting never notifies the creator (FR-073).
      const events = await notificationEventModel(testApp)
        .find({ reelId: new Types.ObjectId(reel.id) })
        .exec();
      expect(events).toHaveLength(0);

      // Un-repost, and the attribution is gone on the next fetch.
      await unrepost(followee, reel.id);
      const after = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { limit: 25 },
      });
      const still = after.data.items.find((i) => i.id === reel.id);
      expect(still?.repostedBy ?? null).toBeNull();
    });

    it('marks your own repost with you, and drops the attribution once you block the reposter', async () => {
      const viewer = await customer();
      const reposter = await customer();
      const creator = await seller();
      await follow(viewer, reposter);

      const reel = await reelBy(creator);
      await repost(reposter, reel.id);

      const own = await reelBy(creator);
      await repost(viewer, own.id);
      const before = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { limit: 25 },
      });
      expect(
        before.data.items.find((i) => i.id === own.id)?.repostedBy?.id,
      ).toBe(viewer.id);

      // The reposter edge is checked on its own (FR-078), whatever the creator edge says.
      await api().post(`/api/users/${reposter.id}/block`, {
        token: viewer.token,
      });
      const after = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { limit: 25 },
      });
      const suppressed = after.data.items.find((i) => i.id === reel.id);
      expect(suppressed?.repostedBy ?? null).toBeNull();
    });
  });

  describe('upload and screening (FR-060 to FR-067)', () => {
    const upload = (who: Person, path: string, description?: string) =>
      api().post<ReelDto>('/api/reels', {
        token: who.token,
        multipart: {
          fields: description === undefined ? {} : { description },
          files: [{ field: 'video', path, contentType: 'video/mp4' }],
        },
      });
    const mentionEvents = (reelId: string, recipient: Person) =>
      notificationEventModel(testApp)
        .find({
          type: NotificationEventType.REEL_MENTION,
          reelId: new Types.ObjectId(reelId),
          recipientId: new Types.ObjectId(recipient.id),
        })
        .exec();

    it('publishes a clean upload and notifies a mention exactly once, at publish time', async () => {
      const uploader = await seller();
      const other = await customer();
      const mentioned = await customer('Lina');

      const res = await upload(
        uploader,
        SAMPLE_10S,
        `hello world #v3test feat. @${mentioned.username}`,
      );
      expect(res.status).toBe(201);
      expect(res.data.status).toBe('pending_moderation');
      const reelId = res.data.id;

      // Invisible while pending (FR-061). The queue is paused, so this is deterministic.
      const pending = await api().get(`/api/reels/${reelId}`, {
        token: other.token,
      });
      expect(pending.status).toBe(404);

      await moderation.moderateReel(reelId);

      const published = await api().get<ReelDto>(`/api/reels/${reelId}`, {
        token: other.token,
      });
      expect(published.status).toBe(200);
      expect(published.data.status).toBe('published');
      expect(await mentionEvents(reelId, mentioned)).toHaveLength(1);
    });

    it('rejects a flagged upload, never sends its mentions, tells the owner, and hides it from others', async () => {
      const uploader = await seller();
      const other = await customer();
      const mentioned = await customer('Lina');

      // The stub's file-name check cannot fire through the endpoint (the file is renamed on disk),
      // so the description marker is the trigger, as the quickstart documents.
      const res = await upload(
        uploader,
        SAMPLE_10S,
        `flagged upload nsfw-test feat. @${mentioned.username}`,
      );
      expect(res.status).toBe(201);
      const reelId = res.data.id;

      await moderation.moderateReel(reelId);

      const owned = await api().get<ReelDto>(`/api/reels/${reelId}`, {
        token: uploader.token,
      });
      expect(owned.data.status).toBe('rejected');
      const others = await api().get(`/api/reels/${reelId}`, {
        token: other.token,
      });
      expect(others.status).toBe(404);

      expect(await mentionEvents(reelId, mentioned)).toHaveLength(0);
      const rejections = await notificationEventModel(testApp)
        .find({
          type: NotificationEventType.REEL_REJECTED,
          reelId: new Types.ObjectId(reelId),
          recipientId: new Types.ObjectId(uploader.id),
        })
        .exec();
      expect(rejections).toHaveLength(1);
      expect(rejections[0].actorId).toBeFalsy();
    });

    it('refuses a video over the duration limit and creates no reel', async () => {
      const uploader = await seller();
      const before = await reelModel(testApp).countDocuments().exec();

      const res = await upload(uploader, SAMPLE_70S);
      expect(res.status).toBe(400);
      expect(res.error).toBe('VIDEO_TOO_LONG');

      expect(await reelModel(testApp).countDocuments().exec()).toBe(before);
    });

    it('refuses an upload with no video', async () => {
      const uploader = await seller();
      const res = await api().post('/api/reels', {
        token: uploader.token,
        multipart: { fields: { description: 'no video attached' } },
      });
      expect(res.status).toBe(400);
      expect(res.error).toBe('VIDEO_REQUIRED');
    });

    it('refuses an upload from a customer: only sellers publish (FR-025)', async () => {
      const buyer = await customer();
      const res = await upload(buyer, SAMPLE_10S);
      expect(res.status).toBe(403);
      expect(res.error).toBe('REELS_SELLERS_ONLY');
    });

    it('suppresses a mention when the mentioned account blocks the uploader before the verdict', async () => {
      const uploader = await seller();
      const mentioned = await customer('Lina');

      const res = await upload(
        uploader,
        SAMPLE_10S,
        `shout out @${mentioned.username}`,
      );
      const reelId = res.data.id;

      // The mentioned account blocks the uploader while the reel is still pending review.
      await api().post(`/api/users/${uploader.id}/block`, {
        token: mentioned.token,
      });
      await moderation.moderateReel(reelId);

      expect(await mentionEvents(reelId, mentioned)).toHaveLength(0);
    });

    it('lets the owner delete a published reel: it disappears everywhere and the counters adjust', async () => {
      const uploader = await seller();
      const other = await customer();
      const res = await upload(uploader, SAMPLE_10S);
      const reelId = res.data.id;
      await moderation.moderateReel(reelId);

      await api().post(`/api/reels/${reelId}/like`, { token: other.token });
      const liked = await api().get<CreatorProfileDto>(
        `/api/users/${uploader.id}/profile`,
        { token: other.token },
      );
      expect(liked.data.stats.totalLikes).toBe(1);

      const deleted = await api().delete<{ deleted: boolean }>(
        `/api/reels/${reelId}`,
        { token: uploader.token },
      );
      expect([deleted.status, deleted.data.deleted]).toEqual([200, true]);

      const gone = await api().get(`/api/reels/${reelId}`, {
        token: uploader.token,
      });
      expect([gone.status, gone.error]).toEqual([404, 'REEL_NOT_FOUND']);
      const after = await api().get<CreatorProfileDto>(
        `/api/users/${uploader.id}/profile`,
        { token: other.token },
      );
      expect(after.data.stats.totalLikes).toBe(0);
    });

    it('refuses deletion by anyone but the owner', async () => {
      const uploader = await seller();
      const other = await seller();
      const res = await upload(uploader, SAMPLE_10S);

      const refused = await api().delete(`/api/reels/${res.data.id}`, {
        token: other.token,
      });
      expect([refused.status, refused.error]).toEqual([403, 'NOT_REEL_OWNER']);
    });
  });

  describe('followed accounts (FR-084)', () => {
    it('needs a session', async () => {
      const res = await api().get('/api/reels/me/following');
      expect([res.status, res.error]).toEqual([401, 'AUTH_REQUIRED']);
    });

    it('lists followees most recently followed first, pages, and leaves out a blocked one', async () => {
      const viewer = await customer();
      const alice = await customer('Alice');
      const bob = await customer('Bob');
      const blocked = await customer('Blocked');

      // Followed in the order Alice, blocked, Bob: Bob is the most recent.
      for (const target of [alice, blocked, bob]) {
        await api().post(`/api/users/${target.id}/follow`, {
          token: viewer.token,
        });
      }
      await api().post(`/api/users/${blocked.id}/block`, {
        token: viewer.token,
      });

      const page1 = await api().get<Page<FollowedUserDto>>(
        '/api/reels/me/following',
        { token: viewer.token, query: { limit: 1 } },
      );
      expect(page1.data.items.map((i) => i.id)).toEqual([bob.id]);
      expect(page1.data.nextCursor).not.toBeNull();

      const page2 = await api().get<Page<FollowedUserDto>>(
        '/api/reels/me/following',
        {
          token: viewer.token,
          query: { limit: 1, cursor: page1.data.nextCursor ?? undefined },
        },
      );
      expect(page2.data.items.map((i) => i.id)).toEqual([alice.id]);
      for (const page of [page1, page2]) {
        expect(ids(page.data)).not.toContain(blocked.id);
      }
    });

    it('is an empty page for an account that follows no one', async () => {
      const viewer = await customer();
      const res = await api().get<Page<FollowedUserDto>>(
        '/api/reels/me/following',
        { token: viewer.token },
      );
      expect(res.data.items).toEqual([]);
      expect(res.data.nextCursor).toBeNull();
    });
  });

  describe('the public Reposts list', () => {
    const repost = (who: Person, reelId: string) =>
      api().post(`/api/reels/${reelId}/repost`, { token: who.token });

    it('is open to signed-out visitors for a given account, and needs the account to say whose (FR-004; Ciro required a session)', async () => {
      const reposter = await customer();
      const creator = await seller();
      const reel = await reelBy(creator);
      await repost(reposter, reel.id);

      const guest = await api().get<Page<ReelDto>>('/api/reels/reposted', {
        query: { userId: reposter.id },
      });
      expect(guest.status).toBe(200);
      expect(ids(guest.data)).toEqual([reel.id]);

      const noWhose = await api().get('/api/reels/reposted');
      expect(noWhose.status).toBe(400);
      expect(noWhose.error).toBe('VALIDATION_FAILED');
    });

    it("shows an account's reposts newest first to any viewer, and drops one that left published", async () => {
      const reposter = await customer();
      const creator = await seller();
      const viewer = await customer();
      const reelA = await reelBy(creator);
      const reelB = await reelBy(creator);
      await repost(reposter, reelA.id);
      await repost(reposter, reelB.id);

      const list = await api().get<Page<ReelDto>>('/api/reels/reposted', {
        token: viewer.token,
        query: { userId: reposter.id },
      });
      expect(ids(list.data)).toEqual([reelB.id, reelA.id]);
      // Each is attributed to the reposter: the "[name] reposted" badge.
      expect(
        list.data.items.every((i) => i.repostedBy?.id === reposter.id),
      ).toBe(true);

      await reelModel(testApp).updateOne(
        { _id: reelB.id },
        { $set: { status: 'hidden' } },
      );
      const after = await api().get<Page<ReelDto>>('/api/reels/reposted', {
        token: viewer.token,
        query: { userId: reposter.id },
      });
      expect(ids(after.data)).toEqual([reelA.id]);
    });

    it('defaults to the caller when no account is given, and is empty until something is reposted', async () => {
      const me = await customer();
      const creator = await seller();

      const empty = await api().get<Page<ReelDto>>('/api/reels/reposted', {
        token: me.token,
      });
      expect(empty.data.items).toEqual([]);

      const reel = await reelBy(creator);
      await repost(me, reel.id);
      const mine = await api().get<Page<ReelDto>>('/api/reels/reposted', {
        token: me.token,
      });
      expect(ids(mine.data)).toEqual([reel.id]);
    });
  });

  describe('the reposters list and the multi-reposter badge', () => {
    it('answers 404 for an unknown reel, to a signed-in or a signed-out caller (FR-004)', async () => {
      const me = await customer();
      for (const token of [me.token, undefined]) {
        const res = await api().get(
          '/api/reels/000000000000000000009999/reposters',
          {
            token,
          },
        );
        expect([res.status, res.error]).toEqual([404, 'REEL_NOT_FOUND']);
      }
    });

    it('lists every reposter newest first, and the For You badge counts only the ones you follow', async () => {
      const viewer = await customer();
      const followeeA = await customer('Anna');
      const followeeB = await customer('Basil');
      const stranger = await customer();
      const creator = await seller();
      for (const target of [followeeA, followeeB]) {
        await api().post(`/api/users/${target.id}/follow`, {
          token: viewer.token,
        });
      }

      const reel = await reelBy(creator);
      for (const who of [followeeA, followeeB, stranger]) {
        await api().post(`/api/reels/${reel.id}/repost`, { token: who.token });
      }

      // The sheet shows all three, the latest reposter first.
      const sheet = await api().get<Page<FollowedUserDto>>(
        `/api/reels/${reel.id}/reposters`,
        { token: viewer.token },
      );
      expect(ids(sheet.data)).toHaveLength(3);
      expect(sheet.data.items[0].id).toBe(stranger.id);

      // The badge is viewer-relative: the two followed reposters, not the stranger (FR-060).
      const forYou = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { limit: 25 },
      });
      const item = forYou.data.items.find((i) => i.id === reel.id);
      expect(item?.repostersCount).toBe(2);
      expect(item?.topReposters.map((r) => r.id).sort()).toEqual(
        [followeeA.id, followeeB.id].sort(),
      );
    });
  });

  describe('the store page (FR-039a)', () => {
    // Ciro served this page for any text in the address. It now serves reel links only (a 24-hex
    // id), which closes an HTML injection; its own behavior is covered by links.e2e-spec.ts.
    it('is served as HTML with no session', async () => {
      const res = await api().raw('/reels/650000000000000000000001');
      expect(res.status).toBe(200);
      expect(res.contentType).toContain('text/html');
    });
  });
});
