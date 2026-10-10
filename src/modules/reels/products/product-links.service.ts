import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Types } from 'mongoose';
import { LimitsService } from '../../../common/config/limits';
import { ErrorCode } from '../../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../../common/http/viewer-request';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { ChinaPartsProductsRepository } from '../../china-parts/products.repository';
import type { ProductCardRow } from '../../china-parts/products.repository';
import { REELS_REPOSITORY } from '../reels.repository';
import type { ReelsRepository } from '../reels.repository';

/** A product card in the base currency, as it is cached. Conversion happens per viewer. */
export interface BaseCard {
  productId: number;
  sellerExternalId: number;
  name: string;
  slug: string;
  imageUrl: string | null;
  /** The default active variant's price, a decimal string in the base currency. */
  price: string;
  discountPercentage: string;
  available: boolean;
}

/** One product wanted on a card, and whose it must be. */
export interface CardRequest {
  productId: number;
  /** The China Parts id of the seller whose reel links it (FR-037). */
  sellerExternalId: number;
}

type CachedCard = BaseCard | { unavailable: true };

const cacheKey = (productId: number) => `product:card:${productId}`;

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}

function isUnavailable(entry: CachedCard): entry is { unavailable: true } {
  return 'unavailable' in entry;
}

function parseCached(raw: string | null): CachedCard | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null) {
      if ('unavailable' in value) return { unavailable: true };
      if ('productId' in value && 'sellerExternalId' in value) {
        return value as BaseCard;
      }
    }
  } catch {
    // A damaged entry is treated as absent and read again.
  }
  return undefined;
}

/**
 * Products on reels (FR-035 to FR-037, research R11): which products a seller may attach, and the
 * live cards shown under a reel.
 *
 * The cards come from China Parts, one batched query for the products not already cached, and are
 * cached per product for `PRODUCT_CARD_CACHE_SECONDS`, so a stale card lives at most that long. A
 * product that is not available (inactive, deleted, no price) is cached as unavailable too, so a
 * deactivated product does not send a query on every page view.
 *
 * Reading never fails because of China Parts: when it cannot be reached, the cards that are cached
 * are shown and the rest are left out. Attaching does fail (503), because nothing is granted
 * without verifying it.
 */
@Injectable()
export class ProductLinksService {
  private readonly logger = new Logger(ProductLinksService.name);
  private readonly cacheSeconds: number;

  constructor(
    private readonly products: ChinaPartsProductsRepository,
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly limits: LimitsService,
    config: ConfigService,
  ) {
    this.cacheSeconds = config.getOrThrow<number>('PRODUCT_CARD_CACHE_SECONDS');
  }

  /**
   * Throws unless every product is the seller's own, active and not deleted (FR-035): at most
   * `REEL_MAX_PRODUCTS` of them, else `TOO_MANY_PRODUCTS`, and the ones that do not qualify are
   * named in `PRODUCT_NOT_ATTACHABLE`. A product listed twice counts once.
   */
  async validateAttachable(
    sellerExternalId: number,
    productIds: number[],
  ): Promise<number[]> {
    const ids = unique(productIds);
    const max = this.limits.maxProducts;
    if (ids.length > max) {
      throw new BadRequestException({
        error: ErrorCode.TOO_MANY_PRODUCTS,
        message: `A reel can show at most ${max} products`,
        details: { maxProducts: max },
      });
    }
    if (ids.length === 0) return ids;

    const attachable = new Set(
      await this.products.findAttachable(sellerExternalId, ids),
    );
    const refused = ids.filter((id) => !attachable.has(id));
    if (refused.length > 0) {
      throw new BadRequestException({
        error: ErrorCode.PRODUCT_NOT_ATTACHABLE,
        message: 'Some products cannot be shown on a reel',
        details: { productIds: refused },
      });
    }
    return ids;
  }

  /** Replaces a reel's products. Only its creator may (FR-035). */
  async setLinks(
    reelId: string,
    owner: AuthenticatedUser,
    productIds: number[],
  ): Promise<void> {
    const reel = Types.ObjectId.isValid(reelId)
      ? await this.reels.getSnapshot(reelId)
      : null;
    if (!reel) {
      throw new NotFoundException({
        error: ErrorCode.REEL_NOT_FOUND,
        message: 'Reel not found',
      });
    }
    if (reel.creatorId !== owner.userId) {
      throw new ForbiddenException({
        error: ErrorCode.NOT_REEL_OWNER,
        message: 'Only the owner can change the products of this reel',
      });
    }
    const ids = await this.validateAttachable(owner.externalId, productIds);
    await this.reels.setProductLinks(reelId, ids);
  }

  /**
   * The cards that can be shown for the requested products, in the base currency, keyed by
   * product id. A product that is inactive, deleted, without a price, or not owned by the seller
   * named in its request is left out (FR-037); its link stays stored.
   */
  async getCards(requests: CardRequest[]): Promise<Map<number, BaseCard>> {
    const ids = unique(requests.map((request) => request.productId));
    if (ids.length === 0) return new Map();

    const entries = await this.readCache(ids);
    const missing = ids.filter((id) => !entries.has(id));
    if (missing.length > 0) {
      await this.fill(missing, entries);
    }

    const cards = new Map<number, BaseCard>();
    for (const request of requests) {
      const entry = entries.get(request.productId);
      if (
        entry &&
        !isUnavailable(entry) &&
        entry.sellerExternalId === request.sellerExternalId
      ) {
        cards.set(request.productId, entry);
      }
    }
    return cards;
  }

  private async readCache(ids: number[]): Promise<Map<number, CachedCard>> {
    const entries = new Map<number, CachedCard>();
    try {
      const raw = await this.redis.mget(...ids.map(cacheKey));
      ids.forEach((id, index) => {
        const entry = parseCached(raw[index]);
        if (entry) entries.set(id, entry);
      });
    } catch (error) {
      // No cache is slower, not wrong.
      this.logger.warn(
        `Product card cache could not be read: ${String(error)}`,
      );
    }
    return entries;
  }

  /** Reads the missing products from China Parts and caches what it finds. Never throws. */
  private async fill(
    missing: number[],
    entries: Map<number, CachedCard>,
  ): Promise<void> {
    let rows: ProductCardRow[];
    try {
      rows = await this.products.getCardRows(missing);
    } catch (error) {
      this.logger.warn(
        `China Parts is unreachable, showing only cached product cards: ${String(error)}`,
      );
      return;
    }
    const byId = new Map(rows.map((row) => [row.productId, row]));
    for (const id of missing) {
      const row = byId.get(id);
      const entry: CachedCard = (row && toBaseCard(row)) ?? {
        unavailable: true,
      };
      entries.set(id, entry);
      try {
        await this.redis.set(
          cacheKey(id),
          JSON.stringify(entry),
          'EX',
          this.cacheSeconds,
        );
      } catch (error) {
        this.logger.warn(`Product card could not be cached: ${String(error)}`);
      }
    }
  }
}

/** The card, or null when the product cannot be shown. */
function toBaseCard(row: ProductCardRow): BaseCard | null {
  if (!row.active || row.deleted || row.sellingPrice === null) return null;
  return {
    productId: row.productId,
    sellerExternalId: row.sellerExternalId,
    name: row.name,
    slug: row.slug,
    imageUrl: row.imageUrl,
    price: row.sellingPrice,
    discountPercentage: row.discountPercentage,
    available: row.stockQuantity > 0,
  };
}
