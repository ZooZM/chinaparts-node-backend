import { Types } from 'mongoose';
import type { MeDto } from '../../src/modules/accounts/accounts.service';
import { NotificationEventType } from '../../src/modules/reels/schemas/notification-event.schema';
import type {
  CommentDto,
  CreatorProfileDto,
  FollowedUserDto,
  Page,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import {
  createPublishedReel,
  createReel,
  notificationEventModel,
} from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';
import { issueToken } from '../utils/tokens';

/** FR-011 to FR-016 and FR-043 to FR-048: profiles, following, blocking and the handle. */
describe('Profiles, following and blocking (e2e)', () => {
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
  const profileOf = (target: { id: string }, viewer?: { token: string }) =>
    api().get<CreatorProfileDto>(`/api/users/${target.id}/profile`, {
      token: viewer?.token,
    });
  const follow = (who: Person, target: { id: string }) =>
    api().post<{ following: boolean; followersCount: number }>(
      `/api/users/${target.id}/follow`,
      { token: who.token },
    );
  const block = (who: Person, target: { id: string }) =>
    api().post<{ blocked: boolean }>(`/api/users/${target.id}/block`, {
      token: who.token,
    });
  const feed = async (
    who: Person,
    query: Record<string, string | number> = {},
  ) =>
    ids(
      (
        await api().get<Page<ReelDto>>('/api/reels', {
          token: who.token,
          query: { limit: 25, ...query },
        })
      ).data,
    );

  describe("a seller's profile (FR-011)", () => {
    it("shows the shop's Arabic name, the account type, and published reels newest first", async () => {
      // Fixture seller 1: an approved seller whose shop is called قطع غيار الرياض.
      const sellerToken = await issueToken(testApp.infra, 'seller', 1);
      const me = await api().get<MeDto>('/api/users/me', {
        token: sellerToken,
      });
      const viewer = await customer();
      const first = await createPublishedReel(testApp, 1);
      const second = await createPublishedReel(testApp, 1);
      const pending = await createReel(testApp, 1, {
        status: 'pending_moderation',
      });

      const asViewer = await profileOf(me.data, viewer);

      expect(asViewer.status).toBe(200);
      expect(asViewer.data.user).toMatchObject({
        id: me.data.id,
        name: 'قطع غيار الرياض',
        accountType: 'seller',
      });
      expect(asViewer.data.videos.map((v) => v.id)).toEqual([
        second.id,
        first.id,
      ]);

      // The seller sees every one of their own, each with its status.
      const asOwner = await profileOf(me.data, { token: sellerToken });
      expect(asOwner.data.videos.map((v) => [v.id, v.status])).toEqual([
        [pending.id, 'pending_moderation'],
        [second.id, 'published'],
        [first.id, 'published'],
      ]);
      expect(asOwner.data.viewer.isSelf).toBe(true);
    });

    it('is open to a signed-out visitor', async () => {
      const creator = await seller();
      const res = await profileOf(creator);
      expect(res.status).toBe(200);
      expect(res.data.viewer).toEqual({ following: false, isSelf: false });
    });
  });

  describe("a customer's profile", () => {
    it('has no videos, and names the account as a customer', async () => {
      const buyer = await customer();
      const viewer = await customer();

      const res = await profileOf(buyer, viewer);

      expect(res.status).toBe(200);
      expect(res.data.videos).toEqual([]);
      expect(res.data.user.accountType).toBe('customer');
    });
  });

  describe('following', () => {
    it('updates both counts, and sends one newFollower notification however often it is toggled', async () => {
      const creator = await seller();
      const fan = await customer();
      const events = () =>
        notificationEventModel(testApp)
          .find({
            type: NotificationEventType.NEW_FOLLOWER,
            actorId: new Types.ObjectId(fan.id),
            recipientId: new Types.ObjectId(creator.id),
          })
          .exec();

      const first = await follow(fan, creator);
      expect(first.data).toEqual({ following: true, followersCount: 1 });
      expect((await profileOf(fan, fan)).data.stats.following).toBe(1);
      expect(await events()).toHaveLength(1);

      const off = await follow(fan, creator);
      expect(off.data).toEqual({ following: false, followersCount: 0 });
      expect((await profileOf(fan, fan)).data.stats.following).toBe(0);

      const again = await follow(fan, creator);
      expect(again.data.following).toBe(true);
      expect(await events()).toHaveLength(1);
    });

    it('is refused for yourself, and for an account that does not exist', async () => {
      const me = await customer();

      const self = await follow(me, me);
      expect([self.status, self.error]).toEqual([400, 'CANNOT_FOLLOW_SELF']);
      const unknown = await follow(me, { id: new Types.ObjectId().toString() });
      expect([unknown.status, unknown.error]).toEqual([
        404,
        'ACCOUNT_NOT_FOUND',
      ]);
      const malformed = await follow(me, { id: 'not-an-id' });
      expect([malformed.status, malformed.error]).toEqual([
        404,
        'ACCOUNT_NOT_FOUND',
      ]);
    });

    it('fills the Following feed with originals from followed accounts only, newest first', async () => {
      const followed = await seller();
      const stranger = await seller();
      const viewer = await customer();
      const reposter = await customer();
      await follow(viewer, followed);
      await follow(viewer, reposter);

      const older = await createPublishedReel(testApp, followed.externalId);
      await createPublishedReel(testApp, stranger.externalId);
      const newer = await createPublishedReel(testApp, followed.externalId);
      // A followed account's repost of a stranger's reel is not an original by a followed account.
      const reposted = await createPublishedReel(testApp, stranger.externalId);
      await api().post(`/api/reels/${reposted.id}/repost`, {
        token: reposter.token,
      });

      const page = await api().get<Page<ReelDto>>('/api/reels/following', {
        token: viewer.token,
        query: { limit: 25 },
      });

      expect(ids(page.data)).toEqual([newer.id, older.id]);
      expect(page.data.items.every((item) => item.repostedBy === null)).toBe(
        true,
      );
    });

    it('pages the Following feed and the followed accounts by cursor, without a repeat or a gap', async () => {
      const viewer = await customer();
      const creators: Person[] = [];
      const reels: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const creator = await seller();
        await follow(viewer, creator);
        creators.push(creator);
        reels.push((await createPublishedReel(testApp, creator.externalId)).id);
      }

      const pagesOf = async <T extends { id: string }>(path: string) => {
        const collected: string[] = [];
        let cursor: string | null | undefined;
        let pages = 0;
        do {
          const res = await api().get<Page<T>>(path, {
            token: viewer.token,
            query: { limit: 2, cursor: cursor ?? undefined },
          });
          expect(res.status).toBe(200);
          collected.push(...ids(res.data));
          cursor = res.data.nextCursor;
          pages += 1;
        } while (cursor !== null && pages < 10);
        return { collected, pages };
      };

      const reelPages = await pagesOf<ReelDto>('/api/reels/following');
      expect(reelPages.collected).toEqual([...reels].reverse());
      expect(reelPages.pages).toBe(3);

      const people = await pagesOf<FollowedUserDto>('/api/reels/me/following');
      expect(people.collected).toEqual(
        [...creators].reverse().map((creator) => creator.id),
      );
      expect(people.pages).toBe(3);
    });
  });

  describe('blocking (FR-047, FR-048)', () => {
    it('hides reels and comments both ways, and unblocking brings them back', async () => {
      const blockerSeller = await seller();
      const blockedSeller = await seller();
      const bystander = await customer();
      const blockerReel = await createPublishedReel(
        testApp,
        blockerSeller.externalId,
      );
      const blockedReel = await createPublishedReel(
        testApp,
        blockedSeller.externalId,
      );
      // Each comments on a reel everyone can see.
      const stage = await createPublishedReel(
        testApp,
        (await seller()).externalId,
      );
      const commentBy = (who: Person, text: string) =>
        api().post(`/api/reels/${stage.id}/comments`, {
          token: who.token,
          body: { text },
        });
      await commentBy(blockerSeller, 'from the blocker');
      await commentBy(blockedSeller, 'from the blocked');
      await commentBy(bystander, 'from a bystander');
      const authorsSeenBy = async (who: Person) =>
        (
          await api().get<{ items: CommentDto[] }>(
            `/api/reels/${stage.id}/comments`,
            { token: who.token },
          )
        ).data.items.map((item) => item.authorId);

      expect((await block(blockerSeller, blockedSeller)).data.blocked).toBe(
        true,
      );

      // The blocker no longer sees the blocked account's reels or comments...
      expect(await feed(blockerSeller)).not.toContain(blockedReel.id);
      expect(await authorsSeenBy(blockerSeller)).not.toContain(
        blockedSeller.id,
      );
      // ...and the blocked account no longer sees the blocker's (FR-047: both ways).
      expect(await feed(blockedSeller)).not.toContain(blockerReel.id);
      expect(await authorsSeenBy(blockedSeller)).not.toContain(
        blockerSeller.id,
      );
      expect((await profileOf(blockerSeller, blockedSeller)).status).toBe(404);
      expect((await profileOf(blockedSeller, blockerSeller)).status).toBe(404);
      // A bystander still sees both.
      expect(await feed(bystander)).toEqual(
        expect.arrayContaining([blockerReel.id, blockedReel.id]),
      );
      expect(await authorsSeenBy(bystander)).toEqual(
        expect.arrayContaining([blockerSeller.id, blockedSeller.id]),
      );

      expect((await block(blockerSeller, blockedSeller)).data.blocked).toBe(
        false,
      );

      expect(await feed(blockerSeller)).toContain(blockedReel.id);
      expect(await feed(blockedSeller)).toContain(blockerReel.id);
      expect(await authorsSeenBy(blockerSeller)).toContain(blockedSeller.id);
    });

    it('touches nothing in China Parts: the account can still sign in and act', async () => {
      const blocker = await customer();
      const blocked = await customer();
      await block(blocker, blocked);

      const me = await api().get<MeDto>('/api/users/me', {
        token: blocked.token,
      });
      expect(me.status).toBe(200);
    });
  });

  describe('editing your own profile (EP25)', () => {
    const patch = (who: { token: string }, body: Record<string, unknown>) =>
      api().patch<MeDto>('/api/users/me', { token: who.token, body });

    it('changes the handle and the bio, and /me shows them', async () => {
      const me = await customer();

      const res = await patch(me, { username: 'my.new_handle', bio: 'Hello' });

      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({
        username: 'my.new_handle',
        bio: 'Hello',
      });
      const read = await api().get<MeDto>('/api/users/me', { token: me.token });
      expect(read.data).toMatchObject({
        username: 'my.new_handle',
        bio: 'Hello',
      });
      const profile = await profileOf(me, me);
      expect(profile.data.user.bio).toBe('Hello');
    });

    it('treats a handle that differs only in Arabic spelling as taken (FR-015)', async () => {
      const first = await customer();
      const second = await customer();
      expect((await patch(first, { username: 'أحمد' })).status).toBe(200);

      const res = await patch(second, { username: 'احمد' });

      expect([res.status, res.error]).toEqual([409, 'USERNAME_TAKEN']);
      // Its own handle is not taken from itself.
      expect((await patch(first, { username: 'أحمد' })).status).toBe(200);
    });

    it('treats a handle in another letter case as taken', async () => {
      const first = await customer();
      const second = await customer();
      await patch(first, { username: 'SomeName' });

      const res = await patch(second, { username: 'somename' });

      expect([res.status, res.error]).toEqual([409, 'USERNAME_TAKEN']);
    });

    it.each([
      ['a bio of 151 characters', { bio: 'x'.repeat(151) }],
      ['a handle that is too short', { username: 'ab' }],
      ['a handle that is too long', { username: 'a'.repeat(31) }],
      ['a handle with a space', { username: 'two words' }],
      ['a handle with a symbol', { username: 'a@b#c' }],
      ['a field that does not exist', { followersCount: 1_000_000 }],
    ])('refuses %s', async (_label, body) => {
      const me = await customer();
      const res = await patch(me, body);
      expect([res.status, res.error]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('accepts a bio of exactly 150 characters, counting letters not bytes', async () => {
      const me = await customer();
      const res = await patch(me, { bio: 'ع'.repeat(150) });
      expect(res.status).toBe(200);
    });

    it('is refused for a seller out of good standing (suspended seller 2)', async () => {
      const token = await issueToken(testApp.infra, 'seller', 2);
      const res = await patch({ token }, { bio: 'still here' });
      expect([res.status, res.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
    });

    it('needs a session', async () => {
      const res = await api().patch('/api/users/me', { body: { bio: 'x' } });
      expect([res.status, res.error]).toEqual([401, 'AUTH_REQUIRED']);
    });
  });
});
