import * as Joi from 'joi';

/** A string that may be absent or empty: an empty value is accepted, never a boot failure. */
const optionalString = Joi.string().optional().allow('');
const identifier = Joi.string().pattern(/^[A-Za-z0-9_]+$/);
const positiveInt = (fallback: number) =>
  Joi.number().integer().min(1).default(fallback);

/**
 * Every environment variable the service reads, validated at boot (constitution IV). Defaults are
 * the values in the spec (FR-070). Every optional string uses `.optional().allow('')`: a present
 * but empty value would otherwise fail validation and crash-loop the container (the Ciro deploy
 * gotcha, quickstart.md section 3).
 *
 * Settings that protect a spec deadline carry a maximum, so a configuration change cannot quietly
 * break it: the session cache (FR-005) and the account sync (FR-009, FR-014).
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),
  CORS_ORIGINS: optionalString,
  WORKER_ROLE: Joi.string().valid('api', 'worker', 'all').default('all'),
  MONGODB_URI: Joi.string().required(),
  REDIS_URL: Joi.string().default('redis://localhost:6379'),

  // China Parts database: read-only, column-level grants (research R3).
  CHINAPARTS_MYSQL_HOST: Joi.string().required(),
  CHINAPARTS_MYSQL_PORT: Joi.number().port().default(3306),
  CHINAPARTS_MYSQL_DATABASE: Joi.string().required(),
  CHINAPARTS_MYSQL_USER: Joi.string().required(),
  CHINAPARTS_MYSQL_PASSWORD: Joi.string().required(),
  CHINAPARTS_MYSQL_SSL: Joi.boolean().default(false),

  // Value mappings for China Parts data (contracts/chinaparts-read-model.md).
  CHINAPARTS_CUSTOMER_TYPES: optionalString,
  CHINAPARTS_SELLER_TYPES: optionalString,
  CHINAPARTS_PRODUCT_TYPES: optionalString,
  CHINAPARTS_SHOP_TYPES: optionalString,
  CHINAPARTS_SELLER_APPROVED_VALUES: optionalString,
  CHINAPARTS_TOKEN_EXPIRATION_MINUTES: Joi.number()
    .positive()
    .optional()
    .allow(''),
  CHINAPARTS_PRODUCT_IMAGE_COLLECTION: optionalString,
  CHINAPARTS_SHOP_IMAGE_COLLECTION: optionalString,
  CHINAPARTS_SELLER_IMAGE_COLLECTION: optionalString,
  CHINAPARTS_MEDIA_URL_TEMPLATE: optionalString,
  CHINAPARTS_DISK_URLS: optionalString,
  CHINAPARTS_PUBLIC_STORAGE_URL: optionalString,
  CHINAPARTS_BASE_CURRENCY: Joi.string().length(3).default('SAR'),
  // A table or column name cannot be a query parameter, so it is validated here (R11).
  CHINAPARTS_FX_TABLE: identifier.default('currencies'),
  CHINAPARTS_FX_CODE_COLUMN: identifier.default('code'),
  CHINAPARTS_FX_RATE_COLUMN: identifier.default('exchange_rate'),
  CHINAPARTS_FX_RATE_DIRECTION: Joi.string()
    .valid('per_base', 'to_base')
    .default('per_base'),

  // Object storage in Saudi Arabia (research R12, R17).
  STORAGE_DRIVER: Joi.string().valid('s3', 'local').default('s3'),
  STORAGE_LOCAL_DIR: optionalString,
  S3_ENDPOINT: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  S3_SECRET_ACCESS_KEY: Joi.string().when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  S3_PRESIGN_ENDPOINT: optionalString,
  S3_PRIVATE_BUCKET: Joi.string().required(),
  S3_PUBLIC_BUCKET: Joi.string().required(),
  MEDIA_PUBLIC_BASE_URL: Joi.string().required(),

  // Screening and push.
  MODERATION_PROVIDER: Joi.string()
    .valid('stub', 'sightengine')
    .default('stub'),
  SIGHTENGINE_API_USER: Joi.string().when('MODERATION_PROVIDER', {
    is: 'sightengine',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  SIGHTENGINE_API_SECRET: Joi.string().when('MODERATION_PROVIDER', {
    is: 'sightengine',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  FCM_CUSTOMER_CREDENTIALS_JSON: optionalString,
  FCM_SELLER_CREDENTIALS_JSON: optionalString,
  // Empty locks the operator surface for everyone: it fails closed (FR-059).
  ADMIN_API_KEY: optionalString,

  // Limits (FR-070, research R24). Defaults are the spec's values.
  REEL_MAX_VIDEO_BYTES: positiveInt(104_857_600),
  REEL_MAX_DURATION_SECONDS: positiveInt(60),
  REEL_MAX_DESCRIPTION_LENGTH: positiveInt(2200),
  REEL_COMMENT_MAX_LENGTH: positiveInt(500),
  REEL_REPORT_REASON_MAX_LENGTH: positiveInt(500),
  FEED_PAGE_SIZE_DEFAULT: positiveInt(10),
  FEED_PAGE_SIZE_MAX: positiveInt(25),
  COMMENTS_PAGE_SIZE_DEFAULT: positiveInt(20),
  COMMENTS_PAGE_SIZE_MAX: positiveInt(50),
  // The stored ceiling is 5 links per reel (data-model.md), so the setting can lower it, not raise it.
  REEL_MAX_PRODUCTS: Joi.number().integer().min(1).max(5).default(5),
  REEL_REPORT_DAILY_LIMIT: positiveInt(20),
  REEL_REPORT_AUTOHIDE_THRESHOLD: positiveInt(25),

  // Rate limits (research R10).
  IP_RATE_LIMIT_PER_MINUTE: positiveInt(1200),
  USER_RATE_LIMIT_PER_MINUTE: positiveInt(300),
  GUEST_RATE_LIMIT_PER_MINUTE: positiveInt(120),
  UPLOAD_RATE_LIMIT_PER_HOUR: positiveInt(20),
  WRITE_RATE_LIMIT_PER_MINUTE: positiveInt(30),

  // Sync and caches (research R4, R7, R11), with deadlines they must not exceed.
  AUTH_CACHE_TTL_SECONDS: Joi.number().integer().min(1).max(300).default(60),
  ACCOUNT_SYNC_INTERVAL_MINUTES: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(5),
  SYNC_MAX_MISSING_RATIO: Joi.number().min(0).max(1).default(0.01),
  PRODUCT_CARD_CACHE_SECONDS: positiveInt(60),
  FX_CACHE_SECONDS: positiveInt(300),

  // Reel links (research R15).
  LINKS_PUBLIC_BASE_URL: Joi.string().default('http://localhost:3000'),
  LINKS_PAGE_TITLE: Joi.string().default('China Parts Reels'),
  IOS_TEAM_ID: optionalString,
  IOS_BUNDLE_ID: optionalString,
  ANDROID_PACKAGE_NAME: optionalString,
  ANDROID_CERT_FINGERPRINTS: optionalString,
  IOS_STORE_URL: Joi.string().default(
    'https://apps.apple.com/app/id0000000000',
  ),
  ANDROID_STORE_URL: Joi.string().default(
    'https://play.google.com/store/apps/details?id=placeholder',
  ),

  // Demo content: development and test only (FR-071). Refused when NODE_ENV=production.
  SEED_DEMO_CONTENT: Joi.boolean()
    .default(false)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.boolean().valid(false),
    }),
  SEED_SELLER_EXTERNAL_IDS: optionalString,
  SEED_CUSTOMER_EXTERNAL_IDS: optionalString,
});
