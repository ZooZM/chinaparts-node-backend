import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCESS_KEY } from '../../src/common/guards/access.decorator';
import {
  ReelComment,
  ReelCommentDocument,
} from '../../src/modules/reels/schemas/reel-comment.schema';
import { ADMIN_KEY, createTestApp, TestApp } from '../utils/app';
import { createPublishedReel } from '../utils/fixtures';
import { createPerson } from '../utils/people';
import { issueToken } from '../utils/tokens';

type Level = 'public' | 'optional' | 'signed-in' | 'seller' | 'admin';
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Actor = 'guest' | 'customer' | 'seller' | 'suspended seller' | 'admin key';

interface Ctx {
  reelId: string;
  commentId: string;
  userId: string;
}

interface Row {
  /** The endpoint number in contracts/rest-api.md. */
  ep: string;
  method: Method;
  /** The route as the controller declares it, for the completeness check. */
  template: string;
  /** The concrete address for a test. */
  path: (c: Ctx) => string;
  access: Level;
  /** A write the standing guard lets through (FR-008). */
  standingExempt?: boolean;
  body?: Record<string, unknown>;
  multipart?: boolean;
}

/** Every row of contracts/rest-api.md, with its access level. */
const ROWS: Row[] = [
  {
    ep: '1',
    method: 'get',
    template: '/api/reels',
    path: () => '/api/reels',
    access: 'optional',
  },
  {
    ep: '2',
    method: 'get',
    template: '/api/reels/following',
    path: () => '/api/reels/following',
    access: 'signed-in',
  },
  {
    ep: '3',
    method: 'get',
    template: '/api/reels/liked',
    path: () => '/api/reels/liked',
    access: 'signed-in',
  },
  {
    ep: '4',
    method: 'get',
    template: '/api/reels/saved',
    path: () => '/api/reels/saved',
    access: 'signed-in',
  },
  {
    ep: '5',
    method: 'get',
    template: '/api/reels/reposted',
    path: (c) => `/api/reels/reposted?userId=${c.userId}`,
    access: 'optional',
  },
  {
    ep: '6',
    method: 'get',
    template: '/api/reels/search',
    path: () => '/api/reels/search?q=x',
    access: 'signed-in',
  },
  {
    ep: '7',
    method: 'get',
    template: '/api/reels/me/following',
    path: () => '/api/reels/me/following',
    access: 'signed-in',
  },
  {
    ep: '8',
    method: 'post',
    template: '/api/reels',
    path: () => '/api/reels',
    access: 'seller',
    multipart: true,
  },
  {
    ep: '9',
    method: 'get',
    template: '/api/reels/:id',
    path: (c) => `/api/reels/${c.reelId}`,
    access: 'optional',
  },
  {
    ep: '10',
    method: 'delete',
    template: '/api/reels/:id',
    path: (c) => `/api/reels/${c.reelId}`,
    access: 'signed-in',
    standingExempt: true,
  },
  {
    ep: '11',
    method: 'put',
    template: '/api/reels/:id/products',
    path: (c) => `/api/reels/${c.reelId}/products`,
    access: 'seller',
    body: { productIds: [] },
  },
  {
    ep: '12',
    method: 'post',
    template: '/api/reels/:id/products/:productId/tap',
    path: (c) => `/api/reels/${c.reelId}/products/101/tap`,
    access: 'optional',
  },
  {
    ep: '13',
    method: 'post',
    template: '/api/reels/:id/like',
    path: (c) => `/api/reels/${c.reelId}/like`,
    access: 'signed-in',
  },
  {
    ep: '14',
    method: 'post',
    template: '/api/reels/:id/save',
    path: (c) => `/api/reels/${c.reelId}/save`,
    access: 'signed-in',
  },
  {
    ep: '15',
    method: 'post',
    template: '/api/reels/:id/share',
    path: (c) => `/api/reels/${c.reelId}/share`,
    access: 'signed-in',
  },
  {
    ep: '16',
    method: 'post',
    template: '/api/reels/:id/view',
    path: (c) => `/api/reels/${c.reelId}/view`,
    access: 'optional',
    standingExempt: true,
  },
  {
    ep: '17',
    method: 'post',
    template: '/api/reels/:id/repost',
    path: (c) => `/api/reels/${c.reelId}/repost`,
    access: 'signed-in',
  },
  {
    ep: '17',
    method: 'delete',
    template: '/api/reels/:id/repost',
    path: (c) => `/api/reels/${c.reelId}/repost`,
    access: 'signed-in',
  },
  {
    ep: '18',
    method: 'get',
    template: '/api/reels/:id/reposters',
    path: (c) => `/api/reels/${c.reelId}/reposters`,
    access: 'optional',
  },
  {
    ep: '19',
    method: 'post',
    template: '/api/reels/:id/report',
    path: (c) => `/api/reels/${c.reelId}/report`,
    access: 'signed-in',
    body: { reason: 'spam' },
  },
  {
    ep: '20',
    method: 'get',
    template: '/api/reels/:id/comments',
    path: (c) => `/api/reels/${c.reelId}/comments`,
    access: 'optional',
  },
  {
    ep: '21',
    method: 'post',
    template: '/api/reels/:id/comments',
    path: (c) => `/api/reels/${c.reelId}/comments`,
    access: 'signed-in',
    body: { text: 'hello' },
  },
  {
    ep: '22',
    method: 'delete',
    template: '/api/reels/:id/comments/:commentId',
    path: (c) => `/api/reels/${c.reelId}/comments/${c.commentId}`,
    access: 'signed-in',
    standingExempt: true,
  },
  {
    ep: '23',
    method: 'post',
    template: '/api/reels/:id/comments/:commentId/report',
    path: (c) => `/api/reels/${c.reelId}/comments/${c.commentId}/report`,
    access: 'signed-in',
    body: { reason: 'spam' },
  },
  {
    ep: '24',
    method: 'get',
    template: '/api/users/me',
    path: () => '/api/users/me',
    access: 'signed-in',
  },
  {
    ep: '25',
    method: 'patch',
    template: '/api/users/me',
    path: () => '/api/users/me',
    access: 'signed-in',
    body: { bio: 'hi' },
  },
  {
    ep: '26',
    method: 'get',
    template: '/api/users/search',
    path: () => '/api/users/search?q=x',
    access: 'signed-in',
  },
  {
    ep: '27',
    method: 'get',
    template: '/api/users/:id/profile',
    path: (c) => `/api/users/${c.userId}/profile`,
    access: 'optional',
  },
  {
    ep: '28',
    method: 'post',
    template: '/api/users/:id/follow',
    path: (c) => `/api/users/${c.userId}/follow`,
    access: 'signed-in',
  },
  {
    ep: '28',
    method: 'post',
    template: '/api/users/:id/block',
    path: (c) => `/api/users/${c.userId}/block`,
    access: 'signed-in',
  },
  {
    ep: '29',
    method: 'get',
    template: '/api/reels/moderation/hidden',
    path: () => '/api/reels/moderation/hidden',
    access: 'admin',
  },
  {
    ep: '30',
    method: 'patch',
    template: '/api/reels/:id/moderation',
    path: (c) => `/api/reels/${c.reelId}/moderation`,
    access: 'admin',
    body: { action: 'restore' },
  },
  {
    ep: '31',
    method: 'get',
    template: '/api/reels/moderation/comments',
    path: () => '/api/reels/moderation/comments',
    access: 'admin',
  },
  {
    ep: '32',
    method: 'patch',
    template: '/api/reels/comments/:commentId/moderation',
    path: (c) => `/api/reels/comments/${c.commentId}/moderation`,
    access: 'admin',
    body: { action: 'dismiss' },
  },
  {
    ep: '33',
    method: 'get',
    template: '/reels/:id',
    path: (c) => `/reels/${c.reelId}`,
    access: 'public',
  },
  {
    ep: '34',
    method: 'get',
    template: '/.well-known/apple-app-site-association',
    path: () => '/.well-known/apple-app-site-association',
    access: 'public',
  },
  {
    ep: '35',
    method: 'get',
    template: '/.well-known/assetlinks.json',
    path: () => '/.well-known/assetlinks.json',
    access: 'public',
  },
  {
    ep: '-',
    method: 'get',
    template: '/health/live',
    path: () => '/health/live',
    access: 'public',
  },
  {
    ep: '-',
    method: 'get',
    template: '/health/ready',
    path: () => '/health/ready',
    access: 'public',
  },
];

