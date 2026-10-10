import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Types } from 'mongoose';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { ChinaPartsAccountsRepository } from '../../src/modules/china-parts/chinaparts-accounts.repository';
import { ReelLifecycleService } from '../../src/modules/reels/lifecycle/reel-lifecycle.service';
import { REELS_REPOSITORY } from '../../src/modules/reels/reels.repository';
import type { ReelsRepository } from '../../src/modules/reels/reels.repository';
import { StorageService } from '../../src/common/storage/storage.service';
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

/**
 * A published reel, made directly for tests that are not about uploading: the files are stored
 * privately, the reel is created and published, and the lifecycle makes the files public, so
 * everything downstream (feeds, media URLs, standing) sees a reel exactly as it would for real.
 */
export async function createPublishedReel(
  testApp: TestApp,
  sellerExternalId: number,
  options: {
    description?: string;
    hashtags?: string[];
    hashtagsNormalized?: string[];
    creatorId?: string;
  } = {},
): Promise<{
  id: string;
  creatorId: string;
  videoKey: string;
  thumbnailKey: string;
}> {
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

  await reels.createReel({
    id,
    creatorId,
    videoKey,
    thumbnailKey,
    description: options.description ?? '',
    hashtags: options.hashtags ?? [],
    hashtagsNormalized: options.hashtagsNormalized ?? [],
    mentions: [],
  });
  const published = await reels.publishPending(id);
  if (published) await lifecycle.onPublished(published);
  return { id, creatorId, videoKey, thumbnailKey };
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
