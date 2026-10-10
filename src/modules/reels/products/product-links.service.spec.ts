import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { LimitsService } from '../../../common/config/limits';
import { ErrorCode } from '../../../common/errors/error-codes';
import { user } from '../../../common/guards/testing';
import { FakeRedis } from '../../../common/redis/fake-redis.testing';
import type {
  ChinaPartsProductsRepository,
  ProductCardRow,
} from '../../china-parts/products.repository';
import type { ReelsRepository } from '../reels.repository';
import { ProductLinksService } from './product-links.service';

const reelId = new Types.ObjectId().toString();
const ownerId = new Types.ObjectId().toString();

function row(over: Partial<ProductCardRow> = {}): ProductCardRow {
  return {
    productId: 101,
    sellerExternalId: 1,
    name: 'Toyota Camry Oil Filter',
    slug: 'toyota-camry-oil-filter-101',
    active: true,
    deleted: false,
    stockQuantity: 5,
    discountPercentage: '10.00',
    sellingPrice: '45.00',
    imageUrl: null,
    ...over,
  };
}

function setup(ttl = 60) {
  const findAttachable = jest.fn(
    (_seller: number, ids: number[]): Promise<number[]> => Promise.resolve(ids),
  );
  const getCardRows = jest.fn((ids: number[]): Promise<ProductCardRow[]> =>
    Promise.resolve(ids.map((productId) => row({ productId }))),
  );
  const getSnapshot = jest
    .fn()
    .mockResolvedValue({ id: reelId, creatorId: ownerId });
  const setProductLinks = jest.fn().mockResolvedValue(undefined);
  const redis = new FakeRedis();
  const service = new ProductLinksService(
    { findAttachable, getCardRows } as unknown as ChinaPartsProductsRepository,
    { getSnapshot, setProductLinks } as unknown as ReelsRepository,
    redis.asRedis(),
    { maxProducts: 5 } as unknown as LimitsService,
    { getOrThrow: () => ttl } as unknown as ConfigService,
  );
  return {
    service,
    findAttachable,
    getCardRows,
    getSnapshot,
    setProductLinks,
    redis,
  };
}

async function responseOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { getResponse(): unknown }).getResponse();
  }
  return undefined;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const response = (error as { getResponse?: () => unknown }).getResponse?.();
    return (response as { error: string }).error;
  }
  return 'no error';
}

