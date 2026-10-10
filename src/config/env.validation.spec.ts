import type * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

const minimal = {
  MONGODB_URI: 'mongodb://localhost/reels',
  CHINAPARTS_MYSQL_HOST: 'localhost',
  CHINAPARTS_MYSQL_DATABASE: 'chinaparts_dev',
  CHINAPARTS_MYSQL_USER: 'reels_ro',
  CHINAPARTS_MYSQL_PASSWORD: 'secret',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'minio',
  S3_SECRET_ACCESS_KEY: 'minio123',
  S3_PRIVATE_BUCKET: 'reels-private',
  S3_PUBLIC_BUCKET: 'reels-public',
  MEDIA_PUBLIC_BASE_URL: 'http://localhost:9000/reels-public',
};

function validate(env: Record<string, unknown>): {
  error: Joi.ValidationError | undefined;
  value: Record<string, unknown>;
} {
  const result = envValidationSchema.validate(env, { abortEarly: false });
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
}

describe('environment schema (constitution IV)', () => {
  it('accepts the minimal environment and fills in every default from the spec (FR-070)', () => {
    const { error, value } = validate(minimal);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      NODE_ENV: 'development',
      WORKER_ROLE: 'all',
      REEL_MAX_VIDEO_BYTES: 104_857_600,
      REEL_MAX_DURATION_SECONDS: 60,
      REEL_MAX_DESCRIPTION_LENGTH: 2200,
      REEL_COMMENT_MAX_LENGTH: 500,
      REEL_REPORT_REASON_MAX_LENGTH: 500,
      FEED_PAGE_SIZE_DEFAULT: 10,
      FEED_PAGE_SIZE_MAX: 25,
      COMMENTS_PAGE_SIZE_DEFAULT: 20,
      COMMENTS_PAGE_SIZE_MAX: 50,
      REEL_MAX_PRODUCTS: 5,
      REEL_REPORT_DAILY_LIMIT: 20,
      REEL_REPORT_AUTOHIDE_THRESHOLD: 25,
      GUEST_RATE_LIMIT_PER_MINUTE: 120,
      AUTH_CACHE_TTL_SECONDS: 60,
      ACCOUNT_SYNC_INTERVAL_MINUTES: 5,
      SEED_DEMO_CONTENT: false,
    });
  });

  it('converts numbers and booleans from strings, as environment variables are', () => {
    const { value } = validate({
      ...minimal,
      REEL_MAX_DURATION_SECONDS: '45',
      CHINAPARTS_MYSQL_SSL: 'true',
      CHINAPARTS_MYSQL_PORT: '3307',
    });
    expect(value).toMatchObject({
      REEL_MAX_DURATION_SECONDS: 45,
      CHINAPARTS_MYSQL_SSL: true,
      CHINAPARTS_MYSQL_PORT: 3307,
    });
  });

  it.each([
    'MONGODB_URI',
    'CHINAPARTS_MYSQL_HOST',
    'CHINAPARTS_MYSQL_PASSWORD',
    'S3_PRIVATE_BUCKET',
    'MEDIA_PUBLIC_BASE_URL',
  ])('refuses a missing %s', (key) => {
    const env: Record<string, unknown> = { ...minimal };
    delete env[key];
    expect(validate(env).error?.message).toContain(key);
  });

  it('reports every problem at once, not just the first', () => {
    const { error } = validate({});
    expect(error?.details.length).toBeGreaterThan(5);
  });

  describe('optional strings accept an empty value (the Ciro deploy gotcha)', () => {
    it.each([
      'CORS_ORIGINS',
      'ADMIN_API_KEY',
      'SIGHTENGINE_API_USER',
      'SIGHTENGINE_API_SECRET',
      'FCM_CUSTOMER_CREDENTIALS_JSON',
      'FCM_SELLER_CREDENTIALS_JSON',
      'IOS_TEAM_ID',
      'IOS_BUNDLE_ID',
      'ANDROID_PACKAGE_NAME',
      'ANDROID_CERT_FINGERPRINTS',
      'CHINAPARTS_CUSTOMER_TYPES',
      'CHINAPARTS_DISK_URLS',
      'CHINAPARTS_TOKEN_EXPIRATION_MINUTES',
      'S3_PRESIGN_ENDPOINT',
      'STORAGE_LOCAL_DIR',
      'SEED_SELLER_EXTERNAL_IDS',
    ])('%s', (key) => {
      expect(validate({ ...minimal, [key]: '' }).error).toBeUndefined();
    });
  });

  describe('storage', () => {
    it('requires the S3 settings for the s3 driver', () => {
      const env: Record<string, unknown> = { ...minimal };
      delete env.S3_ENDPOINT;
      delete env.S3_ACCESS_KEY_ID;
      const message = validate(env).error?.message ?? '';
      expect(message).toContain('S3_ENDPOINT');
      expect(message).toContain('S3_ACCESS_KEY_ID');
    });

    it('does not need them for the local driver', () => {
      const env: Record<string, unknown> = {
        ...minimal,
        STORAGE_DRIVER: 'local',
      };
      delete env.S3_ENDPOINT;
      delete env.S3_ACCESS_KEY_ID;
      delete env.S3_SECRET_ACCESS_KEY;
      expect(validate(env).error).toBeUndefined();
    });

    it('refuses an unknown driver', () => {
      expect(
        validate({ ...minimal, STORAGE_DRIVER: 'ftp' }).error,
      ).toBeDefined();
    });
  });

  describe('screening provider', () => {
    it('needs no credentials for the stub', () => {
      expect(
        validate({ ...minimal, MODERATION_PROVIDER: 'stub' }).error,
      ).toBeUndefined();
    });

    it('requires Sightengine credentials at boot rather than failing at the first upload', () => {
      const message =
        validate({ ...minimal, MODERATION_PROVIDER: 'sightengine' }).error
          ?.message ?? '';
      expect(message).toContain('SIGHTENGINE_API_USER');
      expect(message).toContain('SIGHTENGINE_API_SECRET');
    });

    it('accepts them when present', () => {
      expect(
        validate({
          ...minimal,
          MODERATION_PROVIDER: 'sightengine',
          SIGHTENGINE_API_USER: 'u',
          SIGHTENGINE_API_SECRET: 's',
        }).error,
      ).toBeUndefined();
    });
  });

  describe('deadlines the settings must not break', () => {
    it('caps the session cache at 5 minutes (FR-005)', () => {
      expect(
        validate({ ...minimal, AUTH_CACHE_TTL_SECONDS: 300 }).error,
      ).toBeUndefined();
      expect(
        validate({ ...minimal, AUTH_CACHE_TTL_SECONDS: 301 }).error,
      ).toBeDefined();
      expect(
        validate({ ...minimal, AUTH_CACHE_TTL_SECONDS: 0 }).error,
      ).toBeDefined();
    });

    it('caps the account sync at 10 minutes (FR-009, FR-014)', () => {
      expect(
        validate({ ...minimal, ACCOUNT_SYNC_INTERVAL_MINUTES: 10 }).error,
      ).toBeUndefined();
      expect(
        validate({ ...minimal, ACCOUNT_SYNC_INTERVAL_MINUTES: 11 }).error,
      ).toBeDefined();
    });

    it('keeps the mass-miss breaker a ratio', () => {
      expect(
        validate({ ...minimal, SYNC_MAX_MISSING_RATIO: 1 }).error,
      ).toBeUndefined();
      expect(
        validate({ ...minimal, SYNC_MAX_MISSING_RATIO: 1.5 }).error,
      ).toBeDefined();
      expect(
        validate({ ...minimal, SYNC_MAX_MISSING_RATIO: -0.1 }).error,
      ).toBeDefined();
    });
  });

  describe('demo content (FR-071)', () => {
    it('may be enabled outside production', () => {
      for (const NODE_ENV of ['development', 'test']) {
        expect(
          validate({ ...minimal, NODE_ENV, SEED_DEMO_CONTENT: 'true' }).error,
        ).toBeUndefined();
      }
    });

    it('is refused when NODE_ENV is production', () => {
      const { error } = validate({
        ...minimal,
        NODE_ENV: 'production',
        SEED_DEMO_CONTENT: 'true',
      });
      expect(error?.message).toContain('SEED_DEMO_CONTENT');
    });

    it('may stay off in production', () => {
      expect(
        validate({ ...minimal, NODE_ENV: 'production' }).error,
      ).toBeUndefined();
    });
  });

  describe('exchange-rate identifiers cannot carry SQL (R11)', () => {
    it.each([
      ['CHINAPARTS_FX_TABLE', 'currencies; DROP TABLE x'],
      ['CHINAPARTS_FX_CODE_COLUMN', 'code`'],
      ['CHINAPARTS_FX_RATE_COLUMN', 'rate, password'],
    ])('%s = %s is refused', (key, value) => {
      expect(validate({ ...minimal, [key]: value }).error).toBeDefined();
    });

    it('accepts plain identifiers', () => {
      expect(
        validate({ ...minimal, CHINAPARTS_FX_TABLE: 'fx_rates_2' }).error,
      ).toBeUndefined();
    });
  });

  it('refuses nonsense for the worker role', () => {
    expect(validate({ ...minimal, WORKER_ROLE: 'boss' }).error).toBeDefined();
    for (const WORKER_ROLE of ['api', 'worker', 'all']) {
      expect(validate({ ...minimal, WORKER_ROLE }).error).toBeUndefined();
    }
  });

  it('refuses a limit of zero or below, which would silently disable a feature', () => {
    expect(validate({ ...minimal, REEL_MAX_PRODUCTS: 0 }).error).toBeDefined();
    expect(
      validate({ ...minimal, FEED_PAGE_SIZE_MAX: -5 }).error,
    ).toBeDefined();
  });
});
