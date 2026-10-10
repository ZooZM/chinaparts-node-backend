import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageDriver } from './drivers/local.driver';
import { PUBLIC_CACHE_CONTROL, StorageService } from './storage.service';

const CONFIG: Record<string, string> = {
  S3_PRIVATE_BUCKET: 'reels-private',
  S3_PUBLIC_BUCKET: 'reels-public',
  MEDIA_PUBLIC_BASE_URL: 'https://media.reels.example.sa/reels-public/',
};

describe('StorageService with the local driver', () => {
  let root: string;
  let workDir: string;
  let storage: StorageService;
  let source: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'storage-spec-root-'));
    workDir = await mkdtemp(join(tmpdir(), 'storage-spec-work-'));
    source = join(workDir, 'video.mp4');
    await writeFile(source, 'not really a video');
    storage = new StorageService(new LocalStorageDriver(root), {
      get: (key: string) => CONFIG[key],
    } as unknown as ConfigService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it('exposes the two buckets from configuration', () => {
    expect(storage.privateBucket).toBe('reels-private');
    expect(storage.publicBucket).toBe('reels-public');
  });

  it('stores a file and reports it, with its content type', async () => {
    await storage.putFile(
      storage.privateBucket,
      'reels/abc/video.mp4',
      source,
      'video/mp4',
    );

    expect(
      await storage.exists(storage.privateBucket, 'reels/abc/video.mp4'),
    ).toBe(true);
    expect(
      await storage.head(storage.privateBucket, 'reels/abc/video.mp4'),
    ).toEqual({ contentType: 'video/mp4', cacheControl: undefined });
  });

  it('reports a missing object as absent', async () => {
    expect(
      await storage.exists(storage.privateBucket, 'reels/none/video.mp4'),
    ).toBe(false);
    expect(
      await storage.head(storage.privateBucket, 'reels/none/video.mp4'),
    ).toBeNull();
  });

  it('gives only the public bucket a short cache lifetime (FR-009)', async () => {
    await storage.putFile(
      storage.privateBucket,
      'k/video.mp4',
      source,
      'video/mp4',
    );
    await storage.putFile(
      storage.publicBucket,
      'k/video.mp4',
      source,
      'video/mp4',
    );

    expect(
      (await storage.head(storage.privateBucket, 'k/video.mp4'))?.cacheControl,
    ).toBeUndefined();
    expect(
      (await storage.head(storage.publicBucket, 'k/video.mp4'))?.cacheControl,
    ).toBe(PUBLIC_CACHE_CONTROL);
    expect(PUBLIC_CACHE_CONTROL).toBe('public, max-age=300');
  });

  it('copies private to public, keeping the content type and adding the cache lifetime', async () => {
    await storage.putFile(
      storage.privateBucket,
      'r/1/video.mp4',
      source,
      'video/mp4',
    );
    await storage.copy(
      storage.privateBucket,
      storage.publicBucket,
      'r/1/video.mp4',
    );

    expect(await storage.head(storage.publicBucket, 'r/1/video.mp4')).toEqual({
      contentType: 'video/mp4',
      cacheControl: PUBLIC_CACHE_CONTROL,
    });
    // The private original stays: media moves between buckets without being lost (R12).
    expect(await storage.exists(storage.privateBucket, 'r/1/video.mp4')).toBe(
      true,
    );
  });

  it('refuses to copy an object that does not exist', async () => {
    await expect(
      storage.copy(storage.privateBucket, storage.publicBucket, 'nope.mp4'),
    ).rejects.toThrow(/not found/);
  });

  it('deletes idempotently', async () => {
    await storage.putFile(
      storage.publicBucket,
      'r/2/thumb.jpg',
      source,
      'image/jpeg',
    );
    await storage.delete(storage.publicBucket, 'r/2/thumb.jpg');
    await storage.delete(storage.publicBucket, 'r/2/thumb.jpg');

    expect(await storage.exists(storage.publicBucket, 'r/2/thumb.jpg')).toBe(
      false,
    );
  });

  it('downloads to a temp file with the same bytes', async () => {
    await storage.putFile(
      storage.privateBucket,
      'r/3/video.mp4',
      source,
      'video/mp4',
    );

    const path = await storage.downloadToTemp(
      storage.privateBucket,
      'r/3/video.mp4',
    );

    expect(path).not.toContain(root);
    expect(await readFile(path, 'utf8')).toBe('not really a video');
    await rm(path, { force: true });
  });

  it('fails to download a missing object', async () => {
    await expect(
      storage.downloadToTemp(storage.privateBucket, 'missing.mp4'),
    ).rejects.toThrow();
  });

  it('builds public URLs from the configured base, without doubling slashes', () => {
    expect(storage.publicUrl('reels/abc/video.mp4')).toBe(
      'https://media.reels.example.sa/reels-public/reels/abc/video.mp4',
    );
  });

  it('encodes each path segment of a public URL', () => {
    expect(storage.publicUrl('reels/a b/vid#1.mp4')).toBe(
      'https://media.reels.example.sa/reels-public/reels/a%20b/vid%231.mp4',
    );
  });

  it('hands out a private link for an owner preview', async () => {
    const url = await storage.presignGet(
      storage.privateBucket,
      'r/4/video.mp4',
      900,
    );
    expect(url.startsWith('file://')).toBe(true);
    expect(url).toContain('reels-private');
  });

  it('never lets a key climb out of its bucket', async () => {
    await expect(
      storage.putFile(
        storage.privateBucket,
        '../escape.mp4',
        source,
        'video/mp4',
      ),
    ).rejects.toThrow(/Invalid storage key/);
  });
});

describe('StorageService configuration', () => {
  it('fails loudly when a bucket or the public base URL is missing', () => {
    const storage = new StorageService(new LocalStorageDriver(tmpdir()), {
      get: () => undefined,
    } as unknown as ConfigService);
    expect(() => storage.privateBucket).toThrow(/S3_PRIVATE_BUCKET/);
    expect(() => storage.publicBucket).toThrow(/S3_PUBLIC_BUCKET/);
    expect(() => storage.publicUrl('k')).toThrow(/MEDIA_PUBLIC_BASE_URL/);
  });
});
