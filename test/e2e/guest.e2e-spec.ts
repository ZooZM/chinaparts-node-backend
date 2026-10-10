import { randomUUID } from 'node:crypto';
import type { Page, ReelDto } from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import { createPublishedReel } from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';
import { issueToken } from '../utils/tokens';

/**
 * SC-014 and FR-004: a visitor with no account can watch, and is asked to sign in for anything
 * that writes or is personal. A visitor who sends a session that does not check out is told so,
 * never quietly treated as a guest (FR-004a).
 */
describe('Signed-out visitors (e2e)', () => {
  let testApp: TestApp;
  let creator: Person;
  let reelId: string;

  beforeAll(async () => {
    testApp = await createTestApp({
      // Small, so the limit can be reached; it counts per installation and address (FR-004b).
      env: { GUEST_RATE_LIMIT_PER_MINUTE: '5' },
    });
    creator = await createPerson(testApp, 'seller');
    reelId = (await createPublishedReel(testApp, creator.externalId)).id;

    // One repost, so the reposters list has something to list.
    const reposter = await createPerson(testApp, 'customer');
    await testApp.api.post(`/api/reels/${reelId}/repost`, {
      token: reposter.token,
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  // Every test starts with fresh counters, so one test's requests never count against the next.
  beforeEach(async () => {
    await testApp.infra.resetRedis();
  });

  const api = () => testApp.api;

  describe('may read (FR-004)', () => {
    it.each([
      ['the For You feed (EP1)', () => '/api/reels'],
      ['a creator feed (EP1)', () => `/api/reels?creatorId=${creator.id}`],
      ['a single reel (EP9)', () => `/api/reels/${reelId}`],
      [
        'the reposters of a reel (EP18)',
        () => `/api/reels/${reelId}/reposters`,
      ],
      ['the comments of a reel (EP20)', () => `/api/reels/${reelId}/comments`],
      ['a profile (EP27)', () => `/api/users/${creator.id}/profile`],
      [
        "an account's reposts, when told whose (EP5)",
        () => `/api/reels/reposted?userId=${creator.id}`,
      ],
    ])('%s', async (_label, path) => {
      const res = await api().get(path());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('is told to say whose reposts to show (EP5 without userId)', async () => {
      const res = await api().get('/api/reels/reposted');
      expect([res.status, res.error]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('sees every reel as someone who has done nothing with it', async () => {
      const page = await api().get<Page<ReelDto>>('/api/reels');
      const reel = page.data.items.find((item) => item.id === reelId);
      expect(reel).toMatchObject({
        viewerLiked: false,
        viewerSaved: false,
        viewerReposted: false,
        repostedBy: null,
        repostersCount: 0,
        topReposters: [],
      });
      expect(reel?.creator.viewerFollowing).toBe(false);
    });
  });

  describe('views (FR-024)', () => {
    it('count once per installation, and not at all without one', async () => {
      const first = randomUUID();
      const second = randomUUID();
      const view = (installationId?: string) =>
        api().post<{ viewsCount: number }>(`/api/reels/${reelId}/view`, {
          installationId,
        });

      const a1 = await view(first);
      expect([a1.status, a1.data.viewsCount]).toEqual([201, 1]);
      const a2 = await view(first);
      expect(a2.data.viewsCount).toBe(1);
      const b1 = await view(second);
      expect(b1.data.viewsCount).toBe(2);

      // No installation id: the answer is the current count, and nothing is recorded.
      const anonymous = await view();
      expect([anonymous.status, anonymous.data.viewsCount]).toEqual([201, 2]);
      const again = await view();
      expect(again.data.viewsCount).toBe(2);
    });

    it('ignore an installation id that is not a UUID v4', async () => {
      const res = await api().post<{ viewsCount: number }>(
        `/api/reels/${reelId}/view`,
        { headers: { 'X-Installation-Id': 'not-a-uuid' } },
      );
      expect(res.status).toBe(201);

      const before = (await api().get<ReelDto>(`/api/reels/${reelId}`)).data
        .viewsCount;
      await api().post(`/api/reels/${reelId}/view`, {
        headers: { 'X-Installation-Id': 'not-a-uuid' },
      });
      const after = (await api().get<ReelDto>(`/api/reels/${reelId}`)).data
        .viewsCount;
      expect(after).toBe(before);
    });
  });

  describe('are asked to sign in (FR-004)', () => {
    const needSignIn: Array<[string, 'get' | 'post', () => string]> = [
      ['liking a reel (EP13)', 'post', () => `/api/reels/${reelId}/like`],
      ['the Following feed (EP2)', 'get', () => '/api/reels/following'],
      ['searching reels (EP6)', 'get', () => '/api/reels/search?q=anything'],
      ['saving a reel (EP14)', 'post', () => `/api/reels/${reelId}/save`],
      ['commenting (EP21)', 'post', () => `/api/reels/${reelId}/comments`],
      [
        'following an account (EP28)',
        'post',
        () => `/api/users/${creator.id}/follow`,
      ],
      ['the Liked list (EP3)', 'get', () => '/api/reels/liked'],
      ['their own account (EP24)', 'get', () => '/api/users/me'],
    ];

    it.each(needSignIn)('%s', async (_label, method, path) => {
      const res = await api()[method](path());
      expect([res.status, res.error]).toEqual([401, 'AUTH_REQUIRED']);
    });
  });

  describe('a session that does not check out', () => {
    it('is refused on a route open to visitors, not taken for a guest (FR-004a)', async () => {
      const res = await api().get('/api/reels', {
        token: 'Bearer 987654|stale-session',
      });
      expect([res.status, res.error]).toEqual([401, 'AUTH_INVALID_SESSION']);
    });

    describe('when China Parts cannot be reached', () => {
      afterEach(async () => {
        await testApp.infra.startMysql().catch(() => undefined);
      });

      it('answers 503 for a session it has not seen, so the app does not sign the user out', async () => {
        const token = await issueToken(testApp.infra, 'customer', 1);
        await testApp.infra.stopMysql();

        const res = await api().get('/api/reels', { token });
        expect([res.status, res.error]).toEqual([503, 'UPSTREAM_UNAVAILABLE']);
      });
    });
  });

  describe('rate limit (FR-004b)', () => {
    it('stops a visitor after GUEST_RATE_LIMIT_PER_MINUTE requests, per installation', async () => {
      const installationId = randomUUID();
      for (let i = 1; i <= 5; i += 1) {
        const res = await api().get('/api/reels', { installationId });
        expect([i, res.status]).toEqual([i, 200]);
      }

      const sixth = await api().get('/api/reels', { installationId });
      expect([sixth.status, sixth.error]).toEqual([429, 'RATE_LIMITED']);
      expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      // Another installation has its own allowance.
      const other = await api().get('/api/reels', {
        installationId: randomUUID(),
      });
      expect(other.status).toBe(200);
    });

    it('does not apply to a signed-in account, which has its own, larger, allowance', async () => {
      const member = await createPerson(testApp, 'customer');
      for (let i = 1; i <= 8; i += 1) {
        const res = await api().get('/api/reels', { token: member.token });
        expect([i, res.status]).toEqual([i, 200]);
      }
    });
  });
});
