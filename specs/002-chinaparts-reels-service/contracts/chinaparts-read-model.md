# Contract: China Parts Read Model

**Feature**: `002-chinaparts-reels-service`

This is the complete list of China Parts data the reels service may read. Anything not listed here is unreadable, because the MySQL grants are column-level (research R3). Adding a column requires updating this file and the grant script together.

The source is the schema dump `chinaparts_dev.sql` (MySQL 8.0.46) supplied with the feature request.

## Columns read

| Table | Columns | Used for |
|-------|---------|----------|
| `personal_access_tokens` | `id`, `tokenable_type`, `tokenable_id`, `token`, `expires_at`, `created_at` | Session validation (R4) |
| `customers` | `id`, `first_name`, `last_name`, `image`, `status`, `preferred_currency` | Customer public name, picture, standing, card currency (R7) |
| `sellers` | `id`, `first_name`, `last_name`, `status`, `preferred_currency` | Seller fallback name, standing, card currency (R7) |
| `shops` | `id`, `seller_id`, `name` | Seller public name: the lowest-id shop |
| `products` | `id`, `seller_id`, `name`, `slug`, `status`, `stock_quantity`, `discount_percentage`, `deleted_at` | Attach validation and product cards (R11) |
| `product_variants` | `id`, `product_id`, `selling_price`, `is_default`, `status` | Card price |
| `media` | `id`, `model_type`, `model_id`, `uuid`, `collection_name`, `file_name`, `disk`, `order_column` | Product, shop, and seller images |
| `device_tokens` | `tokenable_type`, `tokenable_id`, `token`, `platform`, `app` | Push recipients (R14) |
| Exchange-rate table, `currencies` by default (**Verify**) | Currency code and rate columns, `code` and `exchange_rate` by default | Card currency conversion (R11, FR-036) |

The `updated_at` columns are no longer read. Every sync re-reads each account in full by primary key (R7), so nothing depends on `updated_at` being maintained.

These are **never readable**: passwords, emails, phones, national IDs, identity review data, addresses, wallets, payments, orders, carts, conversations, and every other table. This enforces FR-016 at the database level.

## Grant script (run by the China Parts team)

```sql
-- Replace <db>, <host> and <secret>. Prefer a read replica. Require TLS.
CREATE USER 'reels_ro'@'<host>' IDENTIFIED BY '<secret>' REQUIRE SSL;

GRANT SELECT (id, tokenable_type, tokenable_id, token, expires_at, created_at)
  ON <db>.personal_access_tokens TO 'reels_ro'@'<host>';
GRANT SELECT (id, first_name, last_name, image, status, preferred_currency)
  ON <db>.customers TO 'reels_ro'@'<host>';
GRANT SELECT (id, first_name, last_name, status, preferred_currency)
  ON <db>.sellers TO 'reels_ro'@'<host>';
GRANT SELECT (id, seller_id, name)
  ON <db>.shops TO 'reels_ro'@'<host>';
GRANT SELECT (id, seller_id, name, slug, status, stock_quantity, discount_percentage, deleted_at)
  ON <db>.products TO 'reels_ro'@'<host>';
GRANT SELECT (id, product_id, selling_price, is_default, status)
  ON <db>.product_variants TO 'reels_ro'@'<host>';
GRANT SELECT (id, model_type, model_id, uuid, collection_name, file_name, disk, order_column)
  ON <db>.media TO 'reels_ro'@'<host>';
GRANT SELECT (tokenable_type, tokenable_id, token, platform, app)
  ON <db>.device_tokens TO 'reels_ro'@'<host>';
-- Exchange rates (Verify the table and column names, then match CHINAPARTS_FX_*):
GRANT SELECT (<fx_code_column>, <fx_rate_column>)
  ON <db>.<fx_table> TO 'reels_ro'@'<host>';

-- Optional, for the SC-006 read-only proof in staging only:
-- GRANT SELECT ON <db>.* TO 'reels_audit'@'<host>';  -- separate user, used by CHECKSUM TABLE in tests
```

Queries must name their columns. `SELECT *` fails under column grants, which is intended.

## Queries the service runs

All queries are parameterized and run in the `china-parts` module only.

