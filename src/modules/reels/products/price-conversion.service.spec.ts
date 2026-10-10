import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FakeRedis } from '../../../common/redis/fake-redis.testing';
import { ChinaPartsConfig } from '../../china-parts/china-parts.config';
import type { ChinaPartsExchangeRatesRepository } from '../../china-parts/exchange-rates.repository';
import { PriceConversionService } from './price-conversion.service';
import type { BaseCard } from './product-links.service';

function card(over: Partial<BaseCard> = {}): BaseCard {
  return {
    productId: 101,
    sellerExternalId: 1,
    name: 'Toyota Camry Oil Filter',
    slug: 'toyota-camry-oil-filter-101',
    imageUrl: null,
    price: '45.00',
    discountPercentage: '10.00',
    available: true,
    ...over,
  };
}

function setup(
  options: {
    rates?: Record<string, string>;
    direction?: 'per_base' | 'to_base';
    base?: string;
    ttl?: number;
  } = {},
) {
  const rates = new Map(
    Object.entries(options.rates ?? { SAR: '1.000000', USD: '0.266667' }),
  );
  const getRates = jest.fn(() => Promise.resolve(rates));
  const redis = new FakeRedis();
  const config = new ChinaPartsConfig({
    get: (key: string): unknown =>
      ({
        CHINAPARTS_BASE_CURRENCY: options.base,
        CHINAPARTS_FX_RATE_DIRECTION: options.direction,
      })[key],
  } as unknown as ConfigService);
  const service = new PriceConversionService(
    { getRates } as unknown as ChinaPartsExchangeRatesRepository,
    config,
    redis.asRedis(),
    { getOrThrow: () => options.ttl ?? 300 } as unknown as ConfigService,
  );
  return { service, getRates, redis };
}

