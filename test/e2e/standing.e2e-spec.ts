import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE_ACCOUNTS_SYNC } from '../../src/common/queues/queue-names';
import { AccountsRepository } from '../../src/modules/accounts/accounts.repository';
import { StandingService } from '../../src/modules/accounts/standing.service';
import type { Page, ReelDto } from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import { accountIdOf, createPublishedReel, runSync } from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';

/**
 * FR-009, FR-010 (detection), FR-014 and SC-007: when China Parts says an account is no longer in
 * good standing, or no longer exists, the reels service follows within one sync (research R7).
 * Everything here goes through the real sync against the real MySQL; the repeating job is paused
 * and each test runs the sync itself.
 */
describe('Standing, display data and missing accounts (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
    await testApp.app.get<Queue>(getQueueToken(QUEUE_ACCOUNTS_SYNC)).pause();
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const sql = <T = unknown>(query: string, params: unknown[] = []) =>
    testApp.infra.rootQuery<T>(query, params);
  const accountOf = (id: string) =>
    testApp.app.get(AccountsRepository).findByIdLean(id);
  const customer = () => createPerson(testApp, 'customer');
  const seller = () => createPerson(testApp, 'seller');
  const ids = (page: Page<{ id: string }>) => page.items.map((item) => item.id);

  const setSellerStatus = (person: Person, status: string) =>
    sql('UPDATE sellers SET status = ? WHERE id = ?', [
      status,
      person.externalId,
    ]);

  async function forYou(viewer: Person): Promise<string[]> {
    const res = await api().get<Page<ReelDto>>('/api/reels', {
      token: viewer.token,
      query: { limit: 25 },
    });
    expect(res.status).toBe(200);
    return ids(res.data);
  }

  describe('a seller who is suspended (FR-009, SC-007)', () => {
    it('disappears for everyone else after one sync, stays visible to the seller, and cannot write', async () => {
      const merchant = await seller();
      const viewer = await customer();
      const other = await seller();
      const first = await createPublishedReel(testApp, merchant.externalId);
      const second = await createPublishedReel(testApp, merchant.externalId);
      const elsewhere = await createPublishedReel(testApp, other.externalId);
      expect(await forYou(viewer)).toEqual(
        expect.arrayContaining([first.id, second.id, elsewhere.id]),
      );

      await setSellerStatus(merchant, 'suspended');
      const result = await runSync(testApp);
      expect(result.changedStanding).toEqual([merchant.id]);

      // For everyone else: gone from the feed, and a single reel is a 404 (FR-009).
      const feed = await forYou(viewer);
      expect(feed).not.toContain(first.id);
      expect(feed).not.toContain(second.id);
      expect(feed).toContain(elsewhere.id);
      const single = await api().get(`/api/reels/${first.id}`, {
        token: viewer.token,
      });
      expect([single.status, single.error]).toEqual([404, 'REEL_NOT_FOUND']);
      const guest = await api().get(`/api/reels/${first.id}`);
      expect(guest.status).toBe(404);

      // For the seller: still there, with its status.
      const own = await api().get<ReelDto>(`/api/reels/${first.id}`, {
        token: merchant.token,
      });
      expect(own.status).toBe(200);
      expect(own.data.status).toBe('published');
      const ownFeed = await api().get<Page<ReelDto>>('/api/reels', {
        token: merchant.token,
        query: { creatorId: merchant.id, limit: 25 },
      });
      expect(ids(ownFeed.data)).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );

      // And the seller can read, but not write (FR-008): the sync dropped the cached standing, so
      // this is the very next request, not one a minute later.
      const read = await api().get('/api/reels/liked', {
        token: merchant.token,
      });
      expect(read.status).toBe(200);
      const like = await api().post(`/api/reels/${elsewhere.id}/like`, {
        token: merchant.token,
      });
      expect([like.status, like.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
    });

    it('is back after reinstatement and the next sync (FR-014)', async () => {
      const merchant = await seller();
      const viewer = await customer();
      const other = await seller();
      const reel = await createPublishedReel(testApp, merchant.externalId);
      const elsewhere = await createPublishedReel(testApp, other.externalId);

      await setSellerStatus(merchant, 'suspended');
      await runSync(testApp);
      expect(await forYou(viewer)).not.toContain(reel.id);

      await setSellerStatus(merchant, 'approved');
      const result = await runSync(testApp);
      expect(result.changedStanding).toEqual([merchant.id]);

      expect(await forYou(viewer)).toContain(reel.id);
      const like = await api().post(`/api/reels/${elsewhere.id}/like`, {
        token: merchant.token,
      });
      expect(like.status).toBe(201);
    });

    it('is not touched by a sync that finds nothing changed', async () => {
      const merchant = await seller();
      await createPublishedReel(testApp, merchant.externalId);
      await runSync(testApp);

      const again = await runSync(testApp);
      expect(again.changedStanding).toEqual([]);
      expect(again.newlyDeleted).toEqual([]);
    });
  });

  describe('comments by an account out of good standing (FR-009)', () => {
    it("leave the thread for everyone else after a sync, and stay in the commenter's own view", async () => {
      const creator = await seller();
      const commenter = await customer();
      const reader = await customer();
      const reel = await createPublishedReel(testApp, creator.externalId);
      await api().post(`/api/reels/${reel.id}/comments`, {
        token: commenter.token,
        body: { text: 'a comment from someone about to be suspended' },
      });
      const thread = async (who: Person) =>
        (
          await api().get<{ items: Array<{ authorId: string }> }>(
            `/api/reels/${reel.id}/comments`,
            { token: who.token },
          )
        ).data.items.map((item) => item.authorId);
      expect(await thread(reader)).toEqual([commenter.id]);

      await sql('UPDATE customers SET status = 0 WHERE id = ?', [
        commenter.externalId,
      ]);
      await runSync(testApp);

      expect(await thread(reader)).toEqual([]);
      expect(await thread(commenter)).toEqual([commenter.id]);
    });
  });

  describe('a customer whose status changes without updated_at (R7)', () => {
    it('is still found, because the sync reads every account and not only the recently updated', async () => {
      const buyer = await customer();
      const [row] = await sql<Array<{ updated_at: Date }>>(
        'SELECT updated_at FROM customers WHERE id = ?',
        [buyer.externalId],
      );

      // Laravel can change a row without touching `updated_at`: put the old value back.
      await sql(
        'UPDATE customers SET status = 0, updated_at = ? WHERE id = ?',
        [row.updated_at, buyer.externalId],
      );
      const result = await runSync(testApp);

      expect(result.changedStanding).toEqual([buyer.id]);
      const target = await createPublishedReel(
        testApp,
        (await seller()).externalId,
      );
      const like = await api().post(`/api/reels/${target.id}/like`, {
        token: buyer.token,
      });
      expect([like.status, like.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
    });
  });

  describe('display data', () => {
    it("follows a shop's name in China Parts after a sync", async () => {
      const merchant = await seller();
      const viewer = await customer();
      const reel = await createPublishedReel(testApp, merchant.externalId);
      const nameOnReel = async () =>
        (
          await api().get<ReelDto>(`/api/reels/${reel.id}`, {
            token: viewer.token,
          })
        ).data.creator.name;

      await sql(
        `INSERT INTO shops (seller_id, name, created_at, updated_at)
         VALUES (?, 'Original Shop', NOW(), NOW())`,
        [merchant.externalId],
      );
      await runSync(testApp);
      expect(await nameOnReel()).toBe('Original Shop');

      await sql("UPDATE shops SET name = 'Renamed Shop' WHERE seller_id = ?", [
        merchant.externalId,
      ]);
      // Until the sync runs, the old name stands.
      expect(await nameOnReel()).toBe('Original Shop');
      const result = await runSync(testApp);
      expect(await nameOnReel()).toBe('Renamed Shop');
      // A rename is not a change of standing.
      expect(result.changedStanding).toEqual([]);
    });
  });

  describe('an account China Parts no longer has (FR-010)', () => {
    it('is stamped on the first sync, and deleted and excluded on the second', async () => {
      // Customer 3 is in the fixtures, inactive. Giving it a reels account first.
      const id = await accountIdOf(testApp, 'customer', 3);
      const standing = testApp.app.get(StandingService);
      expect((await accountOf(id))?.standing).toBe('suspended');

      await sql('DELETE FROM customers WHERE id = 3');

      const first = await runSync(testApp);
      const afterFirst = await accountOf(id);
      expect(afterFirst?.missingSince).toBeInstanceOf(Date);
      expect(afterFirst?.standing).toBe('suspended');
      expect(first.newlyDeleted).toEqual([]);

      const second = await runSync(testApp);
      const afterSecond = await accountOf(id);
      expect(afterSecond?.standing).toBe('deleted');
      expect(second.newlyDeleted).toEqual([id]);
      expect(await standing.isExcluded(id)).toBe(true);
    });

    it('is forgiven when the row comes back before the second sync', async () => {
      const buyer = await customer();
      const [row] = await sql<
        Array<{
          first_name: string;
          last_name: string;
        }>
      >('SELECT first_name, last_name FROM customers WHERE id = ?', [
        buyer.externalId,
      ]);

      await sql('DELETE FROM customers WHERE id = ?', [buyer.externalId]);
      await runSync(testApp);
      expect((await accountOf(buyer.id))?.missingSince).toBeInstanceOf(Date);

      await sql(
        `INSERT INTO customers (id, first_name, last_name, password, status, created_at, updated_at)
         VALUES (?, ?, ?, 'x', 1, NOW(), NOW())`,
        [buyer.externalId, row.first_name, row.last_name],
      );
      const result = await runSync(testApp);

      const account = await accountOf(buyer.id);
      expect(account?.missingSince).toBeNull();
      expect(account?.standing).toBe('good');
      expect(result.newlyDeleted).toEqual([]);
    });
  });

  describe('when China Parts cannot be reached', () => {
    afterEach(async () => {
      await testApp.infra.startMysql().catch(() => undefined);
    });

    it('fails the run and changes nothing: an outage is not a deleted account', async () => {
      const gone = await customer();
      const suspended = await seller();
      await sql('DELETE FROM customers WHERE id = ?', [gone.externalId]);
      await setSellerStatus(suspended, 'suspended');
      await testApp.infra.stopMysql();

      await expect(runSync(testApp)).rejects.toThrow();

      const goneAccount = await accountOf(gone.id);
      expect(goneAccount?.missingSince).toBeNull();
      expect(goneAccount?.standing).toBe('good');
      expect((await accountOf(suspended.id))?.standing).toBe('good');
      expect(
        await testApp.app.get(StandingService).isExcluded(suspended.id),
      ).toBe(false);
    });
  });

  // Last: it removes China Parts rows for good, which would trip the breaker for any later sync.
  describe('the mass-miss breaker', () => {
    it('marks nothing when a dozen accounts vanish at once, and logs an error', async () => {
      const vanished: Person[] = [];
      for (let i = 0; i < 12; i += 1) vanished.push(await customer());
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

      try {
        await sql('DELETE FROM customers WHERE id IN (?)', [
          vanished.map((person) => person.externalId),
        ]);

        // Twice, because two misses is what would delete them.
        const first = await runSync(testApp);
        const second = await runSync(testApp);

        expect(first.newlyDeleted).toEqual([]);
        expect(second.newlyDeleted).toEqual([]);
        for (const person of vanished) {
          const account = await accountOf(person.id);
          expect(account?.missingSince).toBeNull();
          expect(account?.standing).toBe('good');
        }
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('missing from China Parts'),
        );
      } finally {
        error.mockRestore();
      }
    });
  });
});
