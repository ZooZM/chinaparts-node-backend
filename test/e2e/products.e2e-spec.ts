import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { ProductLinksService } from '../../src/modules/reels/products/product-links.service';
import type {
  ProductCardDto,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import {
  createPublishedReel,
  eventually,
  reelModel,
  SAMPLE_10S,
} from '../utils/fixtures';
import { createPerson } from '../utils/people';
import { issueToken } from '../utils/tokens';

/**
 * FR-035 to FR-038 and research R11. The fixtures: seller 1 (approved) owns products 101 (active,
 * 5 in stock, 10% off, 45.00), 102 (active, none in stock), 103 (inactive) and 104 (deleted);
 * seller 2 (suspended) owns 201. Customer 2 prefers USD, and the rate table has SAR 1 and USD
 * 0.266667 per SAR.
 */
describe('Product links and cards (e2e)', () => {
  let testApp: TestApp;
  let sellerToken: string;
  let customer1: string;
  let customer2: string;
  let reelId: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    sellerToken = await issueToken(testApp.infra, 'seller', 1);
    customer1 = await issueToken(testApp.infra, 'customer', 1);
    customer2 = await issueToken(testApp.infra, 'customer', 2);
    reelId = (await createPublishedReel(testApp, 1)).id;
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const setProducts = (token: string, reel: string, productIds: unknown) =>
    api().put<ReelDto>(`/api/reels/${reel}/products`, {
      token,
      body: { productIds },
    });
  const cardsOf = async (token: string | undefined, reel = reelId) =>
    (await api().get<ReelDto>(`/api/reels/${reel}`, { token })).data.products;
  const flushCardCache = () => testApp.infra.resetRedis();

  describe('attaching (FR-035)', () => {
    it("links two of the seller's own active products, in the order given", async () => {
      const res = await setProducts(sellerToken, reelId, [102, 101]);
      expect(res.status).toBe(200);

      const cards = await cardsOf(undefined);
      expect(cards.map((card) => card.productId)).toEqual([102, 101]);
    });

    it('replaces the links, and an empty list removes them all', async () => {
      await setProducts(sellerToken, reelId, [101]);
      expect((await cardsOf(undefined)).map((c) => c.productId)).toEqual([101]);

      await setProducts(sellerToken, reelId, []);
      expect(await cardsOf(undefined)).toEqual([]);
    });

    it("refuses products that are inactive, deleted or another seller's, and names them", async () => {
      const res = await setProducts(sellerToken, reelId, [101, 103, 104, 201]);

      expect([res.status, res.error]).toEqual([400, 'PRODUCT_NOT_ATTACHABLE']);
      expect(res.body.details).toEqual({ productIds: [103, 104, 201] });
      // Nothing was changed.
      expect(await cardsOf(undefined)).toEqual([]);
    });

    it('refuses more than five', async () => {
      const res = await setProducts(
        sellerToken,
        reelId,
        [101, 102, 103, 104, 201, 202],
      );
      expect([res.status, res.error]).toEqual([400, 'TOO_MANY_PRODUCTS']);
    });

    it('refuses a customer: only sellers publish', async () => {
      const res = await setProducts(customer1, reelId, [101]);
      expect([res.status, res.error]).toEqual([403, 'REELS_SELLERS_ONLY']);
    });

    it('refuses a seller who is not in good standing (pending seller 3)', async () => {
      const token = await issueToken(testApp.infra, 'seller', 3);
      const res = await setProducts(token, reelId, [101]);
      expect([res.status, res.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
    });

    it("refuses another seller's reel", async () => {
      const other = await createPerson(testApp, 'seller');
      const res = await setProducts(other.token, reelId, [101]);
      expect([res.status, res.error]).toEqual([403, 'NOT_REEL_OWNER']);
    });

    it('answers 404 for a reel that does not exist', async () => {
      const res = await setProducts(
        sellerToken,
        new Types.ObjectId().toString(),
        [101],
      );
      expect([res.status, res.error]).toEqual([404, 'REEL_NOT_FOUND']);
    });

    it('refuses a body that is not a list of ids', async () => {
      for (const body of ['101', [1.5], ['x'], [0], [-3]]) {
        const res = await setProducts(sellerToken, reelId, body);
        expect([body, res.status, res.error]).toEqual([
          body,
          400,
          'VALIDATION_FAILED',
        ]);
      }
    });
  });

  describe('on upload (FR-035)', () => {
    const upload = (productIds: string) =>
      api().post<ReelDto>('/api/reels', {
        token: sellerToken,
        multipart: {
          fields: { productIds },
          files: [
            { field: 'video', path: SAMPLE_10S, contentType: 'video/mp4' },
          ],
        },
      });

    it.each([
      ['a JSON list', '[101,102]'],
      ['a comma-separated list', '101,102'],
    ])('accepts the products as %s', async (_label, productIds) => {
      const res = await upload(productIds);
      expect(res.status).toBe(201);

      const stored = await reelModel(testApp).findById(res.data.id).exec();
      expect(stored?.productLinks.map((l) => l.productId)).toEqual([101, 102]);
    });

    it('refuses a product that may not be attached, and leaves no reel behind', async () => {
      const before = await reelModel(testApp).countDocuments().exec();

      const res = await upload('[101,201]');

      expect([res.status, res.error]).toEqual([400, 'PRODUCT_NOT_ATTACHABLE']);
      expect(await reelModel(testApp).countDocuments().exec()).toBe(before);
    });
  });

  describe('cards in the base currency (FR-036)', () => {
    beforeAll(async () => {
      await setProducts(sellerToken, reelId, [101, 102]);
    });

    it.each([
      ['a signed-out visitor', undefined],
      ['customer 1, with no preferred currency', 'customer1'],
    ])('are in SAR for %s', async (_label, who) => {
      const cards = await cardsOf(who ? customer1 : undefined);

      const filter = cards.find((card) => card.productId === 101);
      expect(filter).toMatchObject({
        productId: 101,
        slug: 'toyota-camry-oil-filter-101',
        name: 'Toyota Camry Oil Filter',
        imageUrl: 'http://china-parts.test/storage/1/filter.jpg',
        price: '45.00',
        discountPercentage: '10.00',
        finalPrice: '40.50',
        currency: 'SAR',
        available: true,
      });
      const brakes = cards.find((card) => card.productId === 102);
      expect(brakes).toMatchObject({ available: false, price: '45.00' });
    });

    it('carry no private field of the product (FR-036)', async () => {
      const [card] = await cardsOf(undefined);
      expect(Object.keys(card).sort()).toEqual(
        [
          'available',
          'currency',
          'discountPercentage',
          'finalPrice',
          'imageUrl',
          'name',
          'price',
          'productId',
          'slug',
        ].sort(),
      );
    });
  });

  describe("cards in the viewer's currency (FR-036)", () => {
    it('convert the price, then apply the discount, for customer 2 who prefers USD', async () => {
      const cards = await cardsOf(customer2);

      const filter = cards.find(
        (card) => card.productId === 101,
      ) as ProductCardDto;
      // 45.00 SAR x 0.266667 = 12.000015, and 90% of that is 10.8000135.
      expect(filter).toMatchObject({
        price: '12.00',
        discountPercentage: '10.00',
        finalPrice: '10.80',
        currency: 'USD',
      });
    });

    it('show the same card to different viewers in their own currency, from one cached card', async () => {
      const [usd, sar] = await Promise.all([
        cardsOf(customer2),
        cardsOf(customer1),
      ]);
      expect(usd.map((c) => c.currency)).toEqual(['USD', 'USD']);
      expect(sar.map((c) => c.currency)).toEqual(['SAR', 'SAR']);
    });
  });

  describe('when China Parts cannot be reached (R11)', () => {
    afterEach(async () => {
      await testApp.infra.startMysql().catch(() => undefined);
    });

    it('still serves the reel with the cards that are cached, and refuses to attach anything', async () => {
      const reel = (await createPublishedReel(testApp, 1)).id;
      await reelModel(testApp).updateOne(
        { _id: reel },
        {
          $set: {
            productLinks: [
              { productId: 101, position: 0, tapsCount: 0 },
              { productId: 102, position: 1, tapsCount: 0 },
            ],
          },
        },
      );
      await flushCardCache();
      // Only 101's card gets cached.
      await testApp.app
        .get(ProductLinksService)
        .getCards([{ productId: 101, sellerExternalId: 1 }]);

      await testApp.infra.stopMysql();

      const read = await api().get<ReelDto>(`/api/reels/${reel}`);
      expect(read.status).toBe(200);
      expect(read.data.products.map((card) => card.productId)).toEqual([101]);
      const attach = await setProducts(sellerToken, reel, [101]);
      expect([attach.status, attach.error]).toEqual([
        503,
        'UPSTREAM_UNAVAILABLE',
      ]);
    });
  });

  describe('taps (FR-038)', () => {
    let tapReel: string;
    const tap = (
      productId: number,
      options: { token?: string; installationId?: string } = {},
    ) =>
      api().post<null>(
        `/api/reels/${tapReel}/products/${productId}/tap`,
        options,
      );
    const tapsOf = async (productId: number) =>
      (await reelModel(testApp).findById(tapReel).exec())?.productLinks.find(
        (link) => link.productId === productId,
      )?.tapsCount;
    const tapRows = () =>
      testApp.app
        .get<Connection>(getConnectionToken())
        .db?.collection('reel_product_taps')
        .countDocuments({ videoId: new Types.ObjectId(tapReel) });

    beforeAll(async () => {
      tapReel = (await createPublishedReel(testApp, 1)).id;
      await setProducts(sellerToken, tapReel, [101, 102]);
    });

    it('count a signed-out tap and a signed-in tap, and keep a row for each', async () => {
      const guest = await tap(101, {
        installationId: '4f1b6a3e-8a1b-4c3e-9a55-2f0f6d6f1c01',
      });
      expect([guest.status, guest.data]).toEqual([201, null]);
      const member = await tap(101, { token: customer1 });
      expect(member.status).toBe(201);

      expect(await tapsOf(101)).toBe(2);
      expect(await tapsOf(102)).toBe(0);
      expect(await tapRows()).toBe(2);
    });

    it('count a tap with no installation id too', async () => {
      const before = await tapsOf(102);
      const res = await tap(102);
      expect(res.status).toBe(201);
      expect(await tapsOf(102)).toBe((before ?? 0) + 1);
    });

    it('answers 404 for a product the reel does not link', async () => {
      const res = await tap(103, { token: customer1 });
      expect([res.status, res.error]).toEqual([404, 'PRODUCT_LINK_NOT_FOUND']);
    });

    it('answers 404 for a reel that does not exist', async () => {
      const res = await api().post(
        `/api/reels/${new Types.ObjectId().toString()}/products/101/tap`,
      );
      expect([res.status, res.error]).toEqual([404, 'REEL_NOT_FOUND']);
    });

    it('is refused for a signed-in account out of good standing (suspended seller 2)', async () => {
      const token = await issueToken(testApp.infra, 'seller', 2);
      const res = await tap(101, { token });
      expect([res.status, res.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
    });

    it('goes when the reel goes: the cascade removes the tap rows', async () => {
      expect(await tapRows()).toBeGreaterThan(0);
      const deleted = await api().delete(`/api/reels/${tapReel}`, {
        token: sellerToken,
      });
      expect(deleted.status).toBe(200);
      expect(await tapRows()).toBe(0);
    });
  });
});

/** Card cache and rate cache of one second, so a change in China Parts shows within the test. */
describe('Product cards stay current (e2e)', () => {
  let testApp: TestApp;
  let sellerToken: string;
  let customer2: string;
  let reelId: string;

  beforeAll(async () => {
    testApp = await createTestApp({
      env: { PRODUCT_CARD_CACHE_SECONDS: '1', FX_CACHE_SECONDS: '1' },
    });
    sellerToken = await issueToken(testApp.infra, 'seller', 1);
    customer2 = await issueToken(testApp.infra, 'customer', 2);
    reelId = (await createPublishedReel(testApp, 1)).id;
    await testApp.api.put(`/api/reels/${reelId}/products`, {
      token: sellerToken,
      body: { productIds: [101, 102] },
    });
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const cards = async (token?: string) =>
    (await testApp.api.get<ReelDto>(`/api/reels/${reelId}`, { token })).data
      .products;
  const sql = (query: string, params: unknown[] = []) =>
    testApp.infra.rootQuery(query, params);

  it('shows a changed price once the cached card expires', async () => {
    expect((await cards()).find((c) => c.productId === 101)?.price).toBe(
      '45.00',
    );

    await sql(
      'UPDATE product_variants SET selling_price = 50 WHERE product_id = 101',
    );

    await eventually(async () => {
      const card = (await cards()).find((c) => c.productId === 101);
      expect([card?.price, card?.finalPrice]).toEqual(['50.00', '45.00']);
    });
    await sql(
      'UPDATE product_variants SET selling_price = 45 WHERE product_id = 101',
    );
  });

  it('drops the card of a product that is deactivated, and the reel stays published', async () => {
    await sql('UPDATE products SET status = 0 WHERE id = 101');

    await eventually(async () => {
      expect((await cards()).map((c) => c.productId)).toEqual([102]);
    });
    const reel = await testApp.api.get<ReelDto>(`/api/reels/${reelId}`);
    expect(reel.status).toBe(200);
    expect(reel.data.status).toBe('published');

    // The link is still stored, so the product comes back if it is reactivated (FR-037).
    await sql('UPDATE products SET status = 1 WHERE id = 101');
    await eventually(async () => {
      expect((await cards()).map((c) => c.productId)).toEqual([101, 102]);
    });
  });

  it('drops the card of a product that is soft-deleted', async () => {
    await sql('UPDATE products SET deleted_at = NOW() WHERE id = 102');
    await eventually(async () => {
      expect((await cards()).map((c) => c.productId)).toEqual([101]);
    });
    await sql('UPDATE products SET deleted_at = NULL WHERE id = 102');
  });

  it("falls back to SAR when the viewer's currency has no rate, and says so in the card", async () => {
    // The previous test restored a product; its card is back once that cache entry expires.
    await eventually(async () => {
      expect((await cards(customer2)).map((c) => c.currency)).toEqual([
        'USD',
        'USD',
      ]);
    });

    await sql("DELETE FROM currencies WHERE code = 'USD'");

    await eventually(async () => {
      const [card] = await cards(customer2);
      expect([card.currency, card.price]).toEqual(['SAR', '45.00']);
    });
    await sql(
      "INSERT INTO currencies (code, exchange_rate) VALUES ('USD', 0.266667)",
    );
  });

  it('falls back to SAR when the rate table cannot be read', async () => {
    await sql('RENAME TABLE currencies TO currencies_gone');
    try {
      await eventually(async () => {
        const [card] = await cards(customer2);
        expect(card.currency).toBe('SAR');
      });
    } finally {
      await sql('RENAME TABLE currencies_gone TO currencies');
    }
  });
});
