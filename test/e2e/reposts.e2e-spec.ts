import type {
  FollowedUserDto,
  Page,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import { createPublishedReel, runSync } from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';

/** FR-017, FR-019, FR-060 and FR-073 to FR-078: reposts reach followers once per pass. */
describe('Reposts (e2e)', () => {
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
  const follow = (who: Person, target: Person) =>
    api().post(`/api/users/${target.id}/follow`, { token: who.token });
  const repost = (who: Person, reelId: string) =>
    api().post(`/api/reels/${reelId}/repost`, { token: who.token });
  const forYou = async (
    who: Person | undefined,
    query: { limit?: number; cursor?: string | null } = {},
  ) =>
    (
      await api().get<Page<ReelDto>>('/api/reels', {
        token: who?.token,
        query: { limit: query.limit ?? 25, cursor: query.cursor ?? undefined },
      })
    ).data;
  const publish = async (creator: Person, count: number) => {
    const made: string[] = [];
    for (let i = 0; i < count; i += 1) {
      made.push((await createPublishedReel(testApp, creator.externalId)).id);
    }
    return made;
  };

  describe('basics', () => {
    it("puts a followee's repost on the first For You page, and removing it takes it away", async () => {
      await testApp.resetReelsData();
      const creator = await seller();
      const viewer = await customer();
      const followee = await customer();
      await follow(viewer, followee);
      const [old] = await publish(creator, 1);
      await publish(creator, 12);

      await repost(followee, old);
      const first = await forYou(viewer, { limit: 5 });
      expect(first.items[0]).toMatchObject({ id: old });
      expect(first.items[0].repostedBy?.id).toBe(followee.id);

      await api().delete(`/api/reels/${old}/repost`, { token: followee.token });
      const after = await forYou(viewer, { limit: 5 });
      expect(ids(after)).not.toContain(old);
      expect(after.items.every((item) => item.repostedBy === null)).toBe(true);
    });

    it('shows a reel once when two followed accounts repost it, and counts both', async () => {
      const creator = await seller();
      const viewer = await customer();
      const a = await customer();
      const b = await customer();
      await follow(viewer, a);
      await follow(viewer, b);
      const [reel] = await publish(creator, 1);
      await repost(a, reel);
      await repost(b, reel);

      const page = await forYou(viewer);

      const occurrences = page.items.filter((item) => item.id === reel);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].repostersCount).toBe(2);
      // The most recent reposter is the one named.
      expect(occurrences[0].repostedBy?.id).toBe(b.id);
    });
  });

  describe('once per pass (FR-017, FR-019)', () => {
    it('never shows the seeded repost again in its chronological place, and shows it once in the next pass', async () => {
      await testApp.resetReelsData();
      const creator = await seller();
      const viewer = await customer();
      const followee = await customer();
      await follow(viewer, followee);
      const oldestFirst = await publish(creator, 15);
      const old = oldestFirst[0];
      await repost(followee, old);

      const pages: Page<ReelDto>[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 6; i += 1) {
        const page: Page<ReelDto> = await forYou(viewer, { limit: 5, cursor });
        pages.push(page);
        cursor = page.nextCursor;
      }

      const pass0 = pages.slice(0, 3).flatMap(ids);
      const pass1 = pages.slice(3).flatMap(ids);
      // Pass 0: every reel once, the seeded one first and nowhere else.
      expect(pass0).toHaveLength(15);
      expect(new Set(pass0).size).toBe(15);
      expect(pass0[0]).toBe(old);
      expect(pages[1].items.map((i) => i.id)).not.toContain(old);
      expect(pages[2].items.map((i) => i.id)).not.toContain(old);
      // Pass 1: from the newest, with no seeding, the old reel once at the end.
      expect(pass1[0]).toBe(oldestFirst[14]);
      expect(new Set(pass1).size).toBe(15);
      expect(pass1.filter((id) => id === old)).toHaveLength(1);
      expect(pass1[14]).toBe(old);
    });
  });

  describe('the badge (FR-060)', () => {
    it('counts only the reposters the viewer follows, plus the viewer; a guest sees none', async () => {
      const creator = await seller();
      const viewer = await customer();
      const followed = await customer();
      const stranger = await seller();
      await follow(viewer, followed);
      const [reel] = await publish(creator, 1);
      await repost(followed, reel);
      await repost(stranger, reel);

      const seen = (await forYou(viewer)).items.find(
        (item) => item.id === reel,
      );
      expect(seen?.repostersCount).toBe(1);
      expect(seen?.topReposters.map((r) => r.id)).toEqual([followed.id]);

      // The viewer's own repost counts too.
      await repost(viewer, reel);
      const withSelf = (await forYou(viewer)).items.find(
        (item) => item.id === reel,
      );
      expect(withSelf?.repostersCount).toBe(2);
      expect(withSelf?.viewerReposted).toBe(true);

      const asGuest = (await forYou(undefined)).items.find(
        (item) => item.id === reel,
      );
      expect(asGuest).toMatchObject({
        repostedBy: null,
        repostersCount: 0,
        topReposters: [],
        viewerReposted: false,
      });
    });
  });

  describe('exclusions', () => {
    it('leaves a blocked account out of the reposters list and the badge', async () => {
      const creator = await seller();
      const viewer = await customer();
      const friend = await customer();
      const blocked = await customer();
      await follow(viewer, friend);
      await follow(viewer, blocked);
      const [reel] = await publish(creator, 1);
      await repost(friend, reel);
      await repost(blocked, reel);
      await api().post(`/api/users/${blocked.id}/block`, {
        token: viewer.token,
      });

      const sheet = await api().get<Page<FollowedUserDto>>(
        `/api/reels/${reel}/reposters`,
        { token: viewer.token },
      );
      expect(ids(sheet.data)).toEqual([friend.id]);
      const seen = (await forYou(viewer)).items.find(
        (item) => item.id === reel,
      );
      expect(seen?.repostersCount).toBe(1);
      expect(seen?.repostedBy?.id).toBe(friend.id);
    });

    it('does not seed the repost of an account that is out of good standing', async () => {
      await testApp.resetReelsData();
      const creator = await seller();
      const viewer = await customer();
      const reposter = await customer();
      await follow(viewer, reposter);
      const [old] = await publish(creator, 1);
      await publish(creator, 8);
      await repost(reposter, old);
      expect((await forYou(viewer, { limit: 5 })).items[0].id).toBe(old);

      await testApp.infra.rootQuery(
        'UPDATE customers SET status = 0 WHERE id = ?',
        [reposter.externalId],
      );
      await runSync(testApp);

      const page = await forYou(viewer, { limit: 5 });
      expect(page.items[0].id).not.toBe(old);
      expect(page.items.every((item) => item.repostedBy === null)).toBe(true);
    });

    it('hides the reposters list of a reel whose creator the viewer blocked', async () => {
      const creator = await seller();
      const viewer = await customer();
      const [reel] = await publish(creator, 1);
      await repost(await customer(), reel);
      await api().post(`/api/users/${creator.id}/block`, {
        token: viewer.token,
      });

      const res = await api().get(`/api/reels/${reel}/reposters`, {
        token: viewer.token,
      });
      expect([res.status, res.error]).toEqual([404, 'REEL_NOT_FOUND']);
    });
  });

  describe('signed out', () => {
    it('needs a userId for the public Reposts list, and never gets repost injection', async () => {
      const creator = await seller();
      const reposter = await customer();
      const [reel] = await publish(creator, 1);
      await repost(reposter, reel);

      const noWhose = await api().get('/api/reels/reposted');
      expect([noWhose.status, noWhose.error]).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
      const withWhose = await api().get<Page<ReelDto>>('/api/reels/reposted', {
        query: { userId: reposter.id },
      });
      expect(ids(withWhose.data)).toEqual([reel]);
      const feed = await forYou(undefined);
      expect(feed.items.every((item) => item.repostedBy === null)).toBe(true);
    });
  });

  describe('paging (keyset on the repost)', () => {
    it("pages an account's reposts newest repost first, without a repeat or a gap", async () => {
      const creator = await seller();
      const reposter = await customer();
      const reels = await publish(creator, 5);
      // Reposted in a different order from how they were published.
      const order = [reels[2], reels[0], reels[4], reels[1], reels[3]];
      for (const id of order) await repost(reposter, id);

      const collected: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const res = await api().get<Page<ReelDto>>('/api/reels/reposted', {
          token: reposter.token,
          query: { limit: 2, cursor: cursor ?? undefined },
        });
        expect(res.status).toBe(200);
        collected.push(...ids(res.data));
        cursor = res.data.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(collected).toEqual([...order].reverse());
      expect(pages).toBe(3);
    });

    it('pages the reposters of a reel, latest first, without a repeat or a gap', async () => {
      const creator = await seller();
      const [reel] = await publish(creator, 1);
      const reposters: Person[] = [];
      for (let i = 0; i < 5; i += 1) {
        const who = await customer();
        await repost(who, reel);
        reposters.push(who);
      }
      const viewer = await customer();

      const collected: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const res = await api().get<Page<FollowedUserDto>>(
          `/api/reels/${reel}/reposters`,
          {
            token: viewer.token,
            query: { limit: 2, cursor: cursor ?? undefined },
          },
        );
        expect(res.status).toBe(200);
        collected.push(...ids(res.data));
        cursor = res.data.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(collected).toEqual([...reposters].reverse().map((p) => p.id));
      expect(pages).toBe(3);
    });
  });
});
