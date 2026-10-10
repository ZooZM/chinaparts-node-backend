import { Logger } from '@nestjs/common';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { StorageService } from '../../common/storage/storage.service';
import { AccountsService } from '../accounts/accounts.service';
import { ReelLifecycleService } from './lifecycle/reel-lifecycle.service';
import type { ModerationVerdict } from './moderation/moderation-provider';
import { ReelsModerationService } from './reels-moderation.service';
import { ReelsNotificationsService } from './reels-notifications.service';
import type { ModerationCandidate, ReelsRepository } from './reels.repository';

const reelId = '65f1a2b3c4d5e6f7a8b9c0e1';
const creatorId = '65f1a2b3c4d5e6f7a8b9c0d1';
const mentionedId = '65f1a2b3c4d5e6f7a8b9c0d2';

function candidate(
  overrides: Partial<ModerationCandidate> = {},
): ModerationCandidate {
  return {
    id: reelId,
    creatorId,
    status: 'pending_moderation',
    media: {
      videoKey: `reels/${reelId}/video.mp4`,
      thumbnailKey: `reels/${reelId}/thumb.jpg`,
      location: 'private',
    },
    hashtagsNormalized: [],
    description: 'a clean description',
    mentions: [],
    createdAt: new Date(Date.now() - 5_000),
    ...overrides,
  };
}

