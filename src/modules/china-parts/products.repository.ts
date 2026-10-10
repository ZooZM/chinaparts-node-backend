import { Injectable } from '@nestjs/common';
import { RowDataPacket } from 'mysql2/promise';
import { ChinaPartsConfig } from './china-parts.config';
import { ChinaPartsMediaRepository } from './media.repository';
import { ChinaPartsDb } from './mysql.provider';

interface CardRow extends RowDataPacket {
  id: number;
  seller_id: number;
  name: string;
  slug: string;
  status: number | string;
  stock_quantity: number | string;
  discount_percentage: string | number;
  deleted_at: Date | null;
  selling_price: string | number | null;
}

/** A product as a card needs it, straight from China Parts, in the base currency. */
export interface ProductCardRow {
  productId: number;
  sellerExternalId: number;
  name: string;
  slug: string;
  /** `products.status = 1`. */
  active: boolean;
  /** `products.deleted_at` is set (a soft delete). */
  deleted: boolean;
  stockQuantity: number;
  /** A decimal string such as "10.00", exactly as China Parts stores it. */
  discountPercentage: string;
  /** The default active variant's `selling_price`, a decimal string, or null if it has none. */
  sellingPrice: string | null;
  imageUrl: string | null;
}

const BATCH_SIZE = 1_000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Reads products from China Parts (research R11): which of a seller's products may be attached to
 * a reel, and the data a product card shows. Every query names its columns, because the database
 * user only holds column-level grants. Prices stay decimal strings, never floats.
 */
@Injectable()
export class ChinaPartsProductsRepository {
  constructor(
    private readonly db: ChinaPartsDb,
    private readonly config: ChinaPartsConfig,
    private readonly media: ChinaPartsMediaRepository,
  ) {}

  /**
   * The ids among `productIds` that this seller owns, that are active, and that are not deleted
   * (FR-035). An id that is missing from the result may not be attached.
   */
  async findAttachable(
    sellerExternalId: number,
    productIds: number[],
  ): Promise<number[]> {
    const attachable: number[] = [];
    for (const batch of chunk([...new Set(productIds)], BATCH_SIZE)) {
      const rows = await this.db.query<RowDataPacket>(
        'SELECT id FROM products WHERE id IN (?) AND seller_id = ? AND status = 1 AND deleted_at IS NULL',
        [batch, sellerExternalId],
      );
      attachable.push(...rows.map((row) => Number(row.id)));
    }
    return attachable;
  }

  /**
   * Card data for products, whatever their state: the caller decides what to leave out (FR-037).
   * One query for the rows and one for the first image of each, however many products.
   */
  async getCardRows(productIds: number[]): Promise<ProductCardRow[]> {
    const cards: ProductCardRow[] = [];
    for (const batch of chunk([...new Set(productIds)], BATCH_SIZE)) {
      const rows = await this.db.query<CardRow>(
        'SELECT p.id, p.seller_id, p.name, p.slug, p.status, p.stock_quantity, ' +
          'p.discount_percentage, p.deleted_at, v.selling_price ' +
          'FROM products p ' +
          'LEFT JOIN product_variants v ON v.product_id = p.id AND v.is_default = 1 AND v.status = 1 ' +
          'WHERE p.id IN (?)',
        [batch],
      );
      if (rows.length === 0) continue;

      const images = await this.media.firstImageUrls(
        [...this.config.productTypes],
        this.config.productImageCollection,
        rows.map((row) => Number(row.id)),
      );
      for (const row of rows) {
        const productId = Number(row.id);
        cards.push({
          productId,
          sellerExternalId: Number(row.seller_id),
          name: row.name,
          slug: row.slug,
          active: Number(row.status) === 1,
          deleted: row.deleted_at !== null,
          stockQuantity: Number(row.stock_quantity),
          discountPercentage: String(row.discount_percentage),
          sellingPrice:
            row.selling_price === null ? null : String(row.selling_price),
          imageUrl: images.get(productId) ?? null,
        });
      }
    }
    return cards;
  }
}
