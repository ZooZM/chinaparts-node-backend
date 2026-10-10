import { Controller, Get } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ADMIN_KEY, createTestApp, TestApp } from '../utils/app';
import { issueToken } from '../utils/tokens';

/**
 * A route nobody annotated. The product has none (every route states its access level), so this
 * stands in for the one a future change forgets: the global guards must treat it as signed-in.
 */
@Controller('e2e-unannotated')
class UnannotatedController {
  @Get()
  reach(): { reached: true } {
    return { reached: true };
  }
}

/** Research R10: the four global guards, in the order they run. */
describe('Global guards (e2e)', () => {
  describe('with small limits', () => {
    let testApp: TestApp;

    beforeAll(async () => {
      testApp = await createTestApp({
        controllers: [UnannotatedController],
        env: {
          IP_RATE_LIMIT_PER_MINUTE: '10',
          USER_RATE_LIMIT_PER_MINUTE: '5',
          GUEST_RATE_LIMIT_PER_MINUTE: '3',
        },
      });
    });

    afterAll(async () => {
      await testApp.close();
    });

    beforeEach(async () => {
      await testApp.infra.rootQuery('DELETE FROM personal_access_tokens');
      await testApp.infra.resetRedis();
    });

    describe('the access default', () => {
      it('a signed-in route without a header is AUTH_REQUIRED (EP3)', async () => {
        const res = await testApp.api.get('/api/reels/liked');
        expect(res.status).toBe(401);
        expect(res.error).toBe('AUTH_REQUIRED');
      });

      it('a route nobody annotated is signed-in too, never open', async () => {
        const guest = await testApp.api.get('/e2e-unannotated');
        expect(guest.status).toBe(401);
        expect(guest.error).toBe('AUTH_REQUIRED');

        const token = await issueToken(testApp.infra, 'customer', 1);
        const member = await testApp.api.get('/e2e-unannotated', { token });
        expect(member.status).toBe(200);
        expect(member.data).toEqual({ reached: true });
      });
    });

    describe('the per-IP limit', () => {
      it('holds against a client that sends a fresh installation id every time', async () => {
        for (let i = 1; i <= 10; i += 1) {
          const res = await testApp.api.get('/api/reels', {
            installationId: randomUUID(),
          });
          expect(res.status).toBe(200);
        }

        const eleventh = await testApp.api.get('/api/reels', {
          installationId: randomUUID(),
        });
        expect(eleventh.status).toBe(429);
        expect(eleventh.error).toBe('RATE_LIMITED');
        expect(Number(eleventh.headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
      });

      it('is checked before any token lookup, so invented tokens run out too', async () => {
        for (let i = 1; i <= 10; i += 1) {
          const res = await testApp.api.get('/api/reels/liked', {
            token: `Bearer ${900000 + i}|invented`,
          });
          expect(res.status).toBe(401);
        }

        const eleventh = await testApp.api.get('/api/reels/liked', {
          token: 'Bearer 900011|invented',
        });
        expect(eleventh.status).toBe(429);
        expect(eleventh.error).toBe('RATE_LIMITED');
      });
    });

    describe('the per-account limit', () => {
      it('stops the sixth request of one account, and only that account', async () => {
        const customer = await issueToken(testApp.infra, 'customer', 1);
        const seller = await issueToken(testApp.infra, 'seller', 1);

        for (let i = 1; i <= 5; i += 1) {
          const res = await testApp.api.get('/api/reels/liked', {
            token: customer,
          });
          expect(res.status).toBe(200);
        }
        const sixth = await testApp.api.get('/api/reels/liked', {
          token: customer,
        });
        expect(sixth.status).toBe(429);
        expect(sixth.error).toBe('RATE_LIMITED');

        // Customer 1 and seller 1 share a China Parts id but are different accounts here.
        const other = await testApp.api.get('/api/reels/liked', {
          token: seller,
        });
        expect(other.status).toBe(200);
      });
    });

    describe('the guest limit (FR-004b)', () => {
      it('counts each installation separately', async () => {
        const first = randomUUID();
        const second = randomUUID();

        for (let i = 1; i <= 3; i += 1) {
          const res = await testApp.api.get('/api/reels', {
            installationId: first,
          });
          expect(res.status).toBe(200);
        }
        const fourth = await testApp.api.get('/api/reels', {
          installationId: first,
        });
        expect(fourth.status).toBe(429);
        expect(fourth.error).toBe('RATE_LIMITED');

        const other = await testApp.api.get('/api/reels', {
          installationId: second,
        });
        expect(other.status).toBe(200);
      });
    });

    describe('the operator key', () => {
      it.each([
        ['no key', undefined],
        ['a wrong key', 'not-the-key'],
      ])(
        'refuses %s with ADMIN_KEY_INVALID (EP29)',
        async (_label, adminKey) => {
          const res = await testApp.api.get('/api/reels/moderation/hidden', {
            adminKey,
          });
          expect(res.status).toBe(401);
          expect(res.error).toBe('ADMIN_KEY_INVALID');
        },
      );

      it('refuses a valid user session: an admin route is not for users (FR-059)', async () => {
        const token = await issueToken(testApp.infra, 'customer', 1);
        const res = await testApp.api.get('/api/reels/moderation/hidden', {
          token,
        });
        expect(res.status).toBe(401);
        expect(res.error).toBe('ADMIN_KEY_INVALID');
      });

      it('protects the moderation action as well as the list (EP30)', async () => {
        const res = await testApp.api.patch(
          '/api/reels/650000000000000000000009/moderation',
          {
            body: { action: 'restore' },
          },
        );
        expect(res.status).toBe(401);
        expect(res.error).toBe('ADMIN_KEY_INVALID');
      });

      it('lets the right key through, and ignores whatever session comes with it', async () => {
        const plain = await testApp.api.get('/api/reels/moderation/hidden', {
          adminKey: ADMIN_KEY,
        });
        expect(plain.status).toBe(200);

        const withStaleSession = await testApp.api.get(
          '/api/reels/moderation/hidden',
          {
            adminKey: ADMIN_KEY,
            token: 'Bearer 987654|stale',
          },
        );
        expect(withStaleSession.status).toBe(200);
      });
    });

    describe('health', () => {
      it('is never rate-limited, and answers in the envelope', async () => {
        for (let i = 1; i <= 25; i += 1) {
          const res = await testApp.api.get('/health/live');
          expect(res.status).toBe(200);
          expect(res.body).toEqual({
            success: true,
            data: { status: 'ok' },
            message: expect.any(String) as string,
          });
        }
      });

      it('stays reachable after the IP limit is used up, so a load balancer is never locked out', async () => {
        for (let i = 1; i <= 10; i += 1) {
          await testApp.api.get('/api/reels', { installationId: randomUUID() });
        }
        expect((await testApp.api.get('/api/reels')).status).toBe(429);

        expect((await testApp.api.get('/health/live')).status).toBe(200);
        const ready = await testApp.api.get<{
          status: string;
          checks: Record<string, string>;
        }>('/health/ready');
        expect(ready.status).toBe(200);
        expect(ready.data.checks).toEqual({
          mongodb: 'up',
          redis: 'up',
          mysql: 'up',
        });
      });
    });
  });

  describe('with no operator key configured (FR-059)', () => {
    let testApp: TestApp;

    beforeAll(async () => {
      testApp = await createTestApp({ env: { ADMIN_API_KEY: '' } });
    });

    afterAll(async () => {
      await testApp.close();
    });

    it.each([
      ['an empty key', ''],
      ['the old default', ADMIN_KEY],
      ['anything at all', 'anything'],
    ])('refuses %s', async (_label, adminKey) => {
      const res = await testApp.api.get('/api/reels/moderation/hidden', {
        adminKey,
      });
      expect(res.status).toBe(401);
      expect(res.error).toBe('ADMIN_KEY_INVALID');
    });

    it('refuses a request with no key header too', async () => {
      const res = await testApp.api.get('/api/reels/moderation/hidden');
      expect(res.status).toBe(401);
      expect(res.error).toBe('ADMIN_KEY_INVALID');
    });
  });
});
