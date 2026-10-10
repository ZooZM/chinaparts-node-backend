import { Injectable } from '@nestjs/common';
import { RowDataPacket } from 'mysql2/promise';
import type { AccountType } from '../../common/http/viewer-request';
import { ChinaPartsConfig } from './china-parts.config';
import { ChinaPartsMediaRepository } from './media.repository';
import { ChinaPartsDb } from './mysql.provider';

/** An account as China Parts currently describes it. Display data only: no email, phone or id numbers. */
export interface ChinaPartsAccount {
  accountType: AccountType;
  externalId: number;
  /** The public name (FR-011, FR-012). */
  name: string;
  avatarUrl: string | null;
  /**
   * Accounts China Parts no longer has are never returned, so "deleted" is not a value here: the
   * sync derives it from absence (research R7).
   */
  standing: 'good' | 'suspended';
  /** Three-letter code, or null for the base currency (FR-036). */
  preferredCurrency: string | null;
}

interface CustomerRow extends RowDataPacket {
  id: number;
  first_name: string;
  last_name: string;
  image: string | null;
  status: number | string;
  preferred_currency: string | null;
}

interface SellerRow extends RowDataPacket {
  id: number;
  first_name: string;
  last_name: string;
  status: string;
  preferred_currency: string | null;
  shop_id: number | null;
  shop_name: string | null;
}

const BATCH_SIZE = 1_000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** First name plus the last name's initial: "Sara Khalid" becomes "Sara K." (FR-011, FR-012). */
export function publicName(firstName: string, lastName: string): string {
  const first = (firstName ?? '').trim();
  const initial = Array.from((lastName ?? '').trim())[0];
  return initial ? `${first} ${initial.toUpperCase()}.`.trim() : first;
}

function normalizeCurrency(value: string | null): string | null {
  const code = (value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Reads account display data and standing from China Parts (research R7). Every query names its
 * columns, because the database user only holds column-level grants, and none of them selects a
 * private field.
 */
@Injectable()
export class ChinaPartsAccountsRepository {
  constructor(
    private readonly db: ChinaPartsDb,
    private readonly config: ChinaPartsConfig,
    private readonly media: ChinaPartsMediaRepository,
  ) {}

  /** The customers that exist among `ids`. Missing ids are simply absent from the result. */
  async getCustomers(ids: number[]): Promise<ChinaPartsAccount[]> {
    const accounts: ChinaPartsAccount[] = [];
    for (const batch of chunk([...new Set(ids)], BATCH_SIZE)) {
      const rows = await this.db.query<CustomerRow>(
        'SELECT id, first_name, last_name, image, status, preferred_currency ' +
          'FROM customers WHERE id IN (?)',
        [batch],
      );
      for (const row of rows) {
        accounts.push({
          accountType: 'customer',
          externalId: Number(row.id),
          name: publicName(row.first_name, row.last_name),
          avatarUrl: this.customerAvatar(row.image),
          standing: Number(row.status) === 1 ? 'good' : 'suspended',
          preferredCurrency: normalizeCurrency(row.preferred_currency),
        });
      }
    }
    return accounts;
  }

  /**
   * The sellers that exist among `ids`. The public name is the lowest-id shop's name, falling
   * back to the seller's own name when there is no shop (FR-011).
   */
  async getSellers(ids: number[]): Promise<ChinaPartsAccount[]> {
    const accounts: ChinaPartsAccount[] = [];
    for (const batch of chunk([...new Set(ids)], BATCH_SIZE)) {
      const rows = await this.db.query<SellerRow>(
        'SELECT s.id, s.first_name, s.last_name, s.status, s.preferred_currency, ' +
          '(SELECT id FROM shops WHERE seller_id = s.id ORDER BY id LIMIT 1) AS shop_id, ' +
          '(SELECT name FROM shops WHERE seller_id = s.id ORDER BY id LIMIT 1) AS shop_name ' +
          'FROM sellers s WHERE s.id IN (?)',
        [batch],
      );
      if (rows.length === 0) continue;

      const sellerIds = rows.map((row) => Number(row.id));
      const shopIds = rows
        .map((row) => row.shop_id)
        .filter((id): id is number => id !== null)
        .map(Number);
      const [shopLogos, sellerAvatars] = await Promise.all([
        this.media.firstImageUrls(
          [...this.config.shopTypes],
          this.config.shopImageCollection,
          shopIds,
        ),
        this.media.firstImageUrls(
          this.config.accountModelTypes('seller'),
          this.config.sellerImageCollection,
          sellerIds,
        ),
      ]);

      for (const row of rows) {
        const shopName = (row.shop_name ?? '').trim();
        const shopLogo =
          row.shop_id === null ? undefined : shopLogos.get(Number(row.shop_id));
        accounts.push({
          accountType: 'seller',
          externalId: Number(row.id),
          name: shopName || publicName(row.first_name, row.last_name),
          // The public name is the shop's, so the shop's logo comes first.
          avatarUrl: shopLogo ?? sellerAvatars.get(Number(row.id)) ?? null,
          standing: this.config.approvedSellerStatuses.has(
            String(row.status).trim().toLowerCase(),
          )
            ? 'good'
            : 'suspended',
          preferredCurrency: normalizeCurrency(row.preferred_currency),
        });
      }
    }
    return accounts;
  }

  private customerAvatar(image: string | null): string | null {
    const value = (image ?? '').trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    // A relative path needs the storage base; without it there is nothing to point at.
    if (!this.config.publicStorageUrl) return null;
    return `${this.config.publicStorageUrl}/${value.replace(/^\/+/, '')}`;
  }
}
