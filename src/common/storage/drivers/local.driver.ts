import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { StorageDriver, StoredObjectInfo } from '../storage.service';

/**
 * Local-disk storage for tests and offline development only: `<root>/<bucket>/<key>`.
 * Content type and cache control live in a parallel `.meta` tree so the object tree holds
 * only objects. `presignGet` returns a `file://` URL, which is enough to see that an owner
 * would get a private link, but nothing serves it over HTTP.
 */
export class LocalStorageDriver implements StorageDriver {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async putFile(
    bucket: string,
    key: string,
    filePath: string,
    contentType: string,
    cacheControl?: string,
  ): Promise<void> {
    const target = this.objectPath(bucket, key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(filePath, target);
    await this.writeMeta(bucket, key, { contentType, cacheControl });
  }

  async copy(
    fromBucket: string,
    toBucket: string,
    key: string,
    cacheControl?: string,
  ): Promise<void> {
    const source = this.objectPath(fromBucket, key);
    const info = await this.head(fromBucket, key);
    if (!info) throw new Error(`Object ${fromBucket}/${key} not found`);
    const target = this.objectPath(toBucket, key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await this.writeMeta(toBucket, key, {
      contentType: info.contentType,
      cacheControl,
    });
  }

  async delete(bucket: string, key: string): Promise<void> {
    await rm(this.objectPath(bucket, key), { force: true });
    await rm(this.metaPath(bucket, key), { force: true });
  }

  async head(bucket: string, key: string): Promise<StoredObjectInfo | null> {
    try {
      await stat(this.objectPath(bucket, key));
    } catch {
      return null;
    }
    try {
      return JSON.parse(
        await readFile(this.metaPath(bucket, key), 'utf8'),
      ) as StoredObjectInfo;
    } catch {
      return {};
    }
  }

  async downloadToTemp(bucket: string, key: string): Promise<string> {
    const source = this.objectPath(bucket, key);
    await stat(source); // throws ENOENT for a missing object, like a failed GET
    const dir = await mkdtemp(join(tmpdir(), 'reels-dl-'));
    const target = join(dir, basename(key));
    await copyFile(source, target);
    return target;
  }

  presignGet(bucket: string, key: string): Promise<string> {
    return Promise.resolve(`file://${this.objectPath(bucket, key)}`);
  }

  private objectPath(bucket: string, key: string): string {
    return this.safeJoin(join(this.root, bucket), key);
  }

  private metaPath(bucket: string, key: string): string {
    return `${this.safeJoin(join(this.root, '.meta', bucket), key)}.json`;
  }

  /** Keys come from our own code, but a key must never be able to climb out of its bucket. */
  private safeJoin(base: string, key: string): string {
    const full = resolve(base, key);
    if (!full.startsWith(`${base}/`)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return full;
  }

  private async writeMeta(
    bucket: string,
    key: string,
    info: StoredObjectInfo,
  ): Promise<void> {
    const path = this.metaPath(bucket, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(info));
  }
}
