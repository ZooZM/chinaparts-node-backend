import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LimitsService } from '../../src/common/config/limits';
import {
  QUEUE_MEDIA_VISIBILITY,
  QUEUE_REELS_MODERATION,
} from '../../src/common/queues/queue-names';
import {
  PUBLIC_CACHE_CONTROL,
  StorageService,
} from '../../src/common/storage/storage.service';
import { ReelsModerationService } from '../../src/modules/reels/reels-moderation.service';
import { NotificationEventType } from '../../src/modules/reels/schemas/notification-event.schema';
import type {
  CreatorProfileDto,
  ReelDto,
} from '../../src/modules/reels/reels.repository';
import { createTestApp, TestApp } from '../utils/app';
import {
  drainQueue,
  eventually,
  notificationEventModel,
  reelModel,
  runSync,
  SAMPLE_10S,
  SAMPLE_70S,
} from '../utils/fixtures';
import { createPerson, Person } from '../utils/people';
import { issueToken } from '../utils/tokens';

/**
 * FR-025 to FR-033 and FR-009: a seller uploads, screening publishes or removes the reel, and its
 * files are public only while it is published and the seller is in good standing. Real MP4 files,
 * real ffmpeg, a real queue and worker, and the local storage driver standing in for the two
 * buckets.
 */