describe('PriceConversionService (FR-036, research R11)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('in the base currency', () => {
    it.each([
      ['a viewer with no preferred currency', null],
      ['a viewer whose currency is the base currency', 'SAR'],
      ['the base currency written in lower case', ' sar '],
    ])(
      'shows SAR prices for %s, and reads no rates',
      async (_label, currency) => {
        const { service, getRates } = setup();

        const [dto] = await service.convert([card()], currency);

        expect(dto).toMatchObject({
          price: '45.00',
          discountPercentage: '10.00',
          finalPrice: '40.50',
          currency: 'SAR',
        });
        expect(getRates).not.toHaveBeenCalled();
      },
    );

    it('keeps the card fields, and the order of the cards', async () => {
      const { service } = setup();

      const dtos = await service.convert(
        [
          card({ productId: 2, name: 'Two', available: false }),
          card({ productId: 1, name: 'One', imageUrl: 'https://img/1.jpg' }),
        ],
        null,
      );

      expect(dtos.map((d) => d.productId)).toEqual([2, 1]);
      expect(dtos[0]).toMatchObject({ name: 'Two', available: false });
      expect(dtos[1].imageUrl).toBe('https://img/1.jpg');
    });

    it('is fine with no cards, and asks for nothing', async () => {
      const { service, getRates } = setup();
      expect(await service.convert([], 'USD')).toEqual([]);
      expect(getRates).not.toHaveBeenCalled();
    });
  });

  describe('into another currency, rates as units per base currency (the default)', () => {
    it('converts the price, then applies the discount, then rounds', async () => {
      const { service } = setup();

      const [dto] = await service.convert([card()], 'USD');

      // 45.00 x 0.266667 = 12.000015, and 90% of that is 10.8000135.
      expect(dto).toMatchObject({
        price: '12.00',
        discountPercentage: '10.00',
        finalPrice: '10.80',
        currency: 'USD',
      });
    });

    it('does not convert the discount percentage', async () => {
      const { service } = setup({ rates: { USD: '0.5' } });
      const [dto] = await service.convert(
        [card({ price: '100.00', discountPercentage: '25.00' })],
        'USD',
      );
      expect(dto).toMatchObject({
        price: '50.00',
        discountPercentage: '25.00',
        finalPrice: '37.50',
      });
    });

    it('rounds half up, once, after the discount', async () => {
      // 0.05 x 0.5 = 0.025, which is 0.03 half up. A float would say 0.02 (0.025 is 0.02499...).
      const { service } = setup({ rates: { USD: '0.5' } });
      const [dto] = await service.convert(
        [card({ price: '0.05', discountPercentage: '0.00' })],
        'USD',
      );
      expect(dto.price).toBe('0.03');
      expect(dto.finalPrice).toBe('0.03');
    });

    it('rounds the final price from the unrounded converted price, not from the rounded one', async () => {
      // converted = 0.145 x 1 = 0.145 -> price 0.15; final = 0.145 x 0.9 = 0.1305 -> 0.13.
      // Discounting the rounded 0.15 would give 0.135 -> 0.14.
      const { service } = setup({ rates: { USD: '1' } });
      const [dto] = await service.convert(
        [card({ price: '0.145', discountPercentage: '10.00' })],
        'USD',
      );
      expect([dto.price, dto.finalPrice]).toEqual(['0.15', '0.13']);
    });

    it('treats a discount of 100 or more as free, and no discount as the price', async () => {
      const { service } = setup();
      const dtos = await service.convert(
        [
          card({ productId: 1, discountPercentage: '100.00' }),
          card({ productId: 2, discountPercentage: '120.00' }),
          card({ productId: 3, discountPercentage: '0.00' }),
        ],
        null,
      );
      expect(dtos.map((d) => d.finalPrice)).toEqual(['0.00', '0.00', '45.00']);
    });
  });

  describe('rates as base currency per unit (CHINAPARTS_FX_RATE_DIRECTION=to_base)', () => {
    it('divides instead', async () => {
      // 1 USD = 3.75 SAR, so 45.00 SAR is 12.00 USD.
      const { service } = setup({
        direction: 'to_base',
        rates: { USD: '3.75' },
      });

      const [dto] = await service.convert([card()], 'USD');

      expect(dto).toMatchObject({
        price: '12.00',
        finalPrice: '10.80',
        currency: 'USD',
      });
    });

    it('falls back when the rate is zero, which cannot be divided by', async () => {
      const { service } = setup({ direction: 'to_base', rates: { USD: '0' } });
      const [dto] = await service.convert([card()], 'USD');
      expect(dto).toMatchObject({ price: '45.00', currency: 'SAR' });
    });
  });

  describe('falling back to the base currency', () => {
    it('when the currency has no rate, and says so in the card and in the log', async () => {
      const { service } = setup({ rates: { SAR: '1' } });

      const [dto] = await service.convert([card()], 'EUR');

      expect(dto).toMatchObject({
        price: '45.00',
        finalPrice: '40.50',
        currency: 'SAR',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EUR'));
    });

    it.each(['0', 'abc', ''])('when the rate is %p', async (rate) => {
      const { service } = setup({ rates: { USD: rate } });
      const [dto] = await service.convert([card()], 'USD');
      expect(dto.currency).toBe('SAR');
    });

    it('when the rate table cannot be read', async () => {
      const { service, getRates } = setup();
      getRates.mockRejectedValue(new Error('China Parts is unreachable'));

      const [dto] = await service.convert([card()], 'USD');

      expect(dto).toMatchObject({ price: '45.00', currency: 'SAR' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    });
  });

  describe('the rate cache', () => {
    it('reads the table once for a while, however many cards and viewers', async () => {
      const { service, getRates } = setup();

      await service.convert([card()], 'USD');
      await service.convert([card(), card({ productId: 2 })], 'USD');
      await service.convert([card()], 'USD');

      expect(getRates).toHaveBeenCalledTimes(1);
    });

    it('reads it again once the cache has expired', async () => {
      jest.useFakeTimers();
      try {
        const { service, getRates } = setup({ ttl: 5 });
        await service.convert([card()], 'USD');
        jest.advanceTimersByTime(5_001);
        await service.convert([card()], 'USD');
        expect(getRates).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('reads again when the cached entry is damaged', async () => {
      const { service, getRates, redis } = setup();
      await redis.set('fx:rates', '{not json');

      const [dto] = await service.convert([card()], 'USD');

      expect(dto.currency).toBe('USD');
      expect(getRates).toHaveBeenCalledTimes(1);
    });
  });
});
