import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { normalizeForMatch } from '../../src/common/text/normalize-for-match';
import {
  ReelsAccount,
  ReelsAccountDocument,
} from '../../src/modules/accounts/schemas/reels-account.schema';
import type {
  Page,
  ReelDto,
  UserSearchResultDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import { createPublishedReel, createReel, runSync } from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';
import { issueToken } from '../utils/tokens';

/** FR-049 to FR-051 and SC-009: Arabic-aware search of hashtags and accounts. */
describe('Search (e2e)', () => {
  let testApp: TestApp;
  let viewer: Person;
  let creator: Person;
  const reelsByTag = new Map<string, string>();

  beforeAll(async () => {
    testApp = await createTestApp();
    viewer = await createPerson(testApp, 'customer');
    creator = await createPerson(testApp, 'seller');
    // Each tag is stored as typed, with the matching form beside it.
    for (const tag of ['إطارات', 'كامري_٢٠١٨', 'OilFilter', 'فلتر_زيت']) {
      reelsByTag.set(
        tag,
        (
          await createPublishedReel(testApp, creator.externalId, {
            description: `#${tag}`,
            hashtags: [tag],
          })
        ).id,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const ids = (page: Page<{ id: string }>) => page.items.map((item) => item.id);
  const searchReels = (q: string, who: { token: string } = viewer) =>
    api().get<Page<ReelDto>>('/api/reels/search', {
      token: who.token,
      query: { q },
    });

  describe('reels by hashtag (FR-049)', () => {
    it.each([
      ['اطار', 'إطارات', 'an Arabic query without the alef hamza'],
      ['إطار', 'إطارات', 'the same query with it'],
      ['2018', 'كامري_٢٠١٨', 'Western digits against Arabic-Indic ones'],
      ['٢٠١٨', 'كامري_٢٠١٨', 'Arabic-Indic digits against the same'],
      ['oilfilter', 'OilFilter', 'lower case against mixed case'],
      ['OILFILTER', 'OilFilter', 'upper case against mixed case'],
      ['فلتر', 'فلتر_زيت', 'part of a tag with an underscore'],
      ['#فلتر', 'فلتر_زيت', 'a query that starts with the hash'],
    ])('finds %p under #%s: %s', async (q, tag) => {
      const res = await searchReels(q);

      expect(res.status).toBe(200);
      expect(ids(res.data)).toContain(reelsByTag.get(tag));
    });

    it('returns the hashtags as they were typed, not as they were matched', async () => {
      const res = await searchReels('اطار');
      const reel = res.data.items.find(
        (item) => item.id === reelsByTag.get('إطارات'),
      );
      expect(reel?.hashtags).toEqual(['إطارات']);
    });

    it('finds nothing for a query that matches nothing, and the cursor ends', async () => {
      const res = await searchReels('nosuchtagatall');
      expect(res.data).toEqual({ items: [], nextCursor: null });
    });

    it('refuses a query of only whitespace', async () => {
      const res = await searchReels('   ');
      expect([res.status, res.error]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('needs a session', async () => {
      const res = await api().get('/api/reels/search', { query: { q: 'x' } });
      expect([res.status, res.error]).toEqual([401, 'AUTH_REQUIRED']);
    });

    it('does not mistake a symbol in the query for a pattern', async () => {
      for (const q of ['.*', '[a-z]', '(', 'a|b', '\\']) {
        const res = await searchReels(q);
        expect([q, res.status]).toEqual([q, 200]);
        expect(res.data.items).toEqual([]);
      }
    });

    it('pages by cursor without a repeat or a gap', async () => {
      const paged = await createPerson(testApp, 'seller');
      const made: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        made.push(
          (
            await createPublishedReel(testApp, paged.externalId, {
              hashtags: ['pagedtag'],
            })
          ).id,
        );
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const res = await api().get<Page<ReelDto>>('/api/reels/search', {
          token: viewer.token,
          query: { q: 'pagedtag', limit: 2, cursor: cursor ?? undefined },
        });
        expect(res.status).toBe(200);
        collected.push(...ids(res.data));
        cursor = res.data.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(collected).toEqual([...made].reverse());
      expect(pages).toBe(3);
    });
  });

  describe('what search leaves out (FR-051)', () => {
    it('leaves out reels that are not published', async () => {
      const owner = await createPerson(testApp, 'seller');
      const visible = await createPublishedReel(testApp, owner.externalId, {
        hashtags: ['unpublishedtest'],
      });
      for (const status of [
        'pending_moderation',
        'rejected',
        'hidden',
      ] as const) {
        await createReel(testApp, owner.externalId, {
          status,
          hashtags: ['unpublishedtest'],
        });
      }

      const res = await searchReels('unpublishedtest');

      expect(ids(res.data)).toEqual([visible.id]);
    });

    it('leaves out the reels of accounts the viewer blocked, or that blocked the viewer', async () => {
      const blockedByViewer = await createPerson(testApp, 'seller');
      const blockingViewer = await createPerson(testApp, 'seller');
      const fine = await createPerson(testApp, 'seller');
      const reels: Record<string, string> = {};
      for (const [name, who] of Object.entries({
        blockedByViewer,
        blockingViewer,
        fine,
      })) {
        reels[name] = (
          await createPublishedReel(testApp, who.externalId, {
            hashtags: ['blocktest'],
          })
        ).id;
      }
      await api().post(`/api/users/${blockedByViewer.id}/block`, {
        token: viewer.token,
      });
      await api().post(`/api/users/${viewer.id}/block`, {
        token: blockingViewer.token,
      });

      const res = await searchReels('blocktest');

      expect(ids(res.data)).toEqual([reels.fine]);
    });

    it("leaves out a suspended seller's reels after the sync (FR-009)", async () => {
      const merchant = await createPerson(testApp, 'seller');
      const reel = await createPublishedReel(testApp, merchant.externalId, {
        hashtags: ['suspendtest'],
      });
      expect(ids((await searchReels('suspendtest')).data)).toEqual([reel.id]);

      await testApp.infra.rootQuery(
        "UPDATE sellers SET status = 'suspended' WHERE id = ?",
        [merchant.externalId],
      );
      await runSync(testApp);

      expect((await searchReels('suspendtest')).data.items).toEqual([]);
    });

    it('stops matching a tag once its last reel is deleted, and starts again when one is published', async () => {
      const owner = await createPerson(testApp, 'seller');
      const only = await createPublishedReel(testApp, owner.externalId, {
        hashtags: ['ephemeraltag'],
      });
      expect(ids((await searchReels('ephemeral')).data)).toEqual([only.id]);

      await api().delete(`/api/reels/${only.id}`, { token: owner.token });
      expect((await searchReels('ephemeral')).data.items).toEqual([]);

      const again = await createPublishedReel(testApp, owner.externalId, {
        hashtags: ['ephemeraltag'],
      });
      expect(ids((await searchReels('ephemeral')).data)).toEqual([again.id]);
    });
  });

  describe('the hashtag feed (FR-049a)', () => {
    it('returns the reels tagged in any spelling of the tag, each showing its tag as typed', async () => {
      const owner = await createPerson(testApp, 'seller');
      const hamza = await createPublishedReel(testApp, owner.externalId, {
        hashtags: ['إطارات'],
      });
      const plain = await createPublishedReel(testApp, owner.externalId, {
        hashtags: ['اطارات'],
      });
      const other = await createPublishedReel(testApp, owner.externalId, {
        hashtags: ['اطارات_جديدة'],
      });

      const res = await api().get<Page<ReelDto>>('/api/reels', {
        token: viewer.token,
        query: { hashtag: 'اطارات', limit: 25 },
      });

      expect(res.status).toBe(200);
      expect(ids(res.data)).toContain(hamza.id);
      expect(ids(res.data)).toContain(plain.id);
      expect(ids(res.data)).not.toContain(other.id);
      const shown = new Map(
        res.data.items.map((item) => [item.id, item.hashtags]),
      );
      expect(shown.get(hamza.id)).toEqual(['إطارات']);
      expect(shown.get(plain.id)).toEqual(['اطارات']);
      expect(res.data.nextCursor).toBeNull();
    });
  });

  describe('accounts (FR-050, EP26)', () => {
    const searchUsers = (
      q: string,
      who: { token: string } = viewer,
      extra = {},
    ) =>
      api().get<Page<UserSearchResultDto>>('/api/users/search', {
        token: who.token,
        query: { q, ...extra },
      });

    it('finds أحمد by احمد, a handle in another spelling', async () => {
      const ahmed = await createPerson(testApp, 'customer', {
        firstName: 'أحمد',
      });
      await api().patch('/api/users/me', {
        token: ahmed.token,
        body: { username: 'أحمد_الصالح' },
      });

      const res = await searchUsers('احمد');

      expect(res.status).toBe(200);
      expect(ids(res.data)).toContain(ahmed.id);
    });

    it('finds a shop by part of its Arabic name (fixture seller 1: قطع غيار الرياض)', async () => {
      const sellerToken = await issueToken(testApp.infra, 'seller', 1);
      const me = await api().get<{ id: string }>('/api/users/me', {
        token: sellerToken,
      });

      const res = await searchUsers('غيار');

      expect(ids(res.data)).toContain(me.data.id);
      const shop = res.data.items.find((item) => item.id === me.data.id);
      expect(shop?.name).toBe('قطع غيار الرياض');
    });

    it('says whether the viewer follows each result', async () => {
      const found = await createPerson(testApp, 'customer', {
        firstName: 'Followable',
      });
      const res0 = await searchUsers('followable');
      expect(
        res0.data.items.find((i) => i.id === found.id)?.viewerFollowing,
      ).toBe(false);

      await api().post(`/api/users/${found.id}/follow`, {
        token: viewer.token,
      });
      const res1 = await searchUsers('followable');
      expect(
        res1.data.items.find((i) => i.id === found.id)?.viewerFollowing,
      ).toBe(true);
    });

    it('leaves out the viewer, blocked accounts and accounts that blocked the viewer', async () => {
      const token = 'ranktoken';
      const me = await createPerson(testApp, 'customer', { firstName: token });
      const blocked = await createPerson(testApp, 'customer', {
        firstName: token,
      });
      const blocker = await createPerson(testApp, 'customer', {
        firstName: token,
      });
      const fine = await createPerson(testApp, 'customer', {
        firstName: token,
      });
      await api().post(`/api/users/${blocked.id}/block`, { token: me.token });
      await api().post(`/api/users/${me.id}/block`, { token: blocker.token });

      const res = await searchUsers(token, me);

      expect(ids(res.data)).toEqual([fine.id]);
    });

    it('ranks an exact handle first, then by followers', async () => {
      const model = testApp.app.get<Model<ReelsAccountDocument>>(
        getModelToken(ReelsAccount.name),
      );
      const make = (
        username: string,
        externalId: number,
        followersCount: number,
      ) => ({
        accountType: 'customer' as const,
        externalId,
        name: username,
        nameNormalized: normalizeForMatch(username),
        username,
        usernameNormalized: normalizeForMatch(username),
        followersCount,
      });
      const [least, most, exact, middle] = await model.insertMany([
        make('xrank_alpha', 910_001, 1),
        make('xrank_beta', 910_002, 50),
        make('xrank', 910_003, 0),
        make('xrank_gamma', 910_004, 10),
      ]);

      const res = await searchUsers('xrank');

      expect(ids(res.data)).toEqual([
        exact._id.toString(), // the exact handle, whatever its followers
        most._id.toString(),
        middle._id.toString(),
        least._id.toString(),
      ]);
    });

    it('pages by cursor with no repeat, and stops at 200 results', async () => {
      const model = testApp.app.get<Model<ReelsAccountDocument>>(
        getModelToken(ReelsAccount.name),
      );
      await model.insertMany(
        Array.from({ length: 230 }, (_, i) => {
          const username = `bulkname_${String(i).padStart(3, '0')}`;
          return {
            accountType: 'customer' as const,
            externalId: 920_000 + i,
            name: username,
            nameNormalized: normalizeForMatch(username),
            username,
            usernameNormalized: normalizeForMatch(username),
            followersCount: i,
          };
        }),
      );

      const collected: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const res = await searchUsers('bulkname', viewer, {
          limit: 25,
          cursor: cursor ?? undefined,
        });
        expect(res.status).toBe(200);
        collected.push(...ids(res.data));
        cursor = res.data.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 20);

      expect(collected).toHaveLength(200);
      expect(new Set(collected).size).toBe(200);
      expect(pages).toBe(8);
    });

    it.each([
      ['plain text', 'not-a-cursor!'],
      [
        'a feed cursor',
        'eyJwIjowLCJ0IjoxLCJpIjoiNjUwMDAwMDAwMDAwMDAwMDAwMDAwMDAxIn0',
      ],
      ['a negative offset', Buffer.from('{"o":-1}').toString('base64url')],
    ])('refuses %s as a cursor', async (_label, cursor) => {
      const res = await searchUsers('anything', viewer, { cursor });
      expect([res.status, res.error]).toEqual([400, 'INVALID_CURSOR']);
    });

    it('refuses a query of only whitespace', async () => {
      const res = await searchUsers('   ');
      expect([res.status, res.error]).toEqual([400, 'VALIDATION_FAILED']);
    });
  });
});