describe('Uploading a reel (e2e)', () => {
  let testApp: TestApp;
  let storage: StorageService;
  let moderationQueue: Queue;

  beforeAll(async () => {
    testApp = await createTestApp();
    storage = testApp.app.get(StorageService);
    moderationQueue = testApp.app.get<Queue>(
      getQueueToken(QUEUE_REELS_MODERATION),
    );
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  const api = () => testApp.api;
  const seller = () => createPerson(testApp, 'seller');
  const customer = () => createPerson(testApp, 'customer');
  const videoKey = (id: string) => `reels/${id}/video.mp4`;
  const thumbKey = (id: string) => `reels/${id}/thumb.jpg`;
  const inPrivate = (key: string) => storage.head(storage.privateBucket, key);
  const inPublic = (key: string) => storage.head(storage.publicBucket, key);

  function upload(
    who: { token: string },
    options: {
      path?: string;
      contentType?: string;
      description?: string;
      thumbnail?: { path: string; contentType: string };
    } = {},
  ) {
    return api().post<ReelDto>('/api/reels', {
      token: who.token,
      multipart: {
        fields:
          options.description === undefined
            ? {}
            : { description: options.description },
        files: [
          {
            field: 'video',
            path: options.path ?? SAMPLE_10S,
            contentType: options.contentType ?? 'video/mp4',
          },
          ...(options.thumbnail
            ? [{ field: 'thumbnail', ...options.thumbnail }]
            : []),
        ],
      },
    });
  }

  async function statusOf(reelId: string, who: { token: string }) {
    const res = await api().get<ReelDto>(`/api/reels/${reelId}`, {
      token: who.token,
    });
    return res.status === 200 ? res.data.status : res.status;
  }

  /** Every file in the private bucket: a failed upload must leave none behind (empty folders do not count). */
  async function storedFiles(): Promise<string[]> {
    const root = join(testApp.storageDir, storage.privateBucket);
    const walk = async (directory: string): Promise<string[]> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return [];
      }
      const nested = await Promise.all(
        entries.map((entry) =>
          entry.isDirectory()
            ? walk(join(directory, entry.name))
            : Promise.resolve([join(directory, entry.name)]),
        ),
      );
      return nested.flat().sort();
    };
    return walk(root);
  }

  describe('a clean upload', () => {
    it('is private while it waits, then published and public with a short cache, and notifies a mention', async () => {
      const uploader = await seller();
      const mentioned = await customer();
      const viewer = await customer();

      // Hold screening, to look at the reel while it waits.
      await moderationQueue.pause();
      let reelId: string;
      try {
        const res = await upload(uploader, {
          description: `a first reel #parts @${mentioned.username}`,
        });
        expect(res.status).toBe(201);
        expect(res.data.status).toBe('pending_moderation');
        reelId = res.data.id;

        // Both files are in the private bucket and nowhere else.
        expect(await inPrivate(videoKey(reelId))).not.toBeNull();
        expect(await inPrivate(thumbKey(reelId))).not.toBeNull();
        expect(await inPublic(videoKey(reelId))).toBeNull();
        expect(await inPublic(thumbKey(reelId))).toBeNull();
        // Nobody else can see it, and the owner gets a link that expires.
        expect(await statusOf(reelId, viewer)).toBe(404);
        const own = await api().get<ReelDto>(`/api/reels/${reelId}`, {
          token: uploader.token,
        });
        expect(own.data.videoUrl).not.toContain('media.test');
      } finally {
        await moderationQueue.resume();
      }

      // The queue hands it to screening on its own, and the stub finds it clean.
      await eventually(async () => {
        expect(await statusOf(reelId, viewer)).toBe('published');
      });

      // The status changes first; the files are copied right after.
      await eventually(async () => {
        expect(await inPublic(videoKey(reelId))).not.toBeNull();
      });
      const video = await inPublic(videoKey(reelId));
      expect(video?.cacheControl).toBe(PUBLIC_CACHE_CONTROL);
      expect(video?.contentType).toBe('video/mp4');
      expect(await inPublic(thumbKey(reelId))).not.toBeNull();
      // The public link is for everyone, so it is the same for the viewer as for the owner.
      const seen = await api().get<ReelDto>(`/api/reels/${reelId}`, {
        token: viewer.token,
      });
      expect(seen.data.videoUrl).toBe(storage.publicUrl(videoKey(reelId)));

      // The mention is sent when publishing finishes, once.
      await eventually(async () => {
        const events = await notificationEventModel(testApp)
          .find({
            type: NotificationEventType.REEL_MENTION,
            reelId: new Types.ObjectId(reelId),
            recipientId: new Types.ObjectId(mentioned.id),
          })
          .exec();
        expect(events).toHaveLength(1);
      });
    });

    it('gets a thumbnail made from the video when it brings no cover, and keeps one it brings', async () => {
      const uploader = await seller();
      await moderationQueue.pause();
      const directory = await mkdtemp(join(tmpdir(), 'e2e-cover-'));
      try {
        const generated = await upload(uploader);
        expect(generated.status).toBe(201);
        const info = await inPrivate(thumbKey(generated.data.id));
        expect(info?.contentType).toBe('image/jpeg');

        // A 1x1 PNG.
        const cover = join(directory, 'cover.png');
        await writeFile(
          cover,
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
          ),
        );
        const covered = await upload(uploader, {
          thumbnail: { path: cover, contentType: 'image/png' },
        });
        expect(covered.status).toBe(201);
        const kept = await inPrivate(`reels/${covered.data.id}/thumb.png`);
        expect(kept?.contentType).toBe('image/png');
      } finally {
        await rm(directory, { recursive: true, force: true });
        await moderationQueue.resume();
      }
    });
  });

  describe('a flagged upload', () => {
    it('is rejected, never made public, and the owner is told', async () => {
      const uploader = await seller();
      const viewer = await customer();

      const res = await upload(uploader, {
        description: 'flagged upload nsfw-test',
      });
      expect(res.status).toBe(201);
      const reelId = res.data.id;

      await eventually(async () => {
        expect(await statusOf(reelId, uploader)).toBe('rejected');
      });

      expect(await inPublic(videoKey(reelId))).toBeNull();
      expect(await inPublic(thumbKey(reelId))).toBeNull();
      expect(await statusOf(reelId, viewer)).toBe(404);

      const events = await notificationEventModel(testApp)
        .find({
          type: NotificationEventType.REEL_REJECTED,
          reelId: new Types.ObjectId(reelId),
          recipientId: new Types.ObjectId(uploader.id),
        })
        .exec();
      expect(events).toHaveLength(1);
    });
  });

  describe('is refused', () => {
    const refusedCases = async () => {
      const before = await reelModel(testApp).countDocuments().exec();
      return {
        before,
        after: async () => reelModel(testApp).countDocuments().exec(),
      };
    };

    it('for a customer (fixture customer 1): only sellers publish (FR-025)', async () => {
      const token = await issueToken(testApp.infra, 'customer', 1);
      const res = await upload({ token });
      expect([res.status, res.error]).toEqual([403, 'REELS_SELLERS_ONLY']);
    });

    it('for a suspended seller (fixture seller 2) (FR-008)', async () => {
      const token = await issueToken(testApp.infra, 'seller', 2);
      const res = await upload({ token });
      expect([res.status, res.error]).toEqual([
        403,
        'ACCOUNT_NOT_IN_GOOD_STANDING',
      ]);
    });

    it('for a video over the duration limit, leaving no reel and no files (FR-026, FR-033)', async () => {
      const uploader = await seller();
      const { before, after } = await refusedCases();
      const filesBefore = await storedFiles();

      const res = await upload(uploader, { path: SAMPLE_70S });

      expect([res.status, res.error]).toEqual([400, 'VIDEO_TOO_LONG']);
      expect(await after()).toBe(before);
      expect(await storedFiles()).toEqual(filesBefore);
    });

    it('for a file that is not a video (FR-027)', async () => {
      const uploader = await seller();
      const directory = await mkdtemp(join(tmpdir(), 'e2e-text-'));
      try {
        const file = join(directory, 'notes.txt');
        await writeFile(file, 'this is not a video');
        const res = await upload(uploader, {
          path: file,
          contentType: 'text/plain',
        });
        expect([res.status, res.error]).toEqual([
          400,
          'UNSUPPORTED_MEDIA_TYPE',
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('for a description over the limit (FR-070)', async () => {
      const uploader = await seller();
      const limit = testApp.app.get(LimitsService).maxDescriptionLength;
      const { before, after } = await refusedCases();

      const res = await upload(uploader, {
        description: 'x'.repeat(limit + 1),
      });

      expect([res.status, res.error]).toEqual([400, 'VALIDATION_FAILED']);
      expect(await after()).toBe(before);
    });

    it('with no video at all', async () => {
      const uploader = await seller();
      const res = await api().post('/api/reels', {
        token: uploader.token,
        multipart: { fields: { description: 'no video' } },
      });
      expect([res.status, res.error]).toEqual([400, 'VIDEO_REQUIRED']);
    });
  });

  describe('when storing fails (FR-033)', () => {
    it('leaves no reel and no files behind, even though the video was already stored', async () => {
      const uploader = await seller();
      const before = await reelModel(testApp).countDocuments().exec();
      const filesBefore = await storedFiles();

      // The video goes in; the cover fails.
      const original = storage.putFile.bind(storage);
      let calls = 0;
      const spy = jest
        .spyOn(storage, 'putFile')
        .mockImplementation(
          (...args: Parameters<StorageService['putFile']>) => {
            calls += 1;
            return calls === 2
              ? Promise.reject(new Error('the disk is full'))
              : original(...args);
          },
        );
      try {
        const res = await upload(uploader);
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(calls).toBe(2);
      } finally {
        spy.mockRestore();
      }

      expect(await reelModel(testApp).countDocuments().exec()).toBe(before);
      expect(await storedFiles()).toEqual(filesBefore);
    });
  });

  describe('deleting', () => {
    it("removes the reel's files from both buckets", async () => {
      const uploader = await seller();
      const res = await upload(uploader);
      const reelId = res.data.id;
      await eventually(async () => {
        expect(await statusOf(reelId, uploader)).toBe('published');
      });
      await eventually(async () => {
        expect(await inPublic(videoKey(reelId))).not.toBeNull();
      });
      expect(await inPrivate(videoKey(reelId))).not.toBeNull();

      const deleted = await api().delete(`/api/reels/${reelId}`, {
        token: uploader.token,
      });
      expect(deleted.status).toBe(200);

      for (const key of [videoKey(reelId), thumbKey(reelId)]) {
        expect(await inPublic(key)).toBeNull();
        expect(await inPrivate(key)).toBeNull();
      }
    });

    it('is refused for a seller who does not own the reel', async () => {
      const uploader = await seller();
      const other = await seller();
      const res = await upload(uploader);

      const refused = await api().delete(`/api/reels/${res.data.id}`, {
        token: other.token,
      });
      expect([refused.status, refused.error]).toEqual([403, 'NOT_REEL_OWNER']);
    });
  });

  describe('media follow standing (FR-009)', () => {
    async function publishedBy(owner: Person): Promise<string> {
      const res = await upload(owner);
      await eventually(async () => {
        expect(await statusOf(res.data.id, owner)).toBe('published');
        expect(await inPublic(videoKey(res.data.id))).not.toBeNull();
      });
      return res.data.id;
    }
    const setStatus = (owner: Person, status: string) =>
      testApp.infra.rootQuery('UPDATE sellers SET status = ? WHERE id = ?', [
        status,
        owner.externalId,
      ]);
    async function syncAndSettle() {
      await runSync(testApp);
      await drainQueue(testApp, QUEUE_MEDIA_VISIBILITY);
    }

    it('takes the public files down when the seller is suspended, and brings them back on reinstatement', async () => {
      const owner = await seller();
      const reelId = await publishedBy(owner);
      expect(await inPublic(videoKey(reelId))).not.toBeNull();

      await setStatus(owner, 'suspended');
      await syncAndSettle();

      // The copied link stops working; the owner still gets a link that expires.
      expect(await inPublic(videoKey(reelId))).toBeNull();
      expect(await inPublic(thumbKey(reelId))).toBeNull();
      expect(await inPrivate(videoKey(reelId))).not.toBeNull();
      const own = await api().get<ReelDto>(`/api/reels/${reelId}`, {
        token: owner.token,
      });
      expect(own.status).toBe(200);
      expect(own.data.videoUrl).not.toBe(storage.publicUrl(videoKey(reelId)));
      expect(own.data.videoUrl).toBeTruthy();

      await setStatus(owner, 'approved');
      await syncAndSettle();

      expect(await inPublic(videoKey(reelId))).not.toBeNull();
      expect(await inPublic(thumbKey(reelId))).not.toBeNull();
      expect((await inPublic(videoKey(reelId)))?.cacheControl).toBe(
        PUBLIC_CACHE_CONTROL,
      );
    });

    it('lets a suspended seller delete their own reel, and removes every copy', async () => {
      const owner = await seller();
      const reelId = await publishedBy(owner);
      await setStatus(owner, 'suspended');
      await syncAndSettle();

      const deleted = await api().delete(`/api/reels/${reelId}`, {
        token: owner.token,
      });
      expect(deleted.status).toBe(200);
      expect(await inPrivate(videoKey(reelId))).toBeNull();
      expect(await inPublic(videoKey(reelId))).toBeNull();
    });

    it('keeps a reel private when it passes screening while its seller is suspended, and publishes it on reinstatement', async () => {
      const owner = await seller();
      const viewer = await customer();

      await moderationQueue.pause();
      let reelId: string;
      try {
        reelId = (await upload(owner)).data.id;
        await setStatus(owner, 'suspended');
        await syncAndSettle();
      } finally {
        await moderationQueue.resume();
      }
      await testApp.app.get(ReelsModerationService).moderateReel(reelId);

      // Published as far as the status goes, but the files never left the private bucket.
      const doc = await reelModel(testApp).findById(reelId).exec();
      expect(doc?.status).toBe('published');
      expect(doc?.media.location).toBe('private');
      expect(await inPublic(videoKey(reelId))).toBeNull();
      expect(await statusOf(reelId, viewer)).toBe(404);

      await setStatus(owner, 'approved');
      await syncAndSettle();
      expect(await inPublic(videoKey(reelId))).not.toBeNull();
      expect(await statusOf(reelId, viewer)).toBe('published');
    });

    it("also hides a suspended seller's profile from others, as if the account did not exist", async () => {
      const owner = await seller();
      const viewer = await customer();
      await publishedBy(owner);
      await setStatus(owner, 'suspended');
      await syncAndSettle();

      const profile = await api().get(`/api/users/${owner.id}/profile`, {
        token: viewer.token,
      });
      expect([profile.status, profile.error]).toEqual([
        404,
        'ACCOUNT_NOT_FOUND',
      ]);
      const own = await api().get<CreatorProfileDto>(
        `/api/users/${owner.id}/profile`,
        { token: owner.token },
      );
      expect(own.status).toBe(200);
    });
  });
});

describe('Upload limits (e2e)', () => {
  describe('the video size', () => {
    let testApp: TestApp;

    beforeAll(async () => {
      testApp = await createTestApp({ env: { REEL_MAX_VIDEO_BYTES: '1000' } });
    }, 120_000);

    afterAll(async () => {
      await testApp.close();
    });

    it('is enforced while the file arrives: 413 VIDEO_TOO_LARGE', async () => {
      const uploader = await createPerson(testApp, 'seller');
      const before = await reelModel(testApp).countDocuments().exec();

      const res = await testApp.api.post('/api/reels', {
        token: uploader.token,
        multipart: {
          files: [
            { field: 'video', path: SAMPLE_10S, contentType: 'video/mp4' },
          ],
        },
      });

      expect([res.status, res.error]).toEqual([413, 'VIDEO_TOO_LARGE']);
      expect(await reelModel(testApp).countDocuments().exec()).toBe(before);
    });
  });

  describe('the number of uploads per hour (FR-070)', () => {
    let testApp: TestApp;

    beforeAll(async () => {
      testApp = await createTestApp({
        env: { UPLOAD_RATE_LIMIT_PER_HOUR: '2' },
      });
    }, 120_000);

    afterAll(async () => {
      await testApp.close();
    });

    it('stops the third upload of an hour with 429 RATE_LIMITED', async () => {
      const uploader = await createPerson(testApp, 'seller');
      const send = () =>
        testApp.api.post('/api/reels', {
          token: uploader.token,
          multipart: {
            files: [
              { field: 'video', path: SAMPLE_10S, contentType: 'video/mp4' },
            ],
          },
        });

      expect((await send()).status).toBe(201);
      expect((await send()).status).toBe(201);
      const third = await send();
      expect([third.status, third.error]).toEqual([429, 'RATE_LIMITED']);

      // Another seller has their own allowance.
      const other = await createPerson(testApp, 'seller');
      const fine = await testApp.api.post('/api/reels', {
        token: other.token,
        multipart: {
          files: [
            { field: 'video', path: SAMPLE_10S, contentType: 'video/mp4' },
          ],
        },
      });
      expect(fine.status).toBe(201);
    });
  });
});
