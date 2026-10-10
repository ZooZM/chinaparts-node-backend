import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccountType } from '../../common/http/viewer-request';

export type FxRateDirection = 'per_base' | 'to_base';

const IDENTIFIER = /^[A-Za-z0-9_]+$/;

function csv(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function identifier(value: string, name: string): string {
  // A table or column name cannot be a query parameter, so it is validated here and quoted by
  // the repository. Joi enforces the same pattern at boot (constitution IV).
  if (!IDENTIFIER.test(value)) {
    throw new Error(
      `${name} must contain only letters, digits and underscores`,
    );
  }
  return value;
}

/**
 * How China Parts' stored values map onto what this service means (contracts/chinaparts-read-model.md,
 * "Configuration that maps China Parts values"). Everything here is a default that the China
 * Parts team confirms before launch (research R4, R7, R11), so none of it is hard-coded in code
 * that uses it.
 */
@Injectable()
export class ChinaPartsConfig {
  /** `tokenable_type` and `media.model_type` values, lower-cased for comparison where noted. */
  readonly customerTypes: ReadonlySet<string>;
  readonly sellerTypes: ReadonlySet<string>;
  readonly productTypes: ReadonlySet<string>;
  readonly shopTypes: ReadonlySet<string>;
  /** `sellers.status` values that count as approved, lower-cased. */
  readonly approvedSellerStatuses: ReadonlySet<string>;
  readonly productImageCollection: string;
  readonly shopImageCollection: string;
  readonly sellerImageCollection: string;
  readonly mediaUrlTemplate: string;
  /** Base URL per `media.disk`. */
  readonly diskUrls: ReadonlyMap<string, string>;
  readonly publicStorageUrl: string;
  /** Mirrors `sanctum.expiration`. Null means tokens only expire through `expires_at`. */
  readonly tokenExpirationMinutes: number | null;
  readonly baseCurrency: string;
  readonly fx: {
    table: string;
    codeColumn: string;
    rateColumn: string;
    direction: FxRateDirection;
  };

  constructor(config: ConfigService) {
    const get = (key: string): string | undefined => config.get<string>(key);

    this.customerTypes = new Set(
      csv(get('CHINAPARTS_CUSTOMER_TYPES'), 'App\\Models\\Customer,customer'),
    );
    this.sellerTypes = new Set(
      csv(get('CHINAPARTS_SELLER_TYPES'), 'App\\Models\\Seller,seller'),
    );
    this.productTypes = new Set(
      csv(get('CHINAPARTS_PRODUCT_TYPES'), 'App\\Models\\Product,product'),
    );
    this.shopTypes = new Set(
      csv(get('CHINAPARTS_SHOP_TYPES'), 'App\\Models\\Shop,shop'),
    );
    this.approvedSellerStatuses = new Set(
      csv(get('CHINAPARTS_SELLER_APPROVED_VALUES'), 'approved,1').map((value) =>
        value.toLowerCase(),
      ),
    );
    this.productImageCollection =
      get('CHINAPARTS_PRODUCT_IMAGE_COLLECTION') || 'images';
    this.shopImageCollection =
      get('CHINAPARTS_SHOP_IMAGE_COLLECTION') || 'logo';
    this.sellerImageCollection =
      get('CHINAPARTS_SELLER_IMAGE_COLLECTION') || 'avatar';
    this.mediaUrlTemplate =
      get('CHINAPARTS_MEDIA_URL_TEMPLATE') || '{diskUrl}/{id}/{file_name}';
    this.diskUrls = new Map(
      csv(get('CHINAPARTS_DISK_URLS'), '').flatMap(
        (entry): [string, string][] => {
          const separator = entry.indexOf('=');
          if (separator <= 0) return [];
          return [
            [
              entry.slice(0, separator).trim(),
              entry
                .slice(separator + 1)
                .trim()
                .replace(/\/+$/, ''),
            ],
          ];
        },
      ),
    );
    this.publicStorageUrl = (
      get('CHINAPARTS_PUBLIC_STORAGE_URL') || ''
    ).replace(/\/+$/, '');

    const expiration = config.get<number | string | undefined>(
      'CHINAPARTS_TOKEN_EXPIRATION_MINUTES',
    );
    const minutes = expiration === undefined ? NaN : Number(expiration);
    this.tokenExpirationMinutes =
      Number.isFinite(minutes) && minutes > 0 ? minutes : null;

    this.baseCurrency = (
      get('CHINAPARTS_BASE_CURRENCY') || 'SAR'
    ).toUpperCase();
    this.fx = {
      table: identifier(
        get('CHINAPARTS_FX_TABLE') || 'currencies',
        'CHINAPARTS_FX_TABLE',
      ),
      codeColumn: identifier(
        get('CHINAPARTS_FX_CODE_COLUMN') || 'code',
        'CHINAPARTS_FX_CODE_COLUMN',
      ),
      rateColumn: identifier(
        get('CHINAPARTS_FX_RATE_COLUMN') || 'exchange_rate',
        'CHINAPARTS_FX_RATE_COLUMN',
      ),
      direction:
        get('CHINAPARTS_FX_RATE_DIRECTION') === 'to_base'
          ? 'to_base'
          : 'per_base',
    };
  }

  /** Maps a Sanctum `tokenable_type` to an account type. Anything else, admins included, is null (FR-007). */
  accountTypeOf(tokenableType: string): AccountType | null {
    if (this.customerTypes.has(tokenableType)) return 'customer';
    if (this.sellerTypes.has(tokenableType)) return 'seller';
    return null;
  }

  /** The `model_type` values to match for an account type's images. */
  accountModelTypes(accountType: AccountType): string[] {
    return [
      ...(accountType === 'customer' ? this.customerTypes : this.sellerTypes),
    ];
  }

  /** The `tokenable_type` values to match for an account type's devices. */
  tokenableTypes(accountType: AccountType): string[] {
    return this.accountModelTypes(accountType);
  }
}
