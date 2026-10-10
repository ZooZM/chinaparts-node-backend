import type { Page, ReelDto } from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import { createPublishedReel, createReel } from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';

type Feed = Page<ReelDto>;

/** Research R9 and FR-017 to FR-024: how the For You feed and the scoped feeds are paged. */
describe('Feed (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  /** A fresh catalog: nothing a previous describe made can show up in this one. */
  const startEmpty = () => testApp.resetReelsData();

  const api = () => testApp.api;
  const customer = () => createPerson(testApp, 'customer');
  const seller = () => createPerson(testApp, 'seller');
  const ids = (page: Page<{ id: string }>) => page.items.map((item) => item.id);

  async function forYou(
    viewer: Person | undefined,
    query: { limit?: number; cursor?: string | null } = {},
  ) {
    const res = await api().get<Feed>('/api/reels', {
      token: viewer?.token,
      query: { limit: query.limit, cursor: query.cursor ?? undefined },
    });
    expect(res.status).toBe(200);
    return res.data;
  }

  async function publishMany(
    creator: Person,
    count: number,
  ): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const reel = await createPublishedReel(testApp, creator.externalId, {
        description: `reel ${i}`,
      });
      created.push(reel.id);
    }
    return created;
  }

  describe('paging (FR-019)', () => {
    let creator: Person;
    let viewer: Person;
    let oldestFirst: string[];

    beforeAll(async () => {
      await startEmpty();
      creator = await seller();
      viewer = await customer();
      oldestFirst = await publishMany(creator, 30);
    });

    it('shows no reel twice and skips none, even while new reels are published between pages', async () => {
      const newestFirst = [...oldestFirst].reverse();

      const page1 = await forYou(viewer, { limit: 10 });
      expect(ids(page1)).toEqual(newestFirst.slice(0, 10));

      // Three reels are published while the viewer is scrolling.
      await publishMany(creator, 3);

      const page2 = await forYou(viewer, {
        limit: 10,
        cursor: page1.nextCursor,
      });
      const page3 = await forYou(viewer, {
        limit: 10,
        cursor: page2.nextCursor,
      });

      const firstPass = [...ids(page1), ...ids(page2), ...ids(page3)];
      expect(firstPass).toEqual(newestFirst);
      expect(new Set(firstPass).size).toBe(30);
    });

    it('serves a page of the default size, and clamps a larger one to the maximum', async () => {
      const byDefault = await forYou(viewer);
      expect(byDefault.items).toHaveLength(10);

      const clamped = await forYou(viewer, { limit: 100 });
      expect(clamped.items).toHaveLength(25);

      const small = await forYou(viewer, { limit: 3 });
      expect(small.items).toHaveLength(3);
    });

    it('serves the same pages to a signed-out visitor, without the viewer flags', async () => {
      const page = await forYou(undefined, { limit: 5 });
      expect(page.items).toHaveLength(5);
      expect(
        page.items.every(
          (item) =>
            !item.viewerLiked &&
            !item.viewerSaved &&
            !item.viewerReposted &&
            item.repostedBy === null &&
            item.repostersCount === 0 &&
            item.topReposters.length === 0,
        ),
      ).toBe(true);
    });
  });

  describe('looping (FR-020)', () => {
    it('starts the catalog again when a pass runs out, and the cursor is never null', async () => {
      await startEmpty();
      const creator = await seller();
      const viewer = await customer();
      const oldestFirst = await publishMany(creator, 5);
      const cycle = [...oldestFirst].reverse();

      // Three at a time, over five reels: pages straddle the end of a pass.
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let pageNumber = 1; pageNumber <= 6; pageNumber += 1) {
        const page = await forYou(viewer, { limit: 3, cursor });
        expect(page.nextCursor).not.toBeNull();
        // A page never repeats a reel it already shows, even where it wraps.
        expect(new Set(ids(page)).size).toBe(page.items.length);
        seen.push(...ids(page));
        cursor = page.nextCursor;
      }

      // The stream is the catalog, newest first, over and over.
      const expected = Array.from({ length: seen.length }, (_, index) => {
        return cycle[index % cycle.length];
      });
      expect(seen).toEqual(expected);
    });

    it('is a catalog smaller than a page: each reel once, and the loop goes on', async () => {
      await startEmpty();
      const creator = await seller();
      const viewer = await customer();
      const only = await publishMany(creator, 2);

      const page = await forYou(viewer, { limit: 10 });
      expect(new Set(ids(page))).toEqual(new Set(only));
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).not.toBeNull();

      const again = await forYou(viewer, {
        limit: 10,
        cursor: page.nextCursor,
      });
      expect(new Set(ids(again))).toEqual(new Set(only));
    });

    it('has nothing to loop in an empty catalog, so the cursor ends', async () => {
      await startEmpty();
      const viewer = await customer();
      const page = await forYou(viewer);
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('cursors', () => {
    it.each([
      ['plain text', 'not-a-cursor!'],
      ['an offset from the old scheme', '30'],
      ['valid base64url that is not a cursor', 'eyJhIjoxfQ'],
    ])(
      'answers INVALID_CURSOR to %s, on every feed',
      async (_label, cursor) => {
        const viewer = await customer();
        const creator = await seller();

        for (const query of [
          {},
          { creatorId: creator.id },
          { hashtag: 'anything' },
        ]) {
          const res = await api().get('/api/reels', {
            token: viewer.token,
            query: { ...query, cursor },
          });
          expect([res.status, res.error]).toEqual([400, 'INVALID_CURSOR']);
        }
      },
    );

    it('continues a creator feed and a hashtag feed to their end, then stops', async () => {
      await startEmpty();
      const creator = await seller();
      const viewer = await customer();
      const reels: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const reel = await createPublishedReel(testApp, creator.externalId, {
          hashtags: ['scoped'],
        });
        reels.push(reel.id);
      }
      const newestFirst = [...reels].reverse();

      for (const scope of [{ creatorId: creator.id }, { hashtag: 'scoped' }]) {
        const collected: string[] = [];
        let cursor: string | null | undefined;
        let pages = 0;
        do {
          const res = await api().get<Feed>('/api/reels', {
            token: viewer.token,
            query: { ...scope, limit: 3, cursor: cursor ?? undefined },
          });
          expect(res.status).toBe(200);
          collected.push(...ids(res.data));
          cursor = res.data.nextCursor;
          pages += 1;
        } while (cursor !== null && pages < 10);

        expect([scope, collected]).toEqual([scope, newestFirst]);
        expect(pages).toBe(3);
      }
    });
  });

  describe('visibility (FR-021)', () => {
    it('shows non-owners only published reels, and the owner every one of theirs with its status', async () => {
      await startEmpty();
      const creator = await seller();
      const other = await customer();
      const published = await createReel(testApp, creator.externalId, {});
      const pending = await createReel(testApp, creator.externalId, {
        status: 'pending_moderation',
      });
      const rejected = await createReel(testApp, creator.externalId, {
        status: 'rejected',
      });
      const hidden = await createReel(testApp, creator.externalId, {
        status: 'hidden',
      });

      // Non-owners: the For You feed and the creator feed.
      const forYouOther = await forYou(other, { limit: 25 });
      expect(ids(forYouOther)).toEqual([published.id]);
      const creatorFeed = await api().get<Feed>('/api/reels', {
        token: other.token,
        query: { creatorId: creator.id, limit: 25 },
      });
      expect(ids(creatorFeed.data)).toEqual([published.id]);

      // The owner sees all four in their own creator feed, labelled.
      const own = await api().get<Feed>('/api/reels', {
        token: creator.token,
        query: { creatorId: creator.id, limit: 25 },
      });
      const statuses = new Map(own.data.items.map((i) => [i.id, i.status]));
      expect(statuses).toEqual(
        new Map([
          [published.id, 'published'],
          [pending.id, 'pending_moderation'],
          [rejected.id, 'rejected'],
          [hidden.id, 'hidden'],
        ]),
      );

      // For You is published reels (FR-017), for the owner as for anyone.
      const forYouOwner = await forYou(creator, { limit: 25 });
      expect(ids(forYouOwner)).toEqual([published.id]);
    });
  });

  describe('views (FR-024)', () => {
    it('counts a signed-in view once per account', async () => {
      await startEmpty();
      const creator = await seller();
      const first = await customer();
      const second = await customer();
      const reel = await createPublishedReel(testApp, creator.externalId);

      const view = (who: Person) =>
        api().post<{ viewsCount: number }>(`/api/reels/${reel.id}/view`, {
          token: who.token,
        });

      expect((await view(first)).data.viewsCount).toBe(1);
      expect((await view(first)).data.viewsCount).toBe(1);
      expect((await view(second)).data.viewsCount).toBe(2);
    });
  });

  describe('reposts (FR-017)', () => {
    it('seeds a followee repost at the top of the first page, and never shows it again in the pass', async () => {
      await startEmpty();
      const creator = await seller();
      const viewer = await customer();
      const followee = await customer();
      await api().post(`/api/users/${followee.id}/follow`, {
        token: viewer.token,
      });

      // An old reel the followee reposts, then 24 newer ones: it would be on page 3 by age.
      const old = await createPublishedReel(testApp, creator.externalId);
      await publishMany(creator, 24);
      await api().post(`/api/reels/${old.id}/repost`, {
        token: followee.token,
      });

      const page1 = await forYou(viewer, { limit: 10 });
      expect(page1.items[0].id).toBe(old.id);
      expect(page1.items[0].repostedBy?.id).toBe(followee.id);

      const page2 = await forYou(viewer, {
        limit: 10,
        cursor: page1.nextCursor,
      });
      const page3 = await forYou(viewer, {
        limit: 10,
        cursor: page2.nextCursor,
      });
      const stream = [...ids(page1), ...ids(page2), ...ids(page3)];

      // 25 reels make a pass: each is shown once in it, the reposted one on top.
      const firstPass = stream.slice(0, 25);
      expect(new Set(firstPass).size).toBe(25);
      expect(firstPass.filter((id) => id === old.id)).toHaveLength(1);

      // The rest of page 3 is the start of pass 1, from the newest reel and without the seeding.
      const newest = firstPass[1];
      expect(stream[25]).toBe(newest);
    });

    it('keeps to the page size when the seeds alone fill the page, and shows the rest later', async () => {
      await startEmpty();
      const creator = await seller();
      const viewer = await customer();
      const followee = await customer();
      await api().post(`/api/users/${followee.id}/follow`, {
        token: viewer.token,
      });
      const oldestFirst = await publishMany(creator, 6);
      // Three of the older reels are reposted, the first of them most recently.
      const [r1, r2, r3] = oldestFirst;
      for (const id of [r3, r2, r1]) {
        await api().post(`/api/reels/${id}/repost`, { token: followee.token });
      }

      const page1 = await forYou(viewer, { limit: 2 });
      expect(ids(page1)).toEqual([r1, r2]);
      const page2 = await forYou(viewer, {
        limit: 2,
        cursor: page1.nextCursor,
      });
      // The third seed is placed later, not lost: the seeds were the first two only.
      expect(ids(page2)).toHaveLength(2);
      expect(ids(page2)).not.toContain(r1);
      expect(ids(page2)).not.toContain(r2);
    });

    it('starts the next pass without the seeding, so each reel appears once per pass', async () => {
      await startEmpty();
      const creator = await seller();
      const viewer = await customer();
      const followee = await customer();
      await api().post(`/api/users/${followee.id}/follow`, {
        token: viewer.token,
      });
      const oldestFirst = await publishMany(creator, 4);
      await api().post(`/api/reels/${oldestFirst[0]}/repost`, {
        token: followee.token,
      });

      // Four reels, three per page: the second page wraps into pass 1.
      const [r1, r2, r3, r4] = oldestFirst;
      const page1 = await forYou(viewer, { limit: 3 });
      const page2 = await forYou(viewer, {
        limit: 3,
        cursor: page1.nextCursor,
      });

      // Pass 0: the reposted (oldest) reel on top, then the newest ones; the reposted reel is not
      // met again in its chronological place.
      expect(ids(page1)).toEqual([r1, r4, r3]);
      // Then the one reel left in pass 0, and the start of pass 1 from the newest, with no seeding.
      expect(ids(page2)).toEqual([r2, r4, r3]);
    });
  });
});
