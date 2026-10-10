import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** What a stored object says about itself. Enough to prove how it will be served. */
export interface StoredObjectInfo {
  contentType?: string;
  cacheControl?: string;
}

/**
 * The few operations the service needs from object storage (research R12). Implemented by an
 * S3-compatible driver for real deployments and a local-disk driver for tests and offline
 * development. Callers never see which one is in use.
 */
export interface StorageDriver {
  putFile(
    bucket: string,
    key: string,
    filePath: string,
    contentType: string,
    cacheControl?: string,
  ): Promise<void>;
  /** Server-side copy that keeps the content type and sets `cacheControl` when given. */
  copy(
    fromBucket: string,
    toBucket: string,
    key: string,
    cacheControl?: string,
  ): Promise<void>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(bucket: string, key: string): Promise<void>;
  /** Returns null when the object does not exist. */
  head(bucket: string, key: string): Promise<StoredObjectInfo | null>;
  /** Downloads to a fresh temp file and returns its path. The caller deletes it. */
  downloadToTemp(bucket: string, key: string): Promise<string>;
  presignGet(bucket: string, key: string, ttlSeconds: number): Promise<string>;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

/**
 * Public objects may be cached by phones and proxies for at most 5 minutes, so a link that is
 * taken down (a reel hidden, or its creator suspended) stops working well inside the 15 minutes
 * FR-009 allows (research R12).
 */
export const PUBLIC_CACHE_CONTROL = 'public, max-age=300';

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly config: ConfigService,
  ) {}

  /** Pending, rejected and hidden media, and the media of accounts out of good standing. */
  get privateBucket(): string {
    return this.requireString('S3_PRIVATE_BUCKET');
  }

  /** Published media only, served anonymously. */
  get publicBucket(): string {
    return this.requireString('S3_PUBLIC_BUCKET');
  }

  putFile(
    bucket: string,
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    return this.driver.putFile(
      bucket,
      key,
      filePath,
      contentType,
      this.cacheControlFor(bucket),
    );
  }

  copy(fromBucket: string, toBucket: string, key: string): Promise<void> {
    return this.driver.copy(
      fromBucket,
      toBucket,
      key,
      this.cacheControlFor(toBucket),
    );
  }

  delete(bucket: string, key: string): Promise<void> {
    return this.driver.delete(bucket, key);
  }

  head(bucket: string, key: string): Promise<StoredObjectInfo | null> {
    return this.driver.head(bucket, key);
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    return (await this.driver.head(bucket, key)) !== null;
  }

  downloadToTemp(bucket: string, key: string): Promise<string> {
    return this.driver.downloadToTemp(bucket, key);
  }

  presignGet(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    return this.driver.presignGet(bucket, key, ttlSeconds);
  }

  /** The anonymous address of an object in the public bucket. */
  publicUrl(key: string): string {
    const base = this.requireString('MEDIA_PUBLIC_BASE_URL').replace(
      /\/+$/,
      '',
    );
    return `${base}/${encodeKey(key)}`;
  }

  private cacheControlFor(bucket: string): string | undefined {
    return bucket === this.publicBucket ? PUBLIC_CACHE_CONTROL : undefined;
  }

  private requireString(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new Error(`Configuration value ${key} is missing`);
    return value;
  }
}
