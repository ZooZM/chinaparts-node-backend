import { getQueueToken } from '@nestjs/bullmq';
import { getModelToken } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import {
  StandingSyncProcessor,
  SyncResult,
} from '../../src/modules/accounts/standing-sync.processor';
import { ChinaPartsAccountsRepository } from '../../src/modules/china-parts/chinaparts-accounts.repository';
import { ReelLifecycleService } from '../../src/modules/reels/lifecycle/reel-lifecycle.service';
import { REELS_REPOSITORY } from '../../src/modules/reels/reels.repository';
import type { ReelsRepository } from '../../src/modules/reels/reels.repository';
import { StorageService } from '../../src/common/storage/storage.service';
import { normalizeForMatch } from '../../src/common/text/normalize-for-match';
import {
  NotificationEvent,
  NotificationEventDocument,
} from '../../src/modules/reels/schemas/notification-event.schema';
import {
  Reel,
  ReelDocument,
} from '../../src/modules/reels/schemas/reel.schema';
import type { TestApp } from './app';

export const SAMPLE_10S = join(
  __dirname,
  '..',
  'fixtures',
  'media',
  'sample-10s.mp4',
);
export const SAMPLE_70S = join(
  __dirname,
  '..',
  'fixtures',
  'media',
  'sample-70s.mp4',
);

/** The reels account (its ObjectId) of a China Parts account, provisioned on first use. */
export async function accountIdOf(
  testApp: TestApp,
  type: 'customer' | 'seller',
  externalId: number,
): Promise<string> {
  const chinaParts = testApp.app.get(ChinaPartsAccountsRepository);
  const [remote] =
    type === 'customer'
      ? await chinaParts.getCustomers([externalId])
      : await chinaParts.getSellers([externalId]);
  if (!remote)
    throw new Error(`No ${type} ${externalId} in the China Parts fixtures`);
  const account = await testApp.app
    .get(AccountsService)
    .resolveOrProvision(remote);
  return account._id.toString();
}

export type SeededStatus =
  'pending_moderation' | 'published' | 'rejected' | 'hidden';

export interface SeededReel {
  id: string;
  creatorId: string;
  videoKey: string;
  thumbnailKey: string;
}

export interface SeedReelOptions {
  status?: SeededStatus;
  description?: string;
  hashtags?: string[];
  hashtagsNormalized?: string[];
  /** Default: the creator's reels account, provisioned on first use. */
  creatorId?: string;
}

/**
 * A reel made directly, for tests that are not about uploading. The files are stored privately
 * and the reel is created exactly as an upload would create it (pending), then taken to `status`:
 * `published` goes through the real publish and lifecycle, so the files become public and
 * everything downstream (feeds, media URLs, standing) sees a reel as it would for real. `rejected`
 * and `hidden` are set on the document, which is what the API-level visibility rules read.
 */
export async function createReel(
  testApp: TestApp,
  sellerExternalId: number,
  options: SeedReelOptions = {},
): Promise<SeededReel> {
  const status = options.status ?? 'published';
  const creatorId =
    options.creatorId ??
    (await accountIdOf(testApp, 'seller', sellerExternalId));
  const reels = testApp.app.get<ReelsRepository>(REELS_REPOSITORY);
  const storage = testApp.app.get(StorageService);
  const lifecycle = testApp.app.get(ReelLifecycleService);

  const id = new Types.ObjectId().toString();
  const videoKey = `reels/${id}/video.mp4`;
  const thumbnailKey = `reels/${id}/thumb.jpg`;
  const workDir = await mkdtemp(join(tmpdir(), 'e2e-reel-'));
  try {
    const file = join(workDir, 'video.mp4');
    await copyFile(SAMPLE_10S, file);
    await storage.putFile(storage.privateBucket, videoKey, file, 'video/mp4');
    await storage.putFile(
      storage.privateBucket,
      thumbnailKey,
      file,
      'image/jpeg',
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const hashtags = options.hashtags ?? [];
  await reels.createReel({
    id,
    creatorId,
    videoKey,
    thumbnailKey,
    description: options.description ?? '',
    hashtags,
    hashtagsNormalized:
      options.hashtagsNormalized ??
      hashtags.map((tag) => normalizeForMatch(tag)),
    mentions: [],
  });

  if (status === 'published') {
    const published = await reels.publishPending(id);
    if (published) await lifecycle.onPublished(published);
  } else if (status !== 'pending_moderation') {
    await reelModel(testApp).updateOne({ _id: id }, { $set: { status } });
  }
  return { id, creatorId, videoKey, thumbnailKey };
}

/** A published reel: the common case of {@link createReel}. */
export function createPublishedReel(
  testApp: TestApp,
  sellerExternalId: number,
  options: Omit<SeedReelOptions, 'status'> = {},
): Promise<SeededReel> {
  return createReel(testApp, sellerExternalId, {
    ...options,
    status: 'published',
  });
}

/** The reels collection, for assertions the API deliberately does not expose (report counts). */
export function reelModel(testApp: TestApp): Model<ReelDocument> {
  return testApp.app.get<Model<ReelDocument>>(getModelToken(Reel.name));
}

/** The durable notification events, which is what a push is decided from. */
export function notificationEventModel(
  testApp: TestApp,
): Model<NotificationEventDocument> {
  return testApp.app.get<Model<NotificationEventDocument>>(
    getModelToken(NotificationEvent.name),
  );
}

/**
 * Runs one standing sync now, and waits for it. The repeating job is paused for the suites that
 * call this, so the schedule never races a test.
 */
export function runSync(testApp: TestApp): Promise<SyncResult> {
  return testApp.app.get(StandingSyncProcessor).runOnce();
}

/** Waits until a queue has nothing waiting, active or delayed, so a test can assert on the outcome. */
export async function drainQueue(
  testApp: TestApp,
  queueName: string,
  timeoutMs = 20_000,
): Promise<void> {
  const queue = testApp.app.get<Queue>(getQueueToken(queueName));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
    );
    if (Object.values(counts).every((count) => count === 0)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Queue ${queueName} did not drain: ${JSON.stringify(counts)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Polls until `check` stops throwing, for outcomes that arrive through a queue or a timer. */
export async function eventually(
  check: () => Promise<void>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
