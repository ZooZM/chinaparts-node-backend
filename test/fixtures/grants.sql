-- Local and test grants for the reels service. Mirrors the grant script in
-- specs/002-chinaparts-reels-service/contracts/chinaparts-read-model.md (<db> = chinaparts_dev,
-- <host> = '%'), without REQUIRE SSL because there is no TLS locally. Idempotent on purpose.
USE `chinaparts_dev`;

DROP USER IF EXISTS 'reels_ro'@'%';
CREATE USER 'reels_ro'@'%' IDENTIFIED BY 'reels_ro_local';

GRANT SELECT (id, tokenable_type, tokenable_id, token, expires_at, created_at)
  ON chinaparts_dev.personal_access_tokens TO 'reels_ro'@'%';
GRANT SELECT (id, first_name, last_name, image, status, preferred_currency)
  ON chinaparts_dev.customers TO 'reels_ro'@'%';
GRANT SELECT (id, first_name, last_name, status, preferred_currency)
  ON chinaparts_dev.sellers TO 'reels_ro'@'%';
GRANT SELECT (id, seller_id, name)
  ON chinaparts_dev.shops TO 'reels_ro'@'%';
GRANT SELECT (id, seller_id, name, slug, status, stock_quantity, discount_percentage, deleted_at)
  ON chinaparts_dev.products TO 'reels_ro'@'%';
GRANT SELECT (id, product_id, selling_price, is_default, status)
  ON chinaparts_dev.product_variants TO 'reels_ro'@'%';
GRANT SELECT (id, model_type, model_id, uuid, collection_name, file_name, disk, order_column)
  ON chinaparts_dev.media TO 'reels_ro'@'%';
GRANT SELECT (tokenable_type, tokenable_id, token, platform, app)
  ON chinaparts_dev.device_tokens TO 'reels_ro'@'%';
GRANT SELECT (code, exchange_rate)
  ON chinaparts_dev.currencies TO 'reels_ro'@'%';

-- Used only by the SC-006 read-only proof (CHECKSUM TABLE before and after a full run).
DROP USER IF EXISTS 'reels_audit'@'%';
CREATE USER 'reels_audit'@'%' IDENTIFIED BY 'reels_audit_local';
GRANT SELECT ON chinaparts_dev.* TO 'reels_audit'@'%';

FLUSH PRIVILEGES;