const ACTORS: Actor[] = [
  'guest',
  'customer',
  'seller',
  'suspended seller',
  'admin key',
];

/** The only errors that mean "the access layer said no". Anything else got past it. */
const ACCESS_REFUSALS = new Set([
  'AUTH_REQUIRED',
  'AUTH_INVALID_SESSION',
  'ADMIN_KEY_INVALID',
  'REELS_SELLERS_ONLY',
  'ACCOUNT_NOT_IN_GOOD_STANDING',
]);

/** What the access layer must do (contracts/rest-api.md, "Access levels"). */
function expectedOutcome(row: Row, actor: Actor): string {
  if (row.access === 'admin')
    return actor === 'admin key' ? 'allowed' : 'ADMIN_KEY_INVALID';
  if (row.access === 'public') return 'allowed';
  // The operator key grants nothing on a user route: it is not a session.
  const signedOut = actor === 'guest' || actor === 'admin key';
  if (row.access === 'optional') {
    if (signedOut) return 'allowed';
  } else if (signedOut) {
    return 'AUTH_REQUIRED';
  }
  if (row.access === 'seller' && actor === 'customer')
    return 'REELS_SELLERS_ONLY';
  if (actor === 'suspended seller') {
    // Reading is allowed out of good standing; writing is not, apart from the exemptions (FR-008).
    if (row.method !== 'get' && !row.standingExempt)
      return 'ACCOUNT_NOT_IN_GOOD_STANDING';
  }
  return 'allowed';
}