| Purpose | Query shape |
|---------|-------------|
| Token by id | `SELECT id, tokenable_type, tokenable_id, token, expires_at, created_at FROM personal_access_tokens WHERE id = ?` |
| Token by hash | `… WHERE token = ?` (sha256 hex) |
| Customer accounts | `SELECT id, first_name, last_name, image, status, preferred_currency FROM customers WHERE id IN (?)` (batches of 1,000, used by sign-in and by every sync) |
| Seller accounts | `SELECT s.id, s.first_name, s.last_name, s.status, s.preferred_currency, (SELECT name FROM shops WHERE seller_id = s.id ORDER BY id LIMIT 1) AS shop_name FROM sellers s WHERE s.id IN (?)` (batches of 1,000) |
| Images | `SELECT model_type, model_id, uuid, file_name, disk, collection_name, order_column FROM media WHERE model_type = ? AND model_id IN (?) AND collection_name = ? ORDER BY order_column` |
| Attachable products | `SELECT id FROM products WHERE id IN (?) AND seller_id = ? AND status = 1 AND deleted_at IS NULL` |
| Product cards | `SELECT p.id, p.seller_id, p.name, p.slug, p.status, p.stock_quantity, p.discount_percentage, p.deleted_at, v.selling_price FROM products p LEFT JOIN product_variants v ON v.product_id = p.id AND v.is_default = 1 AND v.status = 1 WHERE p.id IN (?)` |
| Device tokens | `SELECT token, platform FROM device_tokens WHERE tokenable_type IN (?) AND tokenable_id = ? AND app = ?` |
| Exchange rates | ``SELECT `<code>`, `<rate>` FROM `<fx_table>` `` with identifiers from `CHINAPARTS_FX_*`, validated at boot against `^[A-Za-z0-9_]+$` (R11) |

An account missing from a batch result counts as missing for that sync cycle (R7).

## Configuration that maps China Parts values

| Variable | Default | Meaning |
|----------|---------|---------|
| `CHINAPARTS_CUSTOMER_TYPES` | `App\Models\Customer,customer` | `tokenable_type` and `model_type` values for customers |
| `CHINAPARTS_SELLER_TYPES` | `App\Models\Seller,seller` | Values for sellers |
| `CHINAPARTS_PRODUCT_TYPES` | `App\Models\Product,product` | `media.model_type` values for products |
| `CHINAPARTS_SHOP_TYPES` | `App\Models\Shop,shop` | `media.model_type` values for shops |
| `CHINAPARTS_SELLER_APPROVED_VALUES` | `approved,1` | `sellers.status` values that count as approved |
| `CHINAPARTS_TOKEN_EXPIRATION_MINUTES` | empty (no expiry) | Mirrors `sanctum.expiration` |
| `CHINAPARTS_PRODUCT_IMAGE_COLLECTION` / `CHINAPARTS_SHOP_IMAGE_COLLECTION` / `CHINAPARTS_SELLER_IMAGE_COLLECTION` | `images` / `logo` / `avatar` | `media.collection_name` values |
| `CHINAPARTS_MEDIA_URL_TEMPLATE` | `{diskUrl}/{id}/{file_name}` | Media URL template (default media-library layout) |
| `CHINAPARTS_DISK_URLS` | `public=https://<china-parts-domain>/storage` | Base URL per `media.disk` |
| `CHINAPARTS_PUBLIC_STORAGE_URL` | `https://<china-parts-domain>/storage` | Base URL for relative `customers.image` paths |
| `CHINAPARTS_BASE_CURRENCY` | `SAR` | Currency of `selling_price` |
| `CHINAPARTS_FX_TABLE` / `CHINAPARTS_FX_CODE_COLUMN` / `CHINAPARTS_FX_RATE_COLUMN` | `currencies` / `code` / `exchange_rate` | Where China Parts keeps exchange rates (**Verify**). Identifiers only: letters, digits, and `_` |
| `CHINAPARTS_FX_RATE_DIRECTION` | `per_base` | `per_base`: a rate is units of that currency per 1 base unit. `to_base`: the reverse (**Verify**) |

## Verification checklist for the China Parts team

These must be confirmed before production. Each one maps to a **Verify** note in [research.md](../research.md).

- [ ] The actual `tokenable_type` and `media.model_type` strings for customers, sellers, shops, products, and admins
- [ ] Whether `sanctum.expiration` and `sanctum.token_prefix` are configured
- [ ] The actual `sellers.status` values for approved, pending, rejected, and suspended
- [ ] The media collection names, disks, and public URL layout for product, shop, and seller images, and the `customers.image` format
- [ ] Whether storefront prices apply anything beyond `products.discount_percentage`, such as offers or big sales, so cards match product pages
- [ ] The table and columns holding exchange rates, the direction of a rate, and how and when China Parts rounds converted prices (FR-036)
- [ ] The values `customers.preferred_currency` and `sellers.preferred_currency` hold, and what an empty value means
- [ ] The `device_tokens.app` values, and whether the customer and seller apps share one Firebase project
- [ ] Whether a read replica is available, and the network path from the reels hosting in Saudi Arabia

## Appendix: source table definitions

Copied unchanged from `chinaparts_dev.sql`. They are used to build `test/fixtures/chinaparts-schema.sql`.

The exchange-rate table isn't copied yet, because it hasn't been identified in the dump (see the checklist above). Until it is, the test fixture uses a stand-in `currencies (code varchar(3), exchange_rate decimal(16,6))` that matches the default `CHINAPARTS_FX_*` values.

