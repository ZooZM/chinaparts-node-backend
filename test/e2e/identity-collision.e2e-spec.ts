import type { MeDto } from '../../src/modules/accounts/accounts.service';
import type {
  CreatorProfileDto,
  Page,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import { createPublishedReel } from '../utils/fixtures';
import { createPerson } from '../utils/people';
import { issueToken } from '../utils/tokens';

/**
 * SC-005. China Parts numbers its customers and its sellers separately, so customer 1 and seller 1
 * are two people who happen to share a number. The reels service must never treat them as one.
 * These are the real fixture accounts: customer 1 (Sara Khalid) and seller 1 (Ahmed Salem).
 */
describe('Customer 1 and seller 1 (e2e)', () => {
  let testApp: TestApp;
  let customerToken: string;
  let sellerToken: string;
  let reelA: string;
  let reelB: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    customerToken = await issueToken(testApp.infra, 'customer', 1);
    sellerToken = await issueToken(testApp.infra, 'seller', 1);

    const creator = await createPerson(testApp, 'seller');
    reelA = (await createPublishedReel(testApp, creator.externalId)).id;
    reelB = (await createPublishedReel(testApp, creator.externalId)).id;
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const ids = (page: Page<{ id: string }>) => page.items.map((item) => item.id);

  it('are two accounts: GET /api/users/me gives different ids and account types (EP24)', async () => {
    const customer = await api().get<MeDto>('/api/users/me', {
      token: customerToken,
    });
    const seller = await api().get<MeDto>('/api/users/me', {
      token: sellerToken,
    });

    expect(customer.status).toBe(200);
    expect(seller.status).toBe(200);
    expect(customer.data.accountType).toBe('customer');
    expect(seller.data.accountType).toBe('seller');
    expect(customer.data.id).not.toBe(seller.data.id);
    expect(customer.data.username).not.toBe(seller.data.username);
  });

  it('need a session to ask who they are', async () => {
    const res = await api().get('/api/users/me');
    expect([res.status, res.error]).toEqual([401, 'AUTH_REQUIRED']);
  });

  describe('keep their reactions apart', () => {
    beforeAll(async () => {
      // The customer likes A and saves B. The seller does the opposite.
      await api().post(`/api/reels/${reelA}/like`, { token: customerToken });
      await api().post(`/api/reels/${reelB}/save`, { token: customerToken });
      await api().post(`/api/reels/${reelB}/like`, { token: sellerToken });
      await api().post(`/api/reels/${reelA}/save`, { token: sellerToken });
    });

    it("a like by one never shows as the other's", async () => {
      const get = (reel: string, token: string) =>
        api().get<ReelDto>(`/api/reels/${reel}`, { token });

      const aSeenByCustomer = (await get(reelA, customerToken)).data;
      const aSeenBySeller = (await get(reelA, sellerToken)).data;
      expect([aSeenByCustomer.viewerLiked, aSeenBySeller.viewerLiked]).toEqual([
        true,
        false,
      ]);

      const bSeenByCustomer = (await get(reelB, customerToken)).data;
      const bSeenBySeller = (await get(reelB, sellerToken)).data;
      expect([bSeenByCustomer.viewerLiked, bSeenBySeller.viewerLiked]).toEqual([
        false,
        true,
      ]);
      // Each reel has exactly one like, whoever's it is.
      expect(aSeenByCustomer.likesCount).toBe(1);
      expect(bSeenBySeller.likesCount).toBe(1);
    });

    it("a save by one never shows as the other's", async () => {
      const aSeenBySeller = (
        await api().get<ReelDto>(`/api/reels/${reelA}`, { token: sellerToken })
      ).data;
      const bSeenByCustomer = (
        await api().get<ReelDto>(`/api/reels/${reelB}`, {
          token: customerToken,
        })
      ).data;
      expect(aSeenBySeller.viewerSaved).toBe(true);
      expect(bSeenByCustomer.viewerSaved).toBe(true);

      const aSeenByCustomer = (
        await api().get<ReelDto>(`/api/reels/${reelA}`, {
          token: customerToken,
        })
      ).data;
      expect(aSeenByCustomer.viewerSaved).toBe(false);
    });

    it('have disjoint Liked and Saved lists', async () => {
      const list = async (kind: 'liked' | 'saved', token: string) =>
        ids(
          (await api().get<Page<ReelDto>>(`/api/reels/${kind}`, { token }))
            .data,
        );

      const likedByCustomer = await list('liked', customerToken);
      const likedBySeller = await list('liked', sellerToken);
      const savedByCustomer = await list('saved', customerToken);
      const savedBySeller = await list('saved', sellerToken);

      expect(likedByCustomer).toEqual([reelA]);
      expect(likedBySeller).toEqual([reelB]);
      expect(savedByCustomer).toEqual([reelB]);
      expect(savedBySeller).toEqual([reelA]);
      expect(
        likedByCustomer.filter((id) => likedBySeller.includes(id)),
      ).toEqual([]);
      expect(
        savedByCustomer.filter((id) => savedBySeller.includes(id)),
      ).toEqual([]);
    });
  });

  it('follow separately: one following a creator does not make the other a follower', async () => {
    const creator = await createPerson(testApp, 'seller');
    const follow = await api().post<{
      following: boolean;
      followersCount: number;
    }>(`/api/users/${creator.id}/follow`, { token: customerToken });
    expect(follow.data).toEqual({ following: true, followersCount: 1 });

    const bySeller = await api().get<CreatorProfileDto>(
      `/api/users/${creator.id}/profile`,
      { token: sellerToken },
    );
    expect(bySeller.data.viewer.following).toBe(false);
    expect(bySeller.data.stats.followers).toBe(1);
  });
});