describe('Who may do what (e2e)', () => {
  let testApp: TestApp;
  let ctx: Ctx;
  const tokens = new Map<Actor, string | undefined>();

  beforeAll(async () => {
    testApp = await createTestApp();
    const customer = await createPerson(testApp, 'customer');
    const seller = await createPerson(testApp, 'seller');
    tokens.set('guest', undefined);
    tokens.set('customer', customer.token);
    tokens.set('seller', seller.token);
    // Fixture seller 2 is suspended in China Parts.
    tokens.set(
      'suspended seller',
      await issueToken(testApp.infra, 'seller', 2),
    );
    tokens.set('admin key', undefined);

    // Someone else's reel, with a product and a comment, for every actor to try things on.
    const owner = await createPerson(testApp, 'seller');
    const author = await createPerson(testApp, 'customer');
    const reel = await createPublishedReel(testApp, 1);
    const comment = await testApp.app
      .get<Model<ReelCommentDocument>>(getModelToken(ReelComment.name))
      .create({
        videoId: new Types.ObjectId(reel.id),
        authorId: new Types.ObjectId(author.id),
        text: 'a comment by someone else',
      });
    await testApp.api.put(`/api/reels/${reel.id}/products`, {
      token: await issueToken(testApp.infra, 'seller', 1),
      body: { productIds: [101] },
    });
    ctx = {
      reelId: reel.id,
      commentId: comment._id.toString(),
      userId: owner.id,
    };
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  async function call(row: Row, actor: Actor) {
    return testApp.api[row.method](row.path(ctx), {
      token: tokens.get(actor),
      adminKey: actor === 'admin key' ? ADMIN_KEY : undefined,
      body: row.body,
      multipart: row.multipart ? { fields: {} } : undefined,
    });
  }

  describe.each(ACTORS)('as %s', (actor) => {
    it.each(
      ROWS.map(
        (row) =>
          [
            `EP${row.ep} ${row.method.toUpperCase()} ${row.template}`,
            row,
          ] as const,
      ),
    )('%s', async (_label, row) => {
      // Each request starts clean, so a limit reached by an earlier one never answers this one.
      const res = await call(row, actor);
      const observed =
        res.error && ACCESS_REFUSALS.has(res.error) ? res.error : 'allowed';

      expect(observed).toBe(expectedOutcome(row, actor));
    });
  });

  describe('the standing exemptions (FR-008)', () => {
    it('lets a suspended seller delete their own reel, and still refuses them everything else that writes', async () => {
      const token = tokens.get('suspended seller');
      const own = await createPublishedReel(testApp, 2);

      const like = await testApp.api.post(`/api/reels/${own.id}/like`, {
        token,
      });
      expect([like.status, like.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
      const deleted = await testApp.api.delete(`/api/reels/${own.id}`, {
        token,
      });
      expect([deleted.status, deleted.data]).toEqual([200, { deleted: true }]);
    });

    it('lets a suspended account record a view, which is not a write it could abuse', async () => {
      const res = await testApp.api.post(`/api/reels/${ctx.reelId}/view`, {
        token: tokens.get('suspended seller'),
      });
      expect(res.status).toBe(201);
    });

    it("lets a suspended author delete their own comment, and no one else's", async () => {
      const token = tokens.get('suspended seller');
      const me = await testApp.api.get<{ id: string }>('/api/users/me', {
        token,
      });
      const mine = await testApp.app
        .get<Model<ReelCommentDocument>>(getModelToken(ReelComment.name))
        .create({
          videoId: new Types.ObjectId(ctx.reelId),
          authorId: new Types.ObjectId(me.data.id),
          text: 'written before the suspension',
        });

      const others = await testApp.api.delete(
        `/api/reels/${ctx.reelId}/comments/${ctx.commentId}`,
        { token },
      );
      expect([others.status, others.error]).toEqual([
        403,
        'COMMENT_NOT_DELETABLE',
      ]);
      const own = await testApp.api.delete(
        `/api/reels/${ctx.reelId}/comments/${mine._id.toString()}`,
        { token },
      );
      expect(own.status).toBe(200);
    });
  });

  describe('explicit access levels (constitution V)', () => {
    interface Found {
      method: string;
      path: string;
      level: Level | undefined;
    }

    function discoverRoutes(): Found[] {
      const discovery = testApp.app.get(DiscoveryService);
      const scanner = testApp.app.get(MetadataScanner);
      const found: Found[] = [];
      for (const wrapper of discovery.getControllers()) {
        const instance: unknown = wrapper.instance;
        const metatype: unknown = wrapper.metatype;
        if (!instance || !metatype) continue;
        const prototype = Object.getPrototypeOf(instance) as Record<
          string,
          unknown
        >;
        const controllerPath =
          (Reflect.getMetadata('path', metatype) as string | undefined) ?? '';
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[name] as (...args: never[]) => unknown;
          const method = Reflect.getMetadata('method', handler) as
            number | undefined;
          if (method === undefined) continue;
          const routePath =
            (Reflect.getMetadata('path', handler) as string | undefined) ?? '';
          const level =
            (Reflect.getMetadata(ACCESS_KEY, handler) as Level | undefined) ??
            (Reflect.getMetadata(ACCESS_KEY, metatype) as Level | undefined);
          found.push({
            method: RequestMethod[method].toLowerCase(),
            path: `/${controllerPath}/${routePath}`
              .replace(/\/+/g, '/')
              .replace(/(.)\/$/, '$1'),
            level,
          });
        }
      }
      return found;
    }

    it('gives every registered route an explicit level, so nothing relies on the default', () => {
      const routes = discoverRoutes();

      expect(routes.length).toBeGreaterThan(30);
      expect(routes.filter((route) => route.level === undefined)).toEqual([]);
    });

    it('is covered by the matrix above: no route exists that the matrix does not try', () => {
      const covered = new Set(
        ROWS.map((row) => `${row.method} ${row.template}`),
      );
      const missing = discoverRoutes()
        .map((route) => `${route.method} ${route.path}`)
        .filter((route) => !covered.has(route));

      expect(missing).toEqual([]);
    });

    it('is in the Postman collection the front-end team uses: a request for every route, and none for a route that is gone', () => {
      interface PostmanNode {
        item?: PostmanNode[];
        request?: { method: string; url: { path: string[] } };
      }
      const collection = JSON.parse(
        readFileSync(
          join(
            __dirname,
            '..',
            '..',
            'docs',
            'postman',
            'china-parts-reels.postman_collection.json',
          ),
          'utf8',
        ),
      ) as PostmanNode;

      // `{{reelId}}`, `:id` and a literal reel id are all "some id".
      const generic = (segment: string) =>
        /^(\{\{.+\}\}|:.+|[0-9a-f]{24})$/.test(segment) ? ':p' : segment;
      const inCollection = new Set<string>();
      const walk = (nodes: PostmanNode[]) => {
        for (const node of nodes) {
          if (node.item) walk(node.item);
          if (node.request) {
            inCollection.add(
              `${node.request.method.toLowerCase()} /${node.request.url.path.map(generic).join('/')}`,
            );
          }
        }
      };
      walk(collection.item ?? []);
      const routes = new Set(
        discoverRoutes().map(
          (route) =>
            `${route.method} /${route.path.split('/').filter(Boolean).map(generic).join('/')}`,
        ),
      );

      expect([...routes].filter((route) => !inCollection.has(route))).toEqual(
        [],
      );
      expect([...inCollection].filter((route) => !routes.has(route))).toEqual(
        [],
      );
    });

    it('is the level the contract gives each route', () => {
      const declared = new Map(
        discoverRoutes().map((route) => [
          `${route.method} ${route.path}`,
          route.level,
        ]),
      );
      const wrong = ROWS.filter(
        (row) => declared.get(`${row.method} ${row.template}`) !== row.access,
      ).map((row) => `EP${row.ep} ${row.method} ${row.template}`);

      expect(wrong).toEqual([]);
    });
  });
});