describe('ProductLinksService (research R11)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('validateAttachable (FR-035)', () => {
    it("accepts the seller's own products and answers the ids once each", async () => {
      const { service, findAttachable } = setup();

      await expect(
        service.validateAttachable(1, [101, 102, 101]),
      ).resolves.toEqual([101, 102]);
      expect(findAttachable).toHaveBeenCalledWith(1, [101, 102]);
    });

    it('accepts no products, and asks China Parts nothing', async () => {
      const { service, findAttachable } = setup();
      await expect(service.validateAttachable(1, [])).resolves.toEqual([]);
      expect(findAttachable).not.toHaveBeenCalled();
    });

    it('refuses more than the limit, before asking China Parts', async () => {
      const { service, findAttachable } = setup();

      const code = await codeOf(
        service.validateAttachable(1, [1, 2, 3, 4, 5, 6]),
      );

      expect(code).toBe(ErrorCode.TOO_MANY_PRODUCTS);
      expect(findAttachable).not.toHaveBeenCalled();
    });

    it('counts a product listed twice once', async () => {
      const { service } = setup();
      await expect(
        service.validateAttachable(1, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]),
      ).resolves.toEqual([1, 2, 3, 4, 5]);
    });

    it('names the products that do not qualify', async () => {
      const { service, findAttachable } = setup();
      findAttachable.mockResolvedValue([101]);

      const response = await responseOf(
        service.validateAttachable(1, [101, 103, 104, 201]),
      );

      expect(response).toMatchObject({
        error: ErrorCode.PRODUCT_NOT_ATTACHABLE,
        details: { productIds: [103, 104, 201] },
      });
    });

    it('lets an outage through as it is: nothing is granted without checking (503)', async () => {
      const { service, findAttachable } = setup();
      findAttachable.mockRejectedValue(new Error('UPSTREAM_UNAVAILABLE'));

      await expect(service.validateAttachable(1, [101])).rejects.toThrow(
        'UPSTREAM_UNAVAILABLE',
      );
    });
  });

  describe('setLinks', () => {
    it("replaces the links of the creator's own reel, with the checked ids", async () => {
      const { service, setProductLinks, findAttachable } = setup();

      await service.setLinks(
        reelId,
        user({ userId: ownerId, externalId: 1 }),
        [102, 101],
      );

      expect(findAttachable).toHaveBeenCalledWith(1, [102, 101]);
      expect(setProductLinks).toHaveBeenCalledWith(reelId, [102, 101]);
    });

    it('clears the links with an empty list', async () => {
      const { service, setProductLinks } = setup();
      await service.setLinks(reelId, user({ userId: ownerId }), []);
      expect(setProductLinks).toHaveBeenCalledWith(reelId, []);
    });

    it('is NOT_REEL_OWNER for someone else, and checks nothing about the products', async () => {
      const { service, setProductLinks, findAttachable } = setup();

      const code = await codeOf(
        service.setLinks(reelId, user({ userId: 'someone-else' }), [101]),
      );

      expect(code).toBe(ErrorCode.NOT_REEL_OWNER);
      expect(findAttachable).not.toHaveBeenCalled();
      expect(setProductLinks).not.toHaveBeenCalled();
    });

    it('is REEL_NOT_FOUND for a reel that does not exist, or an id that is not one', async () => {
      const { service, getSnapshot } = setup();
      getSnapshot.mockResolvedValue(null);

      await expect(
        service.setLinks(reelId, user({ userId: ownerId }), [101]),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.setLinks('nope', user({ userId: ownerId }), [101]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(ForbiddenException).toBeDefined();
    });

    it('stores nothing when a product does not qualify', async () => {
      const { service, findAttachable, setProductLinks } = setup();
      findAttachable.mockResolvedValue([]);

      const code = await codeOf(
        service.setLinks(reelId, user({ userId: ownerId }), [201]),
      );

      expect(code).toBe(ErrorCode.PRODUCT_NOT_ATTACHABLE);
      expect(setProductLinks).not.toHaveBeenCalled();
    });
  });

  describe('getCards', () => {
    const want = (productId: number, sellerExternalId = 1) => ({
      productId,
      sellerExternalId,
    });

    it('reads the products it has not got in one query, and caches each in the base currency', async () => {
      const { service, getCardRows, redis } = setup();

      const cards = await service.getCards([want(101), want(102)]);

      expect(getCardRows).toHaveBeenCalledTimes(1);
      expect(getCardRows).toHaveBeenCalledWith([101, 102]);
      expect([...cards.keys()]).toEqual([101, 102]);
      expect(cards.get(101)).toMatchObject({
        productId: 101,
        price: '45.00',
        discountPercentage: '10.00',
        available: true,
      });
      expect(redis.keys().sort()).toEqual([
        'product:card:101',
        'product:card:102',
      ]);
    });

    it('serves the next request from the cache', async () => {
      const { service, getCardRows } = setup();
      await service.getCards([want(101)]);

      await service.getCards([want(101)]);

      expect(getCardRows).toHaveBeenCalledTimes(1);
    });

    it('asks only for what is missing', async () => {
      const { service, getCardRows } = setup();
      await service.getCards([want(101)]);

      await service.getCards([want(101), want(102)]);

      expect(getCardRows).toHaveBeenLastCalledWith([102]);
    });

    it('reads again once the cache has expired, so a change shows within the TTL', async () => {
      jest.useFakeTimers();
      try {
        const { service, getCardRows } = setup(2);
        await service.getCards([want(101)]);
        getCardRows.mockResolvedValue([row({ sellingPrice: '50.00' })]);

        jest.advanceTimersByTime(2_001);
        const cards = await service.getCards([want(101)]);

        expect(cards.get(101)?.price).toBe('50.00');
      } finally {
        jest.useRealTimers();
      }
    });

    it.each([
      ['inactive', { active: false }],
      ['deleted', { deleted: true }],
      ['without a price', { sellingPrice: null }],
    ])('leaves out a product that is %s (FR-037)', async (_label, over) => {
      const { service, getCardRows } = setup();
      getCardRows.mockResolvedValue([row(over)]);

      const cards = await service.getCards([want(101)]);

      expect(cards.size).toBe(0);
    });

    it('remembers that a product is unavailable, so it does not ask on every page view', async () => {
      const { service, getCardRows } = setup();
      getCardRows.mockResolvedValue([row({ active: false })]);
      await service.getCards([want(101)]);

      await service.getCards([want(101)]);

      expect(getCardRows).toHaveBeenCalledTimes(1);
    });

    it('also remembers a product China Parts does not return at all', async () => {
      const { service, getCardRows } = setup();
      getCardRows.mockResolvedValue([]);

      await service.getCards([want(999)]);
      const again = await service.getCards([want(999)]);

      expect(getCardRows).toHaveBeenCalledTimes(1);
      expect(again.size).toBe(0);
    });

    it("leaves out a product that belongs to another seller than the reel's", async () => {
      const { service } = setup();

      const cards = await service.getCards([want(101, 2)]);

      expect(cards.size).toBe(0);
    });

    it('keeps the stock, as available true or false', async () => {
      const { service, getCardRows } = setup();
      getCardRows.mockResolvedValue([
        row({ productId: 102, stockQuantity: 0 }),
      ]);

      const cards = await service.getCards([want(102)]);

      expect(cards.get(102)?.available).toBe(false);
    });

    it('shows only the cached cards when China Parts cannot be reached, and says so', async () => {
      const { service, getCardRows } = setup();
      await service.getCards([want(101)]);
      getCardRows.mockRejectedValue(new Error('UPSTREAM_UNAVAILABLE'));

      const cards = await service.getCards([want(101), want(102)]);

      expect([...cards.keys()]).toEqual([101]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
    });

    it('does not cache anything it could not read', async () => {
      const { service, getCardRows, redis } = setup();
      getCardRows.mockRejectedValue(new Error('down'));

      await service.getCards([want(102)]);

      expect(redis.keys()).toEqual([]);
    });

    it('reads again when a cached entry is damaged', async () => {
      const { service, getCardRows, redis } = setup();
      await redis.set('product:card:101', '{oops');

      const cards = await service.getCards([want(101)]);

      expect(cards.has(101)).toBe(true);
      expect(getCardRows).toHaveBeenCalledTimes(1);
    });

    it('asks for nothing when there is nothing to ask', async () => {
      const { service, getCardRows } = setup();
      expect((await service.getCards([])).size).toBe(0);
      expect(getCardRows).not.toHaveBeenCalled();
    });
  });
});
