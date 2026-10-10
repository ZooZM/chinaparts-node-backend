import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageDriver, StoredObjectInfo } from '../storage.service';

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

/**
 * S3-compatible storage hosted in Saudi Arabia (research R12, R17): Google Cloud Storage through
 * its S3 API, or MinIO on an in-Kingdom VPS. `presignClient` may point at a different, publicly
 * reachable endpoint than `client`, which matters when the API reaches storage over an internal
 * address (docker-compose) but phones must be handed a link they can open.
 */
export class S3StorageDriver implements StorageDriver {
  constructor(
    private readonly client: S3Client,
    private readonly presignClient: S3Client = client,
  ) {}

  async putFile(
    bucket: string,
    key: string,
    filePath: string,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    const { size } = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }

  async copy(
    fromBucket: string,
    toBucket: string,
    key: string,
    cacheControl?: string,
  ): Promise<void> {
    const source = await this.head(fromBucket, key);
    if (!source) throw new Error(`Object ${fromBucket}/${key} not found`);
    // REPLACE is the only way to set Cache-Control on a copy, and it drops the content type
    // unless it is passed again.
    await this.client.send(
      new CopyObjectCommand({
        Bucket: toBucket,
        Key: key,
        CopySource: `${fromBucket}/${encodeKey(key)}`,
        MetadataDirective: 'REPLACE',
        ContentType: source.contentType,
        CacheControl: cacheControl,
      }),
    );
  }

  async delete(bucket: string, key: string): Promise<void> {
    // S3 reports success for a missing key, so this is idempotent without a pre-check.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  async head(bucket: string, key: string): Promise<StoredObjectInfo | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return {
        contentType: response.ContentType,
        cacheControl: response.CacheControl,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async downloadToTemp(bucket: string, key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!(response.Body instanceof Readable)) {
      throw new Error(`Object ${bucket}/${key} has no readable body`);
    }
    const dir = await mkdtemp(join(tmpdir(), 'reels-dl-'));
    const target = join(dir, basename(key));
    await pipeline(response.Body, createWriteStream(target));
    return target;
  }

  presignGet(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}
