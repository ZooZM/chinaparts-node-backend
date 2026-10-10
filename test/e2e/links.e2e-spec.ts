import { Types } from 'mongoose';
import { createTestApp, TestApp } from '../utils/app';
import { createPublishedReel } from '../utils/fixtures';
import { createPerson } from '../utils/people';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const IOS_STORE = 'https://apps.apple.com/app/id1234567890';
const ANDROID_STORE =
  'https://play.google.com/store/apps/details?id=sa.chinaparts.customer';

/** FR-067 to FR-069 and research R15: reel links open the customer app, with a safe fallback page. */
describe('Reel links (e2e)', () => {
  describe('when the apps are configured', () => {
    let testApp: TestApp;
    const reelId = new Types.ObjectId().toString();

    beforeAll(async () => {
      testApp = await createTestApp({
        env: {
          IOS_TEAM_ID: 'ABCDE12345',
          IOS_BUNDLE_ID: 'sa.chinaparts.customer',
          ANDROID_PACKAGE_NAME: 'sa.chinaparts.customer',
          ANDROID_CERT_FINGERPRINTS: 'AA:BB:CC, DD:EE:FF',
          IOS_STORE_URL: IOS_STORE,
          ANDROID_STORE_URL: ANDROID_STORE,
          LINKS_PUBLIC_BASE_URL: 'https://reels.example.test',
          LINKS_PAGE_TITLE: 'China Parts Reels',
        },
      });
    }, 120_000);

    afterAll(async () => {
      await testApp.close();
    });

    const api = () => testApp.api;

    describe('the app link files', () => {
      it('serves the Apple file as JSON for the customer app and /reels/*, without the envelope', async () => {
        const res = await api().raw('/.well-known/apple-app-site-association');

        expect(res.status).toBe(200);
        expect(res.contentType).toContain('application/json');
        const body = JSON.parse(res.text) as {
          applinks: {
            details: Array<{
              appIDs: string[];
              components: unknown[];
              paths: string[];
            }>;
          };
          success?: unknown;
        };
        expect(body.success).toBeUndefined();
        expect(body.applinks.details[0].appIDs).toEqual([
          'ABCDE12345.sa.chinaparts.customer',
        ]);
        expect(body.applinks.details[0].components).toEqual([
          { '/': '/reels/*' },
        ]);
        expect(body.applinks.details[0].paths).toEqual(['/reels/*']);
      });

      it('serves the Android file with the package and the fingerprints', async () => {
        const res = await api().raw('/.well-known/assetlinks.json');

        expect(res.status).toBe(200);
        expect(res.contentType).toContain('application/json');
        expect(JSON.parse(res.text)).toEqual([
          {
            relation: ['delegate_permission/common.handle_all_urls'],
            target: {
              namespace: 'android_app',
              package_name: 'sa.chinaparts.customer',
              sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'],
            },
          },
        ]);
      });

      it('does not redirect, which both platforms require', async () => {
        for (const path of [
          '/.well-known/apple-app-site-association',
          '/.well-known/assetlinks.json',
        ]) {
          const res = await api().raw(path);
          expect([path, res.status]).toEqual([path, 200]);
          expect(res.headers.location).toBeUndefined();
        }
      });
    });

    describe('the store page (FR-069)', () => {
      it('sends an iPhone to the App Store', async () => {
        const res = await api().raw(`/reels/${reelId}`, { userAgent: IPHONE });

        expect(res.status).toBe(200);
        expect(res.contentType).toContain('text/html');
        expect(res.text).toContain(IOS_STORE);
        expect(res.text).toContain('http-equiv="refresh"');
        expect(res.text).not.toContain('play.google.com');
      });

      it('sends an Android phone to Google Play', async () => {
        const res = await api().raw(`/reels/${reelId}`, { userAgent: ANDROID });

        expect(res.status).toBe(200);
        expect(res.text).toContain(ANDROID_STORE);
        expect(res.text).not.toContain('apps.apple.com');
      });

      it('shows both links to a desktop browser, without redirecting it', async () => {
        const res = await api().raw(`/reels/${reelId}`, { userAgent: DESKTOP });

        expect(res.status).toBe(200);
        expect(res.text).toContain(IOS_STORE);
        expect(res.text).toContain(ANDROID_STORE);
        expect(res.text).not.toContain('http-equiv="refresh"');
      });

      it('needs no session and no header', async () => {
        const res = await api().raw(`/reels/${reelId}`);
        expect(res.status).toBe(200);
      });

      it('names the reel, the page and the preview, from configuration', async () => {
        const res = await api().raw(`/reels/${reelId}`, { userAgent: DESKTOP });

        expect(res.text).toContain(
          `<link rel="canonical" href="https://reels.example.test/reels/${reelId}" />`,
        );
        expect(res.text).toContain(
          `<meta property="og:url" content="https://reels.example.test/reels/${reelId}" />`,
        );
        expect(res.text).toContain(
          '<meta property="og:title" content="China Parts Reels" />',
        );
      });

      it('does not look the reel up: a page for a reel that does not exist reveals nothing', async () => {
        const real = await createPublishedReel(
          testApp,
          (await createPerson(testApp, 'seller')).externalId,
        );
        const known = await api().raw(`/reels/${real.id}`, {
          userAgent: DESKTOP,
        });
        const unknown = await api().raw(`/reels/${reelId}`, {
          userAgent: DESKTOP,
        });

        expect(known.status).toBe(200);
        expect(unknown.status).toBe(200);
        // The two pages differ only by the id.
        expect(known.text.split(real.id).join('ID')).toBe(
          unknown.text.split(reelId).join('ID'),
        );
      });
    });

    describe('what is not a reel link', () => {
      it.each([
        ['a script', '%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
        [
          'an attribute break',
          '%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
        ],
        ['plain text', 'some-id'],
        ['an id that is too short', '65000000000000000000000'],
        ['an id that is too long', '6500000000000000000000011'],
        ['twelve characters', 'abcdefghijkl'],
      ])(
        'answers 404 for %s, and the body never contains the input as markup',
        async (_label, id) => {
          const res = await api().raw(`/reels/${id}`, { userAgent: DESKTOP });

          expect(res.status).toBe(404);
          expect(res.text).not.toContain('<script');
          expect(res.text).not.toContain('<img');
        },
      );
    });

    describe('a deleted reel', () => {
      it('is REEL_NOT_FOUND on the API, while its link still opens the page', async () => {
        const owner = await createPerson(testApp, 'seller');
        const reel = await createPublishedReel(testApp, owner.externalId);
        await api().delete(`/api/reels/${reel.id}`, { token: owner.token });

        const read = await api().get(`/api/reels/${reel.id}`);
        expect([read.status, read.error]).toEqual([404, 'REEL_NOT_FOUND']);
        const link = await api().raw(`/reels/${reel.id}`, {
          userAgent: IPHONE,
        });
        expect(link.status).toBe(200);
      });
    });
  });

  describe('when the apps are not configured', () => {
    let testApp: TestApp;

    beforeAll(async () => {
      testApp = await createTestApp({ env: { IP_RATE_LIMIT_PER_MINUTE: '5' } });
    }, 120_000);

    afterAll(async () => {
      await testApp.close();
    });

    beforeEach(async () => {
      await testApp.infra.resetRedis();
    });

    it('answers 404 for both app link files, rather than serving an empty one', async () => {
      for (const path of [
        '/.well-known/apple-app-site-association',
        '/.well-known/assetlinks.json',
      ]) {
        const res = await testApp.api.raw(path);
        expect([path, res.status]).toEqual([path, 404]);
      }
    });

    it('still serves the store page, with the placeholder store links', async () => {
      const res = await testApp.api.raw(
        `/reels/${new Types.ObjectId().toString()}`,
        {
          userAgent: DESKTOP,
        },
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain('apps.apple.com');
    });

    it('is still under the per-IP limit, like every other public route', async () => {
      const id = new Types.ObjectId().toString();
      for (let i = 1; i <= 5; i += 1) {
        const res = await testApp.api.raw(`/reels/${id}`);
        expect([i, res.status]).toEqual([i, 200]);
      }

      const sixth = await testApp.api.raw(`/reels/${id}`);

      expect(sixth.status).toBe(429);
    });
  });
});
