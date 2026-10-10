import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { QUEUE_ACCOUNTS_CLEANUP } from '../../src/common/queues/queue-names';
import { StorageService } from '../../src/common/storage/storage.service';
import { StandingService } from '../../src/modules/accounts/standing.service';
import { AccountCleanupService } from '../../src/modules/reels/lifecycle/account-cleanup.service';
import type {
  CommentDto,
  Page,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import {
  createPublishedReel,
  drainQueue,
  reelModel,
  runSync,
} from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';
import { issueToken } from '../utils/tokens';

/** FR-010: an account China Parts no longer has leaves nothing behind in the reels data. */
describe('Deleted accounts (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const db = () => testApp.app.get<Connection>(getConnectionToken()).db;
  const count = async (collection: string, filter: object) =>
    (await db()?.collection(collection).countDocuments(filter)) ?? 0;
  const oid = (id: string) => new Types.ObjectId(id);
  const sql = (query: string, params: unknown[] = []) =>
    testApp.infra.rootQuery(query, params);
  const account = async (id: string) =>
    db()
      ?.collection('reels_accounts')
      .findOne({ _id: oid(id) });

  /** China Parts deletes the row; two syncs agree it is gone; the cleanup job runs. */
  async function deleteInChinaParts(
    table: 'customers' | 'sellers',
    person: Person,
  ) {
    await sql(`DELETE FROM ${table} WHERE id = ?`, [person.externalId]);
    const first = await runSync(testApp);
    expect(first.newlyDeleted).toEqual([]);
    expect((await account(person.id))?.missingSince).toBeTruthy();
    const second = await runSync(testApp);
    expect(second.newlyDeleted).toEqual([person.id]);
    await drainQueue(testApp, QUEUE_ACCOUNTS_CLEANUP);
  }

  it("removes a customer's footprint, corrects every counter, and deletes the account", async () => {
    await testApp.resetReelsData();
    const creator = await createPerson(testApp, 'seller');
    const leaver = await createPerson(testApp, 'customer');
    const follower = await createPerson(testApp, 'customer');
    const blocker = await createPerson(testApp, 'customer');
    const blocked = await createPerson(testApp, 'customer');
    const bystander = await createPerson(testApp, 'customer');

    const r1 = await createPublishedReel(testApp, creator.externalId);
    const r2 = await createPublishedReel(testApp, creator.externalId);
    await api().put(`/api/reels/${r1.id}/products`, {
      token: creator.token,
      body: { productIds: [] },
    });
    await reelModel(testApp).updateOne(
      { _id: r1.id },
      {
        $set: { productLinks: [{ productId: 101, position: 0, tapsCount: 0 }] },
      },
    );

    // What the leaver did.
    const as = (who: Person) => ({ token: who.token });
    await api().post(`/api/reels/${r1.id}/like`, as(leaver));
    await api().post(`/api/reels/${r2.id}/like`, as(leaver));
    await api().post(`/api/reels/${r1.id}/save`, as(leaver));
    await api().post(`/api/reels/${r1.id}/view`, as(leaver));
    await api().post(`/api/reels/${r1.id}/share`, as(leaver));
    await api().post(`/api/reels/${r1.id}/repost`, as(leaver));
    await api().post(`/api/reels/${r2.id}/report`, {
      ...as(leaver),
      body: { reason: 'spam' },
    });
    await api().post(`/api/reels/${r1.id}/products/101/tap`, as(leaver));
    const leaverComment = (
      await api().post<{ comment: CommentDto }>(
        `/api/reels/${r1.id}/comments`,
        {
          ...as(leaver),
          body: { text: 'a comment by the leaver' },
        },
      )
    ).data.comment.id;
    const keptComment = (
      await api().post<{ comment: CommentDto }>(
        `/api/reels/${r1.id}/comments`,
        {
          ...as(bystander),
          body: { text: 'a comment by someone who stays' },
        },
      )
    ).data.comment.id;
    await api().post(`/api/reels/${r1.id}/comments/${keptComment}/report`, {
      ...as(leaver),
      body: { reason: 'spam' },
    });
    await api().post(`/api/users/${creator.id}/follow`, as(leaver));
    await api().post(`/api/users/${leaver.id}/follow`, as(follower));
    await api().post(`/api/users/${blocked.id}/block`, as(leaver));
    await api().post(`/api/users/${leaver.id}/block`, as(blocker));

    // Before: it is all there.
    expect(await count('reel_likes', { userId: oid(leaver.id) })).toBe(2);
    expect((await reelModel(testApp).findById(r1.id).exec())?.likesCount).toBe(
      1,
    );
    expect((await account(creator.id))?.totalLikes).toBe(2);
    expect((await account(creator.id))?.followersCount).toBe(1);
    expect((await account(follower.id))?.followingCount).toBe(1);
    expect(
      (await reelModel(testApp).findById(r1.id).exec())?.commentsCount,
    ).toBe(2);
    expect(
      (await reelModel(testApp).findById(r2.id).exec())?.reportsCount,
    ).toBe(1);

    await deleteInChinaParts('customers', leaver);

    // The account is gone, and out of the standing set.
    expect(await account(leaver.id)).toBeNull();
    expect(await testApp.app.get(StandingService).isExcluded(leaver.id)).toBe(
      false,
    );

    // Nothing refers to it any more.
    const me = oid(leaver.id);
    expect(await count('reel_likes', { userId: me })).toBe(0);
    expect(await count('reel_saves', { userId: me })).toBe(0);
    expect(await count('reel_views', { userId: me })).toBe(0);
    expect(await count('reel_shares', { userId: me })).toBe(0);
    expect(await count('reel_reposts', { reposterId: me })).toBe(0);
    expect(await count('reel_reports', { reporterId: me })).toBe(0);
    expect(await count('reel_comment_reports', { reporterId: me })).toBe(0);
    expect(
      await count('follows', { $or: [{ followerId: me }, { followeeId: me }] }),
    ).toBe(0);
    expect(await count('reels_accounts', { blockedUsers: me })).toBe(0);
    expect(
      await count('notification_events', {
        $or: [{ actorId: me }, { recipientId: me }],
      }),
    ).toBe(0);
    expect(await count('reel_product_taps', { viewerId: me })).toBe(0);

    // The tap itself stays; only who tapped is forgotten.
    expect(
      await count('reel_product_taps', { videoId: oid(r1.id), productId: 101 }),
    ).toBe(1);
    // The comment is kept for audit, never served, and marked as the system's doing.
    const stored = await db()
      ?.collection('reel_comments')
      .findOne({ _id: oid(leaverComment) });
    expect(stored?.deletedByRole).toBe('system');
    const served = await api().get<{ items: CommentDto[] }>(
      `/api/reels/${r1.id}/comments`,
    );
    expect(served.data.items.map((item) => item.id)).toEqual([keptComment]);

    // Every counter is right again.
    const first = await reelModel(testApp).findById(r1.id).exec();
    const second = await reelModel(testApp).findById(r2.id).exec();
    expect([first?.likesCount, second?.likesCount]).toEqual([0, 0]);
    expect(first?.commentsCount).toBe(1);
    expect(second?.reportsCount).toBe(0);
    expect((await account(creator.id))?.totalLikes).toBe(0);
    expect((await account(creator.id))?.followersCount).toBe(0);
    expect((await account(follower.id))?.followingCount).toBe(0);

    // Other people's own state is untouched.
    expect(
      await count('reel_comments', { _id: oid(keptComment), deletedAt: null }),
    ).toBe(1);
    expect((await account(blocker.id))?.blockedUsers).toEqual([]);
    expect(await account(bystander.id)).not.toBeNull();
  });

  it("removes a seller's reels, their files in both buckets, their place in search, and the likes and comments on them", async () => {
    const departing = await createPerson(testApp, 'seller');
    const fan = await createPerson(testApp, 'customer');
    const storage = testApp.app.get(StorageService);
    const reel = await createPublishedReel(testApp, departing.externalId, {
      hashtags: ['departingtag'],
    });
    await api().post(`/api/reels/${reel.id}/like`, { token: fan.token });
    await api().post(`/api/reels/${reel.id}/comments`, {
      token: fan.token,
      body: { text: 'a comment on a reel that will go' },
    });
    await api().post(`/api/users/${departing.id}/follow`, { token: fan.token });
    const search = async () =>
      (
        await api().get<Page<ReelDto>>('/api/reels/search', {
          token: fan.token,
          query: { q: 'departingtag' },
        })
      ).data.items.map((item) => item.id);
    expect(await search()).toEqual([reel.id]);
    expect(
      await storage.head(storage.publicBucket, `reels/${reel.id}/video.mp4`),
    ).not.toBeNull();

    await deleteInChinaParts('sellers', departing);

    expect(await account(departing.id)).toBeNull();
    expect(await reelModel(testApp).findById(reel.id).exec()).toBeNull();
    for (const key of [
      `reels/${reel.id}/video.mp4`,
      `reels/${reel.id}/thumb.jpg`,
    ]) {
      expect(await storage.head(storage.publicBucket, key)).toBeNull();
      expect(await storage.head(storage.privateBucket, key)).toBeNull();
    }
    expect(await search()).toEqual([]);
    expect(await count('reel_likes', { videoId: oid(reel.id) })).toBe(0);
    expect(await count('reel_comments', { videoId: oid(reel.id) })).toBe(0);
    expect(await count('follows', { followeeId: oid(departing.id) })).toBe(0);
    expect((await account(fan.id))?.followingCount).toBe(0);
    const gone = await api().get(`/api/reels/${reel.id}`);
    expect([gone.status, gone.error]).toEqual([404, 'REEL_NOT_FOUND']);
  });

  it('is safe to run twice: the second job finds nothing and changes nothing', async () => {
    const creator = await createPerson(testApp, 'seller');
    const leaver = await createPerson(testApp, 'customer');
    const reel = await createPublishedReel(testApp, creator.externalId);
    await api().post(`/api/reels/${reel.id}/like`, { token: leaver.token });
    await deleteInChinaParts('customers', leaver);
    const before = await reelModel(testApp).findById(reel.id).exec();

    await testApp.app.get(AccountCleanupService).cleanUp(leaver.id);

    const after = await reelModel(testApp).findById(reel.id).exec();
    expect(after?.likesCount).toBe(before?.likesCount);
    expect(after?.likesCount).toBe(0);
  });

  it('does not touch an account that is only suspended', async () => {
    const creator = await createPerson(testApp, 'seller');
    const suspended = await createPerson(testApp, 'customer');
    const reel = await createPublishedReel(testApp, creator.externalId);
    await api().post(`/api/reels/${reel.id}/like`, { token: suspended.token });

    await sql('UPDATE customers SET status = 0 WHERE id = ?', [
      suspended.externalId,
    ]);
    await runSync(testApp);
    await runSync(testApp);
    await drainQueue(testApp, QUEUE_ACCOUNTS_CLEANUP);

    expect(await account(suspended.id)).not.toBeNull();
    expect(await count('reel_likes', { userId: oid(suspended.id) })).toBe(1);
  });

  it('does not touch a fixture account China Parts still has', async () => {
    const token = await issueToken(testApp.infra, 'customer', 1);
    const me = await api().get<{ id: string }>('/api/users/me', { token });
    await runSync(testApp);
    await runSync(testApp);
    await drainQueue(testApp, QUEUE_ACCOUNTS_CLEANUP);
    expect(await account(me.data.id)).not.toBeNull();
  });
});
