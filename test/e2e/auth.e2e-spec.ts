import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createTestApp, TestApp } from '../utils/app';
import { createPerson } from '../utils/people';
import { issueToken, tokenId } from '../utils/tokens';

/**
 * FR-003 to FR-007, FR-004a, FR-005: single sign-on with China Parts' own sessions, against a real
 * MySQL with the real column-level grants.
 */
describe('Sign-in with China Parts sessions (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    // A 2-second token cache, so revocation can be observed without a minute of waiting.
    testApp = await createTestApp({ env: { AUTH_CACHE_TTL_SECONDS: '2' } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  beforeEach(async () => {
    await testApp.infra.rootQuery('DELETE FROM personal_access_tokens');
    await testApp.infra.resetRedis();
  });

  describe('valid sessions', () => {
    it('lets a customer in with no other sign-in (FR-003)', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1);
      const res = await testApp.api.get('/api/reels/liked', { token });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('lets a seller in with no other sign-in (FR-003)', async () => {
      const token = await issueToken(testApp.infra, 'seller', 1);
      const res = await testApp.api.get('/api/reels/liked', { token });
      expect(res.status).toBe(200);
    });

    it('gives customer 1 and seller 1 different identities (SC-005)', async () => {
      const customer = await issueToken(testApp.infra, 'customer', 1);
      const seller = await issueToken(testApp.infra, 'seller', 1);

      // Each is provisioned on first use, with its own account and handle.
      await testApp.api.get('/api/reels/liked', { token: customer });
      await testApp.api.get('/api/reels/liked', { token: seller });
      const accounts = await testApp.app
        .get<Connection>(getConnectionToken())
        .db?.collection<{ externalId: number; accountType: string }>(
          'reels_accounts',
        )
        .find({ externalId: 1 })
        .toArray();

      expect(accounts).toHaveLength(2);
      expect(new Set(accounts?.map((a) => a.accountType))).toEqual(
        new Set(['customer', 'seller']),
      );
      expect(new Set(accounts?.map((a) => String(a._id))).size).toBe(2);
    });
  });

  describe('handles (FR-015)', () => {
    it('are unique, even for accounts provisioned one after another with the same name', async () => {
      const people = [];
      for (let i = 0; i < 4; i += 1) {
        people.push(
          await createPerson(testApp, 'customer', {
            firstName: 'Same',
            lastName: 'Name',
          }),
        );
      }
      const handles = people.map((person) => person.username.toLowerCase());
      expect(new Set(handles).size).toBe(4);
    });
  });

  describe('sessions that are refused (FR-004a, FR-007)', () => {
    it.each([
      ['an unknown token', 'Bearer 987654|does-not-exist'],
      ['a token without an id', 'Bearer just-some-text'],
      ['a malformed header', 'Basic dXNlcjpwYXNz'],
    ])('refuses %s with AUTH_INVALID_SESSION', async (_label, header) => {
      const res = await testApp.api.get('/api/reels/liked', { token: header });
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_INVALID_SESSION');
    });

    it('refuses a wrong secret for a real token id', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1);
      const res = await testApp.api.get('/api/reels/liked', {
        token: `Bearer ${tokenId(token)}|wrong-secret`,
      });
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_INVALID_SESSION');
    });

    it('refuses an expired token', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1, {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const res = await testApp.api.get('/api/reels/liked', { token });
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_INVALID_SESSION');
    });

    it('refuses an administrator token: admins cannot act as reels users (FR-007)', async () => {
      const token = await issueToken(testApp.infra, 'admin', 1);
      const res = await testApp.api.get('/api/reels/liked', { token });
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_INVALID_SESSION');
    });

    it('refuses a token whose account China Parts no longer has', async () => {
      const token = await issueToken(testApp.infra, 'customer', 777);
      const res = await testApp.api.get('/api/reels/liked', { token });
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_INVALID_SESSION');
    });

    it('refuses an invalid session even on a route open to signed-out visitors, never treating it as a guest', async () => {
      const res = await testApp.api.get('/api/reels', {
        token: 'Bearer 987654|stale',
      });
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_INVALID_SESSION');
    });
  });

  describe('no session', () => {
    it('is AUTH_REQUIRED on a signed-in route', async () => {
      const res = await testApp.api.get('/api/reels/liked');
      expect(res.status).toBe(401);
      expect(res.error).toBe('AUTH_REQUIRED');
    });

    it('is welcome on a route open to signed-out visitors', async () => {
      const res = await testApp.api.get('/api/reels');
      expect(res.status).toBe(200);
    });
  });

  describe('a session signed out in China Parts (FR-005)', () => {
    it('stops working once the cache expires', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1);
      expect(
        (await testApp.api.get('/api/reels/liked', { token })).status,
      ).toBe(200);

      // China Parts signs the user out: Sanctum deletes the row.
      await testApp.infra.rootQuery(
        'DELETE FROM personal_access_tokens WHERE id = ?',
        [tokenId(token)],
      );

      // Still inside the cache window: allowed. The cap is 5 minutes (FR-005), the setting 2 seconds.
      expect(
        (await testApp.api.get('/api/reels/liked', { token })).status,
      ).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 2_300));
      const after = await testApp.api.get('/api/reels/liked', { token });
      expect(after.status).toBe(401);
      expect(after.error).toBe('AUTH_INVALID_SESSION');
    });
  });

  describe('China Parts temporarily unreachable', () => {
    afterEach(async () => {
      await testApp.infra.startMysql().catch(() => undefined);
    });

    it('answers 503 UPSTREAM_UNAVAILABLE, never a 401, so the app does not sign the user out', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1);
      await testApp.infra.stopMysql();

      const signedIn = await testApp.api.get('/api/reels/liked', { token });
      const onOpenRoute = await testApp.api.get('/api/reels', { token });

      expect(signedIn.status).toBe(503);
      expect(signedIn.error).toBe('UPSTREAM_UNAVAILABLE');
      expect(onOpenRoute.status).toBe(503);
    });

    it('recovers by itself when China Parts is back', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1);
      await testApp.infra.stopMysql();
      expect(
        (await testApp.api.get('/api/reels/liked', { token })).status,
      ).toBe(503);

      await testApp.infra.startMysql();
      expect(
        (await testApp.api.get('/api/reels/liked', { token })).status,
      ).toBe(200);
    });

    it('keeps serving a session that is already cached', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1);
      expect(
        (await testApp.api.get('/api/reels/liked', { token })).status,
      ).toBe(200);

      await testApp.infra.stopMysql();

      expect(
        (await testApp.api.get('/api/reels/liked', { token })).status,
      ).toBe(200);
    });

    it('signed-out visitors are unaffected: reading the feed needs no China Parts lookup', async () => {
      await testApp.infra.stopMysql();
      expect((await testApp.api.get('/api/reels')).status).toBe(200);
    });
  });

  describe('good standing (FR-008)', () => {
    it('refuses a write by a suspended seller, but lets them read', async () => {
      // Seller 2 is suspended in the fixtures.
      const token = await issueToken(testApp.infra, 'seller', 2);

      const read = await testApp.api.get('/api/reels/liked', { token });
      const write = await testApp.api.post(
        '/api/reels/650000000000000000000009/like',
        { token },
      );

      expect(read.status).toBe(200);
      expect(write.status).toBe(403);
      expect(write.error).toBe('ACCOUNT_NOT_IN_GOOD_STANDING');
    });

    it('refuses a write by an inactive customer', async () => {
      // Customer 3 has status 0 in the fixtures.
      const token = await issueToken(testApp.infra, 'customer', 3);
      const res = await testApp.api.post(
        '/api/reels/650000000000000000000009/like',
        { token },
      );
      expect(res.status).toBe(403);
      expect(res.error).toBe('ACCOUNT_NOT_IN_GOOD_STANDING');
    });

    it('lets an approved seller through to the route, which then reports the unknown reel', async () => {
      const token = await issueToken(testApp.infra, 'seller', 1);
      const res = await testApp.api.post(
        '/api/reels/650000000000000000000009/like',
        { token },
      );
      expect(res.status).toBe(404);
      expect(res.error).toBe('REEL_NOT_FOUND');
    });
  });
});