async function setup() {
  const downloadDir = await mkdtemp(join(tmpdir(), 'moderation-spec-'));
  const videoPath = join(downloadDir, 'video.mp4');
  await writeFile(videoPath, 'video bytes');

  const reels = {
    getModerationCandidate: jest.fn().mockResolvedValue(candidate()),
    publishPending: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(candidate({ status: 'published' })),
      ),
    rejectPending: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(candidate({ status: 'rejected' })),
      ),
    findStalePendingIds: jest.fn().mockResolvedValue([]),
  };
  const provider = {
    analyze: jest
      .fn<Promise<ModerationVerdict>, [string, string]>()
      .mockResolvedValue({ verdict: 'clean' }),
  };
  const storage = {
    privateBucket: 'priv',
    downloadToTemp: jest.fn().mockResolvedValue(videoPath),
  };
  const lifecycle = {
    onPublished: jest.fn().mockResolvedValue(undefined),
    syncMediaVisibility: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = {
    notifyMentions: jest.fn().mockResolvedValue(undefined),
    notifyReelRejected: jest.fn().mockResolvedValue(undefined),
  };
  const accounts = { getBlockSet: jest.fn().mockResolvedValue([]) };

  const service = new ReelsModerationService(
    reels as unknown as ReelsRepository,
    provider,
    storage as unknown as StorageService,
    lifecycle as unknown as ReelLifecycleService,
    notifications as unknown as ReelsNotificationsService,
    accounts as unknown as AccountsService,
  );
  return {
    service,
    reels,
    provider,
    storage,
    lifecycle,
    notifications,
    accounts,
    videoPath,
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('ReelsModerationService (FR-029 to FR-031)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is a no-op when the reel is gone (deleted mid-review)', async () => {
    const { service, reels, provider, notifications } = await setup();
    reels.getModerationCandidate.mockResolvedValue(null);

    await service.moderateReel(reelId);

    expect(provider.analyze).not.toHaveBeenCalled();
    expect(reels.publishPending).not.toHaveBeenCalled();
    expect(notifications.notifyMentions).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'hidden'] as const)(
    'is a no-op when the reel was already decided (%s): a retried or duplicate job',
    async (status) => {
      const { service, reels, provider } = await setup();
      reels.getModerationCandidate.mockResolvedValue(candidate({ status }));

      await service.moderateReel(reelId);

      expect(provider.analyze).not.toHaveBeenCalled();
      expect(reels.publishPending).not.toHaveBeenCalled();
    },
  );

  it('a retry that finds the reel already published re-applies media visibility instead of screening again', async () => {
    const { service, reels, provider, lifecycle } = await setup();
    const published = candidate({ status: 'published' });
    reels.getModerationCandidate.mockResolvedValue(published);

    await service.moderateReel(reelId);

    expect(lifecycle.syncMediaVisibility).toHaveBeenCalledWith(published);
    expect(provider.analyze).not.toHaveBeenCalled();
    expect(reels.publishPending).not.toHaveBeenCalled();
  });

  describe('a clean verdict', () => {
    it('screens the private video and the description, then publishes', async () => {
      const { service, reels, provider, storage, videoPath } = await setup();
      reels.getModerationCandidate.mockResolvedValue(
        candidate({ description: 'oil filter #فلتر' }),
      );

      await service.moderateReel(reelId);

      expect(storage.downloadToTemp).toHaveBeenCalledWith(
        'priv',
        `reels/${reelId}/video.mp4`,
      );
      expect(provider.analyze).toHaveBeenCalledWith(
        videoPath,
        'oil filter #فلتر',
      );
      expect(reels.publishPending).toHaveBeenCalledWith(reelId);
    });

    it('makes the media public through the lifecycle, after the status update', async () => {
      const { service, reels, lifecycle } = await setup();
      const order: string[] = [];
      reels.publishPending.mockImplementation(() => {
        order.push('status');
        return Promise.resolve(candidate({ status: 'published' }));
      });
      lifecycle.onPublished.mockImplementation(() => {
        order.push('media');
        return Promise.resolve();
      });

      await service.moderateReel(reelId);

      expect(order).toEqual(['status', 'media']);
    });

    it('notifies each mentioned account exactly once', async () => {
      const { service, reels, notifications } = await setup();
      const mentions = [{ userId: mentionedId, username: 'ahmed' }];
      reels.publishPending.mockResolvedValue(
        candidate({ status: 'published', mentions }),
      );

      await service.moderateReel(reelId);

      expect(notifications.notifyMentions).toHaveBeenCalledTimes(1);
      expect(notifications.notifyMentions).toHaveBeenCalledWith({
        actorId: creatorId,
        reelId,
        mentions,
      });
    });

    it('suppresses a mention when either side blocked the other', async () => {
      const { service, reels, notifications, accounts } = await setup();
      const blocked = '65f1a2b3c4d5e6f7a8b9c0d3';
      reels.publishPending.mockResolvedValue(
        candidate({
          status: 'published',
          mentions: [
            { userId: mentionedId, username: 'ok' },
            { userId: blocked, username: 'blocked' },
          ],
        }),
      );
      accounts.getBlockSet.mockResolvedValue([blocked]);

      await service.moderateReel(reelId);

      expect(accounts.getBlockSet).toHaveBeenCalledWith(creatorId);
      expect(notifications.notifyMentions).toHaveBeenCalledWith(
        expect.objectContaining({
          mentions: [{ userId: mentionedId, username: 'ok' }],
        }),
      );
    });

    it('does not even look up blocks when nobody is mentioned', async () => {
      const { service, accounts } = await setup();
      await service.moderateReel(reelId);
      expect(accounts.getBlockSet).not.toHaveBeenCalled();
    });

    it('logs the time from upload to publish, for the 2-minute target (SC-004)', async () => {
      const logged: string[] = [];
      jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
      const { service } = await setup();

      await service.moderateReel(reelId);

      const entry = JSON.parse(
        logged.find((line) => line.includes('reel.published')) ?? '{}',
      ) as {
        publishLatencyMs?: number;
      };
      expect(entry.publishLatencyMs).toBeGreaterThanOrEqual(5_000);
    });
  });

  describe('a flagged verdict', () => {
    it.each([
      [
        'the video',
        { verdict: 'flagged', flaggedSource: 'video', categories: ['nudity'] },
      ],
      [
        'the description',
        {
          verdict: 'flagged',
          flaggedSource: 'description',
          categories: ['hate'],
        },
      ],
    ] as Array<[string, ModerationVerdict]>)(
      'rejects when %s is flagged, stores the result, and tells the owner',
      async (_label, verdict) => {
        const { service, reels, provider, notifications, lifecycle } =
          await setup();
        provider.analyze.mockResolvedValue(verdict);

        await service.moderateReel(reelId);

        expect(reels.rejectPending).toHaveBeenCalledWith(reelId, verdict);
        expect(reels.publishPending).not.toHaveBeenCalled();
        expect(notifications.notifyReelRejected).toHaveBeenCalledWith({
          recipientId: creatorId,
          reelId,
        });
        // The files never became public, so nothing moves.
        expect(lifecycle.onPublished).not.toHaveBeenCalled();
        expect(notifications.notifyMentions).not.toHaveBeenCalled();
      },
    );
  });

  describe('fails closed (FR-031)', () => {
    it('leaves the reel pending and tells nobody when the provider throws', async () => {
      const { service, reels, provider, notifications } = await setup();
      provider.analyze.mockRejectedValue(new Error('provider down'));

      await expect(service.moderateReel(reelId)).rejects.toThrow(
        'provider down',
      );

      expect(reels.publishPending).not.toHaveBeenCalled();
      expect(reels.rejectPending).not.toHaveBeenCalled();
      expect(notifications.notifyMentions).not.toHaveBeenCalled();
      expect(notifications.notifyReelRejected).not.toHaveBeenCalled();
    });

    it('fails when the video cannot be downloaded, changing nothing', async () => {
      const { service, reels, provider, storage } = await setup();
      storage.downloadToTemp.mockRejectedValue(new Error('storage down'));

      await expect(service.moderateReel(reelId)).rejects.toThrow(
        'storage down',
      );

      expect(provider.analyze).not.toHaveBeenCalled();
      expect(reels.publishPending).not.toHaveBeenCalled();
    });

    it('propagates a failure to make the media public, so the queue retries', async () => {
      const { service, lifecycle } = await setup();
      lifecycle.onPublished.mockRejectedValue(new Error('copy failed'));
      await expect(service.moderateReel(reelId)).rejects.toThrow('copy failed');
    });
  });

  describe('the temp copy', () => {
    it('is deleted, with its directory, after a verdict', async () => {
      const { service, videoPath } = await setup();
      await service.moderateReel(reelId);
      expect(await exists(videoPath)).toBe(false);
      expect(await exists(dirname(videoPath))).toBe(false);
    });

    it('is deleted when the provider throws', async () => {
      const { service, provider, videoPath } = await setup();
      provider.analyze.mockRejectedValue(new Error('boom'));
      await service.moderateReel(reelId).catch(() => undefined);
      expect(await exists(videoPath)).toBe(false);
    });
  });

  describe('exactly once', () => {
    it('does not publish twice, or notify, when a concurrent attempt already decided the reel', async () => {
      const { service, reels, lifecycle, notifications } = await setup();
      reels.publishPending.mockResolvedValue(null);

      await service.moderateReel(reelId);

      expect(lifecycle.onPublished).not.toHaveBeenCalled();
      expect(notifications.notifyMentions).not.toHaveBeenCalled();
    });

    it('does not notify twice when a concurrent attempt already rejected the reel', async () => {
      const { service, reels, provider, notifications } = await setup();
      provider.analyze.mockResolvedValue({
        verdict: 'flagged',
        flaggedSource: 'video',
      });
      reels.rejectPending.mockResolvedValue(null);

      await service.moderateReel(reelId);

      expect(notifications.notifyReelRejected).not.toHaveBeenCalled();
    });
  });

  it('finds stale pending reels through the repository', async () => {
    const { service, reels } = await setup();
    reels.findStalePendingIds.mockResolvedValue(['a', 'b']);
    expect(await service.findStalePendingIds(300_000)).toEqual(['a', 'b']);
    expect(reels.findStalePendingIds).toHaveBeenCalledWith(300_000);
  });
});
