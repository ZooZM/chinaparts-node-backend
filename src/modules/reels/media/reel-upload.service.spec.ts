import { BadRequestException, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LimitsService } from '../../../common/config/limits';
import type { AuthenticatedUser } from '../../../common/http/viewer-request';
import { StorageService } from '../../../common/storage/storage.service';
import { AccountsService } from '../../accounts/accounts.service';
import { ReelPresenter } from '../presentation/reel-presenter.service';
import type { ProductLinksService } from '../products/product-links.service';
import type { ReelDto, ReelRecord, ReelsRepository } from '../reels.repository';
import { ReelUploadService } from './reel-upload.service';

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'media',
);
const SAMPLE_10S = join(FIXTURES, 'sample-10s.mp4');
const SAMPLE_70S = join(FIXTURES, 'sample-70s.mp4');

const seller: AuthenticatedUser = {
  userId: '650000000000000000000001',
  accountType: 'seller',
  externalId: 1,
  standing: 'good',
  locale: 'ar',
  preferredCurrency: null,
};

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the upload to fail');
    },
    (error: unknown) => error,
  );
}

describe('ReelUploadService (FR-025 to FR-033)', () => {
  let workDir: string;
  const reelRecord = (id: string): ReelRecord => ({ id }) as ReelRecord;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'upload-spec-'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  /** A file as Multer leaves it: on disk, in a temp directory the service must clean up. */
  async function staged(source: string, name: string, mimetype: string) {
    const path = join(workDir, name);
    await copyFile(source, path);
    return { path, mimetype };
  }

  function setup(overrides: { maxDurationSeconds?: number } = {}) {
    const stored = new Map<string, string>();
    const storage = {
      privateBucket: 'priv',
      putFile: jest.fn(
        (bucket: string, key: string, _path: string, type: string) => {
          stored.set(`${bucket}/${key}`, type);
          return Promise.resolve();
        },
      ),
      delete: jest.fn((bucket: string, key: string) => {
        stored.delete(`${bucket}/${key}`);
        return Promise.resolve();
      }),
    };
    const reels = {
      createReel: jest.fn((params: { id: string }) =>
        Promise.resolve(reelRecord(params.id)),
      ),
    };
    const accounts = {
      resolveMentions: jest.fn().mockResolvedValue([]),
    };
    const presenter = {
      presentOne: jest.fn((record: ReelRecord) =>
        Promise.resolve({
          id: record.id,
          status: 'pending_moderation',
        } as ReelDto),
      ),
    };
    const productLinks = {
      validateAttachable: jest.fn((_seller: number, ids: number[]) =>
        Promise.resolve([...new Set(ids)]),
      ),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const limits = { maxDurationSeconds: overrides.maxDurationSeconds ?? 60 };

    const service = new ReelUploadService(
      reels as unknown as ReelsRepository,
      storage as unknown as StorageService,
      accounts as unknown as AccountsService,
      limits as LimitsService,
      presenter as unknown as ReelPresenter,
      productLinks as unknown as ProductLinksService,
      queue as unknown as Queue,
    );
    return {
      service,
      storage,
      reels,
      accounts,
      presenter,
      productLinks,
      queue,
      stored,
    };
  }

  it('stores both files in the private bucket, then creates the reel, then queues screening', async () => {
    const { service, storage, reels, queue, stored } = setup();
    const order: string[] = [];
    storage.putFile.mockImplementation((bucket: string, key: string) => {
      order.push(`store ${key.split('/').pop()}`);
      stored.set(`${bucket}/${key}`, 'recorded');
      return Promise.resolve();
    });
    reels.createReel.mockImplementation((params: { id: string }) => {
      order.push('create');
      return Promise.resolve(reelRecord(params.id));
    });
    queue.add.mockImplementation(() => {
      order.push('queue');
      return Promise.resolve();
    });

    const result = await service.upload(
      seller,
      { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
      { description: 'hi' },
    );

    expect(order).toEqual([
      'store video.mp4',
      'store thumb.jpg',
      'create',
      'queue',
    ]);
    expect(result.status).toBe('pending_moderation');
    // Exactly the two files, and only in the private bucket: nothing is public until screening.
    expect([...stored.keys()].sort()).toEqual([
      expect.stringMatching(/^priv\/reels\/[0-9a-f]{24}\/thumb\.jpg$/),
      expect.stringMatching(/^priv\/reels\/[0-9a-f]{24}\/video\.mp4$/),
    ]);
  });

  describe('products (FR-035)', () => {
    it('checks them for the seller before anything is stored, and links them in the order given', async () => {
      const { service, storage, reels, productLinks } = setup();
      const order: string[] = [];
      productLinks.validateAttachable.mockImplementation(
        (_seller: number, ids: number[]) => {
          order.push('validate');
          return Promise.resolve(ids);
        },
      );
      storage.putFile.mockImplementation(() => {
        order.push('store');
        return Promise.resolve();
      });

      await service.upload(
        seller,
        { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
        { productIds: [102, 101] },
      );

      expect(productLinks.validateAttachable).toHaveBeenCalledWith(
        1,
        [102, 101],
      );
      expect(order[0]).toBe('validate');
      expect(reels.createReel).toHaveBeenCalledWith(
        expect.objectContaining({ productIds: [102, 101] }),
      );
    });

    it('refuses the whole upload when a product may not be attached, storing and creating nothing', async () => {
      const { service, storage, reels, productLinks } = setup();
      productLinks.validateAttachable.mockRejectedValue(
        new BadRequestException({ error: 'PRODUCT_NOT_ATTACHABLE' }),
      );
      const video = await staged(SAMPLE_10S, 'v.mp4', 'video/mp4');

      const error = await errorOf(
        service.upload(seller, { video }, { productIds: [201] }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(reels.createReel).not.toHaveBeenCalled();
      // The temp file goes too.
      expect(await readdir(workDir)).toEqual([]);
    });

    it('does not ask China Parts anything when no products are given', async () => {
      const { service, reels, productLinks } = setup();

      await service.upload(
        seller,
        { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
        {},
      );

      expect(productLinks.validateAttachable).not.toHaveBeenCalled();
      expect(reels.createReel).toHaveBeenCalledWith(
        expect.objectContaining({ productIds: [] }),
      );
    });
  });

  it('puts the reel id in the object keys and creates the document with them', async () => {
    const { service, reels } = setup();
    await service.upload(
      seller,
      { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
      {},
    );

    const params = reels.createReel.mock.calls[0][0] as {
      id: string;
      creatorId: string;
      videoKey: string;
      thumbnailKey: string;
    };
    expect(params.creatorId).toBe(seller.userId);
    expect(params.videoKey).toBe(`reels/${params.id}/video.mp4`);
    expect(params.thumbnailKey).toBe(`reels/${params.id}/thumb.jpg`);
  });

  it('queues screening under the reel id so a duplicate enqueue is harmless', async () => {
    const { service, queue, reels } = setup();
    await service.upload(
      seller,
      { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
      {},
    );

    const params = reels.createReel.mock.calls[0][0];
    const [name, data, options] = queue.add.mock.calls[0] as [
      string,
      { reelId: string },
      { jobId: string; attempts: number },
    ];
    expect(name).toBe('moderate');
    expect(data).toEqual({ reelId: params.id });
    expect(options.jobId).toBe(params.id);
    expect(options.attempts).toBe(5);
  });

  it('stores a remuxed MP4 as video/mp4', async () => {
    const { service, stored } = setup();
    await service.upload(
      seller,
      { video: await staged(SAMPLE_10S, 'v.mov', 'video/quicktime') },
      {},
    );
    const entry = [...stored.entries()].find(([key]) =>
      key.endsWith('video.mp4'),
    );
    expect(entry?.[1]).toBe('video/mp4');
  });

  describe('the cover image', () => {
    it('is generated from the video when none is uploaded', async () => {
      const { service, stored } = setup();
      await service.upload(
        seller,
        { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
        {},
      );
      const entry = [...stored.entries()].find(([key]) =>
        key.endsWith('thumb.jpg'),
      );
      expect(entry?.[1]).toBe('image/jpeg');
    });

    it('is the uploaded one when provided, keeping its type', async () => {
      const { service, stored } = setup();
      const cover = join(workDir, 'cover.png');
      await writeFile(cover, 'png bytes');

      await service.upload(
        seller,
        {
          video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4'),
          thumbnail: { path: cover, mimetype: 'image/png' },
        },
        {},
      );

      const entry = [...stored.entries()].find(([key]) =>
        key.endsWith('thumb.png'),
      );
      expect(entry?.[1]).toBe('image/png');
    });
  });

  describe('the description', () => {
    it('is parsed into Arabic and Latin hashtags and resolved mentions', async () => {
      const { service, reels, accounts } = setup();
      accounts.resolveMentions.mockResolvedValue([
        { userId: '650000000000000000000002', username: 'ahmed' },
      ]);

      await service.upload(
        seller,
        { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
        { description: 'فلتر زيت #فلتر_زيت #OilFilter @ahmed' },
      );

      const params = reels.createReel.mock.calls[0][0] as unknown as {
        description: string;
        hashtags: string[];
        hashtagsNormalized: string[];
        mentions: unknown[];
      };
      expect(params.description).toBe('فلتر زيت #فلتر_زيت #OilFilter @ahmed');
      expect(params.hashtags).toEqual(['فلتر_زيت', 'OilFilter']);
      expect(params.hashtagsNormalized).toEqual(['فلتر_زيت', 'oilfilter']);
      expect(params.mentions).toEqual([
        { userId: '650000000000000000000002', username: 'ahmed' },
      ]);
    });

    it('may be empty', async () => {
      const { service, reels } = setup();
      await service.upload(
        seller,
        { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
        {},
      );
      expect(
        (
          reels.createReel.mock.calls[0][0] as unknown as {
            description: string;
          }
        ).description,
      ).toBe('');
    });
  });

  describe('refusals leave nothing behind (FR-033)', () => {
    it('requires a video, with the VIDEO_REQUIRED sentinel', async () => {
      const { service, storage, reels } = setup();
      const cover = join(workDir, 'cover.jpg');
      await writeFile(cover, 'jpg');

      const error = await errorOf(
        service.upload(
          seller,
          { thumbnail: { path: cover, mimetype: 'image/jpeg' } },
          {},
        ),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'VIDEO_REQUIRED',
      });
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(reels.createReel).not.toHaveBeenCalled();
      expect(await readdir(workDir)).toEqual([]);
    });

    it('refuses a video over the limit with VIDEO_TOO_LONG', async () => {
      const { service, storage, reels } = setup();
      const error = await errorOf(
        service.upload(
          seller,
          { video: await staged(SAMPLE_70S, 'long.mp4', 'video/mp4') },
          {},
        ),
      );

      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'VIDEO_TOO_LONG',
      });
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(reels.createReel).not.toHaveBeenCalled();
      expect(await readdir(workDir)).toEqual([]);
    });

    it('follows the configured limit, with one second of tolerance (FR-026, FR-070)', async () => {
      const { service } = setup({ maxDurationSeconds: 9 });
      // 10 seconds against a 9-second limit: inside the tolerance.
      await expect(
        service.upload(
          seller,
          { video: await staged(SAMPLE_10S, 'a.mp4', 'video/mp4') },
          {},
        ),
      ).resolves.toBeDefined();

      const strict = setup({ maxDurationSeconds: 8 });
      const error = await errorOf(
        strict.service.upload(
          seller,
          { video: await staged(SAMPLE_10S, 'b.mp4', 'video/mp4') },
          {},
        ),
      );
      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'VIDEO_TOO_LONG',
      });
    });

    it('refuses a file whose duration cannot be read with VIDEO_DURATION_UNREADABLE', async () => {
      const { service, storage } = setup();
      const bogus = join(workDir, 'bogus.mp4');
      await writeFile(bogus, 'not a video');

      const error = await errorOf(
        service.upload(
          seller,
          { video: { path: bogus, mimetype: 'video/mp4' } },
          {},
        ),
      );

      expect((error as BadRequestException).getResponse()).toMatchObject({
        error: 'VIDEO_DURATION_UNREADABLE',
      });
      expect(storage.putFile).not.toHaveBeenCalled();
      expect(await readdir(workDir)).toEqual([]);
    });
  });

  describe('a storage failure leaves no reel and no files (FR-033)', () => {
    it('when the cover cannot be stored, the video already stored is deleted', async () => {
      const { service, storage, reels, stored } = setup();
      storage.putFile.mockImplementation((bucket: string, key: string) => {
        if (key.endsWith('thumb.jpg'))
          return Promise.reject(new Error('disk full'));
        stored.set(`${bucket}/${key}`, 'x');
        return Promise.resolve();
      });

      await expect(
        service.upload(
          seller,
          { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
          {},
        ),
      ).rejects.toThrow('disk full');

      expect(reels.createReel).not.toHaveBeenCalled();
      expect(stored.size).toBe(0);
      expect(await readdir(workDir)).toEqual([]);
    });

    it('when the very first store fails, nothing is created', async () => {
      const { service, storage, reels, stored } = setup();
      storage.putFile.mockRejectedValue(new Error('storage down'));

      await expect(
        service.upload(
          seller,
          { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
          {},
        ),
      ).rejects.toThrow('storage down');

      expect(reels.createReel).not.toHaveBeenCalled();
      expect(stored.size).toBe(0);
    });

    it('when the reel document cannot be created, both stored files are deleted', async () => {
      const { service, reels, stored, queue } = setup();
      reels.createReel.mockRejectedValue(new Error('mongo down'));

      await expect(
        service.upload(
          seller,
          { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
          {},
        ),
      ).rejects.toThrow('mongo down');

      expect(stored.size).toBe(0);
      expect(queue.add).not.toHaveBeenCalled();
      expect(await readdir(workDir)).toEqual([]);
    });

    it('keeps trying to delete the rest when one delete fails', async () => {
      const { service, storage, reels } = setup();
      reels.createReel.mockRejectedValue(new Error('mongo down'));
      storage.delete.mockRejectedValueOnce(new Error('delete failed'));

      await expect(
        service.upload(
          seller,
          { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
          {},
        ),
      ).rejects.toThrow('mongo down');

      expect(storage.delete).toHaveBeenCalledTimes(2);
    });
  });

  describe('screening is queued, never awaited (FR-029, FR-031)', () => {
    it('still succeeds when the queue is down: the reel stays pending for the sweep', async () => {
      const { service, queue, reels, stored } = setup();
      queue.add.mockRejectedValue(new Error('redis down'));

      const result = await service.upload(
        seller,
        { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
        {},
      );

      expect(result).toBeDefined();
      expect(reels.createReel).toHaveBeenCalledTimes(1);
      expect(stored.size).toBe(2); // the files stay, because the reel exists
    });
  });

  it('returns the reel as its owner sees it', async () => {
    const { service, presenter } = setup();
    await service.upload(
      seller,
      { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
      {},
    );
    expect(presenter.presentOne).toHaveBeenCalledWith(
      expect.objectContaining({}),
      { user: seller },
    );
  });

  it('removes every temp file after a successful upload', async () => {
    const { service } = setup();
    await service.upload(
      seller,
      { video: await staged(SAMPLE_10S, 'v.mp4', 'video/mp4') },
      {},
    );
    expect(await readdir(workDir)).toEqual([]);
  });
});
