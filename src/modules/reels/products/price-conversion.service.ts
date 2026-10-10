import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { ChinaPartsConfig } from '../../china-parts/china-parts.config';
import { ChinaPartsExchangeRatesRepository } from '../../china-parts/exchange-rates.repository';
import type { ProductCardDto } from '../reels.repository';
import {
  divide,
  Fraction,
  isZero,
  multiply,
  parseDecimal,
  toMoney,
} from './decimal.util';
import type { BaseCard } from './product-links.service';

const RATES_KEY = 'fx:rates';

/**
 * Puts product cards into the viewer's preferred currency (FR-036, research R11).
 *
 * The order is the provisional rule: convert the base price, then apply the discount, then round
 * half up to two decimals. `discountPercentage` is a percentage and is never converted. Until China
 * Parts confirms how its own storefront computes a final price, that rule is a documented guess
 * (the launch checklist blocks on it), which is why every step is exact and none is hidden.
 *
 * It never gets in the way of showing a card. A viewer with no preferred currency, a currency with
 * no rate, and a rate table that cannot be read all give the card in the base currency, and the
 * card's `currency` field always says which unit the prices are in, so a price is never shown in
 * the wrong one.
 */
@Injectable()
export class PriceConversionService {
  private readonly logger = new Logger(PriceConversionService.name);
  private readonly ratesTtlSeconds: number;

  constructor(
    private readonly rates: ChinaPartsExchangeRatesRepository,
    private readonly chinaParts: ChinaPartsConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.ratesTtlSeconds = config.getOrThrow<number>('FX_CACHE_SECONDS');
  }

  async convert(
    cards: BaseCard[],
    viewerCurrency: string | null,
  ): Promise<ProductCardDto[]> {
    const base = this.chinaParts.baseCurrency;
    const target = (viewerCurrency ?? '').trim().toUpperCase();
    const rate =
      cards.length > 0 && target !== '' && target !== base
        ? await this.rateFor(target)
        : null;

    const currency = rate ? target : base;
    return cards.map((card) => this.toDto(card, currency, rate));
  }

  private toDto(
    card: BaseCard,
    currency: string,
    rate: Fraction | null,
  ): ProductCardDto {
    const price = parseDecimal(card.price) ?? { num: 0n, den: 1n };
    const discount = parseDecimal(card.discountPercentage) ?? {
      num: 0n,
      den: 1n,
    };
    const converted = !rate
      ? price
      : this.chinaParts.fx.direction === 'to_base'
        ? divide(price, rate)
        : multiply(price, rate);

    // (100 - discount) / 100 of the converted price, never below zero.
    const hundred = 100n * discount.den;
    const kept = discount.num >= hundred ? 0n : hundred - discount.num;
    const final = { num: converted.num * kept, den: converted.den * hundred };

    return {
      productId: card.productId,
      slug: card.slug,
      name: card.name,
      imageUrl: card.imageUrl,
      price: toMoney(converted),
      discountPercentage: toMoney(discount),
      finalPrice: toMoney(final),
      currency,
      available: card.available,
    };
  }

  /** The rate for a currency, or null when there is none or the table cannot be read. */
  private async rateFor(currency: string): Promise<Fraction | null> {
    let table: Map<string, string>;
    try {
      table = await this.readRates();
    } catch (error) {
      this.logger.warn(
        `Exchange rates are unavailable, showing ${this.chinaParts.baseCurrency}: ${String(error)}`,
      );
      return null;
    }
    const rate = parseDecimal(table.get(currency) ?? '');
    if (!rate || isZero(rate)) {
      this.logger.warn(
        `No usable exchange rate for ${currency}, showing ${this.chinaParts.baseCurrency}`,
      );
      return null;
    }
    return rate;
  }

  private async readRates(): Promise<Map<string, string>> {
    const cached = await this.redis.get(RATES_KEY);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (typeof parsed === 'object' && parsed !== null) {
          return new Map(
            Object.entries(parsed as Record<string, unknown>).map(
              ([code, rate]) => [code, String(rate)],
            ),
          );
        }
      } catch {
        // A damaged entry is read again below.
      }
    }
    const fresh = await this.rates.getRates();
    await this.redis.set(
      RATES_KEY,
      JSON.stringify(Object.fromEntries(fresh)),
      'EX',
      this.ratesTtlSeconds,
    );
    return fresh;
  }
}
