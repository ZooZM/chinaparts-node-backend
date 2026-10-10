-- Collision fixture (SC-005): customers 1 to 3 and sellers 1 to 3 share the same numbers.
-- Everything private (email, phone, national id, password) is filled in on purpose, to prove the
-- reels user cannot read it. See specs/002-chinaparts-reels-service/quickstart.md section 2.
USE `chinaparts_dev`;
SET NAMES utf8mb4;

-- customers: 1 active, 2 active with a USD preference, 3 inactive (status 0)
INSERT INTO `customers`
  (`id`, `first_name`, `last_name`, `email`, `phone`, `preferred_currency`, `image`, `password`, `status`, `created_at`, `updated_at`)
VALUES
  (1, 'Sara', 'Khalid', 'sara@example.test', '+966500000001', NULL, 'customers/sara.jpg', 'x', 1, NOW(), NOW()),
  (2, 'Omar', 'Nasser', 'omar@example.test', '+966500000002', 'USD', NULL, 'x', 1, NOW(), NOW()),
  (3, 'Lina', 'Hassan', 'lina@example.test', '+966500000003', NULL, NULL, 'x', 0, NOW(), NOW());

-- sellers: 1 approved (Arabic-only shop name), 2 suspended, 3 pending (no shop)
INSERT INTO `sellers`
  (`id`, `first_name`, `last_name`, `phone`, `preferred_currency`, `national_id_number`, `identity_status`, `email`, `password`, `status`, `created_at`, `updated_at`)
VALUES
  (1, 'Ahmed', 'Salem', '+966510000001', NULL, '1000000001', 'pending_review', 'ahmed@example.test', 'x', 'approved', NOW(), NOW()),
  (2, 'Mona', 'Fahd', '+966510000002', NULL, '1000000002', 'approved', 'mona@example.test', 'x', 'suspended', NOW(), NOW()),
  (3, 'Yousef', 'Rashed', '+966510000003', NULL, '1000000003', 'rejected', 'yousef@example.test', 'x', 'pending', NOW(), NOW());

INSERT INTO `shops` (`id`, `seller_id`, `name`, `created_at`, `updated_at`) VALUES
  (1, 1, 'قطع غيار الرياض', NOW(), NOW()),
  (2, 2, 'Dammam Auto Parts', NOW(), NOW());

-- products for seller 1: 101 active (stock 5, 10% off), 102 active (stock 0), 103 inactive, 104 soft-deleted.
-- 201 belongs to seller 2.
INSERT INTO `products`
  (`id`, `seller_id`, `name`, `sku`, `slug`, `stock_quantity`, `status`, `deleted_at`, `discount_percentage`, `created_at`, `updated_at`)
VALUES
  (101, 1, 'Toyota Camry Oil Filter', 'SKU-101', 'toyota-camry-oil-filter-101', 5, 1, NULL, 10.00, NOW(), NOW()),
  (102, 1, 'Brake Pad Set', 'SKU-102', 'brake-pad-set-102', 0, 1, NULL, 0.00, NOW(), NOW()),
  (103, 1, 'Spark Plug (inactive)', 'SKU-103', 'spark-plug-103', 3, 0, NULL, 0.00, NOW(), NOW()),
  (104, 1, 'Air Filter (deleted)', 'SKU-104', 'air-filter-104', 3, 1, NOW(), 0.00, NOW(), NOW()),
  (201, 2, 'Radiator Hose', 'SKU-201', 'radiator-hose-201', 8, 1, NULL, 0.00, NOW(), NOW());

-- one default active variant per product, all at 45.00
INSERT INTO `product_variants`
  (`id`, `product_id`, `stock_quantity`, `selling_price`, `is_default`, `status`, `created_at`, `updated_at`)
VALUES
  (1, 101, 5, 45.00, 1, 1, NOW(), NOW()),
  (2, 102, 0, 45.00, 1, 1, NOW(), NOW()),
  (3, 103, 3, 45.00, 1, 1, NOW(), NOW()),
  (4, 104, 3, 45.00, 1, 1, NOW(), NOW()),
  (5, 201, 8, 45.00, 1, 1, NOW(), NOW());

-- Spatie media-library rows: a product image (collection images) and a shop logo (collection logo)
INSERT INTO `media`
  (`id`, `model_type`, `model_id`, `uuid`, `collection_name`, `name`, `file_name`, `mime_type`, `disk`, `size`,
   `manipulations`, `custom_properties`, `generated_conversions`, `responsive_images`, `order_column`, `created_at`, `updated_at`)
VALUES
  (1, 'App\\Models\\Product', 101, '11111111-1111-4111-8111-111111111111', 'images', 'filter', 'filter.jpg', 'image/jpeg', 'public', 1024,
   '[]', '[]', '[]', '[]', 1, NOW(), NOW()),
  (2, 'App\\Models\\Shop', 1, '22222222-2222-4222-8222-222222222222', 'logo', 'riyadh-logo', 'riyadh-logo.png', 'image/png', 'public', 2048,
   '[]', '[]', '[]', '[]', 1, NOW(), NOW());

-- registered devices: one customer-app device for customer 1, one seller-app device for seller 1
INSERT INTO `device_tokens`
  (`id`, `tokenable_type`, `tokenable_id`, `token`, `token_hash`, `platform`, `app`, `created_at`, `updated_at`)
VALUES
  (1, 'App\\Models\\Customer', 1, 'fcm-token-customer-1', SHA2('fcm-token-customer-1', 256), 'android', 'customer', NOW(), NOW()),
  (2, 'App\\Models\\Seller', 1, 'fcm-token-seller-1', SHA2('fcm-token-seller-1', 256), 'ios', 'seller', NOW(), NOW());

INSERT INTO `currencies` (`code`, `exchange_rate`) VALUES ('SAR', 1.000000), ('USD', 0.266667);