```sql
CREATE TABLE `personal_access_tokens` (
  `id` bigint UNSIGNED NOT NULL,
  `tokenable_type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tokenable_id` bigint UNSIGNED NOT NULL,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `token` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `abilities` text COLLATE utf8mb4_unicode_ci,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `customers` (
  `id` bigint UNSIGNED NOT NULL,
  `first_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `preferred_currency` varchar(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `image` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `remember_token` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0: inactive, 1: active',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sellers` (
  `id` bigint UNSIGNED NOT NULL,
  `ship_from_address_id` bigint UNSIGNED DEFAULT NULL,
  `first_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `phone` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `preferred_currency` varchar(3) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `national_id_number` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `identity_status` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending_review',
  `identity_rejection_reason` text COLLATE utf8mb4_unicode_ci,
  `identity_submitted_at` timestamp NULL DEFAULT NULL,
  `identity_reviewed_at` timestamp NULL DEFAULT NULL,
  `identity_reviewed_by` bigint UNSIGNED DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' COMMENT '0: pending, 1: approved, 2: rejected, 3: suspended',
  `sales_commission_percentage` decimal(8,2) NOT NULL DEFAULT '0.00',
  `remember_token` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `shops` (
  `id` bigint UNSIGNED NOT NULL,
  `seller_id` bigint UNSIGNED NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `tax_identification_number` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `commercial_registration_number` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `products` (
  `id` bigint UNSIGNED NOT NULL,
  `seller_id` bigint UNSIGNED NOT NULL,
  `brand_id` bigint UNSIGNED DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `details_info` text COLLATE utf8mb4_unicode_ci COMMENT 'Product Details/Specs',
  `shipping_info` text COLLATE utf8mb4_unicode_ci COMMENT 'Shipping and Delivery Details',
  `return_info` text COLLATE utf8mb4_unicode_ci COMMENT 'Return Information',
  `specifications` json DEFAULT NULL,
  `sku` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `manufacturer_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `category_id` bigint UNSIGNED DEFAULT NULL,
  `sub_category_id` bigint UNSIGNED DEFAULT NULL,
  `quality_type_id` bigint UNSIGNED DEFAULT NULL,
  `weight` decimal(10,2) DEFAULT NULL COMMENT 'in kg',
  `height` decimal(10,2) DEFAULT NULL COMMENT 'in cm',
  `width` decimal(10,2) DEFAULT NULL COMMENT 'in cm',
  `length` decimal(10,2) DEFAULT NULL COMMENT 'in cm',
  `is_fragile` tinyint(1) NOT NULL DEFAULT '0',
  `hs_code` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `origin_country` char(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `customs_description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `stock_quantity` int NOT NULL DEFAULT '0' COMMENT 'Stock of all variants',
  `slug` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `average_rating` decimal(3,2) NOT NULL DEFAULT '0.00',
  `total_reviews` int NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0: inactive, 1: active, 2: draft',
  `store_step` int NOT NULL DEFAULT '1' COMMENT 'Creation wizard step',
  `deleted_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `offer_id` bigint UNSIGNED DEFAULT NULL,
  `discount_percentage` decimal(5,2) NOT NULL DEFAULT '0.00'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `product_variants` (
  `id` bigint UNSIGNED NOT NULL,
  `product_id` bigint UNSIGNED NOT NULL,
  `variant_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'e.g., Red-Large, Black-Medium',
  `stock_quantity` int NOT NULL DEFAULT '0',
  `weight` decimal(8,3) DEFAULT NULL,
  `weight_unit` enum('lb','oz','g','kg') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'kg',
  `length` decimal(8,3) DEFAULT NULL,
  `width` decimal(8,3) DEFAULT NULL,
  `height` decimal(8,3) DEFAULT NULL,
  `dimension_unit` enum('in','cm') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'cm',
  `cost_price` decimal(10,2) DEFAULT NULL,
  `selling_price` decimal(10,2) NOT NULL DEFAULT '0.00',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `status` tinyint NOT NULL DEFAULT '1' COMMENT '0: inactive, 1: active',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `media` (
  `id` bigint UNSIGNED NOT NULL,
  `model_type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `model_id` bigint UNSIGNED NOT NULL,
  `uuid` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `collection_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime_type` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `disk` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `conversions_disk` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `size` bigint UNSIGNED NOT NULL,
  `manipulations` json NOT NULL,
  `custom_properties` json NOT NULL,
  `generated_conversions` json NOT NULL,
  `responsive_images` json NOT NULL,
  `order_column` int UNSIGNED DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `device_tokens` (
  `id` bigint UNSIGNED NOT NULL,
  `tokenable_type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tokenable_id` bigint UNSIGNED NOT NULL,
  `token` varchar(512) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `platform` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'customer',
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Primary keys and indexes from the dump that these queries rely on:
- `personal_access_tokens`: `PRIMARY(id)`, `UNIQUE(token)`
- `shops`: `KEY(seller_id)`
- `products`: `PRIMARY(id)`, `KEY(seller_id)`, `KEY(status)`
- `product_variants`: `KEY(product_id)`
- `media`: `KEY(model_type, model_id)`
- `device_tokens`: `KEY(tokenable_type, tokenable_id)`

The fixture must also add these keys and the primary keys.
