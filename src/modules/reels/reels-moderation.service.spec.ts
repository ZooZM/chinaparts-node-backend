import { Types } from 'mongoose';
import { ReelsModerationService } from './reels-moderation.service';
import { ReelStatus } from './schemas/reel.schema';
import { ReelsNotificationsService } from './reels-notifications.service';
import type { ModerationProvider } from './moderation/moderation-provider';

/**
 * Unit tests for the moderation pipeline's core logic (v3, FR-062–FR-066).
 * Deliberately independent of BullMQ/`WorkerHost` — see the service's own
 * docstring — so these run with mocked Mongoose models only, no live queue
 * or Redis required.
 */
describe('ReelsModerationService', () => {
  const reelId = '65f1a2b3c4d5e6f7a8b9c0e1';
  const creatorId = '65f1a2b3c4d5e6f7a8b9c0d1';
  const mentionedId = '65f1a2b3c4d5e6f7a8b9c0d2';

  function basePendingReel(overrides: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(reelId),
      creatorId: new Types.ObjectId(creatorId),
      videoUrl: '/uploads/reels/videos/clip.mp4',
      description: 'a test reel',
      status: ReelStatus.PENDING_MODERATION,
      createdAt: new Date(),
      mentions: [] as { userId: Types.ObjectId; username: string }[],
      ...overrides,
    };
  }

  function buildReelModel(reelDoc: unknown, updateResult: unknown) {
    return {
      findById: jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve(reelDoc)),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve(updateResult)),
      })),
    };
  }

  function buildUserModel(
    creatorBlocked: string[] = [],
    reverseBlockers: { _id: Types.ObjectId }[] = [],
  ) {
    return {
      findById: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn(() =>
              Promise.resolve({
                blockedUsers: creatorBlocked.map(
                  (id) => new Types.ObjectId(id),
                ),
              }),
            ),
          })),
        })),
      })),
      find: jest.fn(() => ({
        select: jest.fn(() => ({
          lean: jest.fn(() => ({
            exec: jest.fn(() => Promise.resolve(reverseBlockers)),
          })),
        })),
      })),
    };
  }

  function buildNotifications() {
    return {
      notifyMentions: jest.fn(),
      notifyReelRejected: jest.fn(),
    } as unknown as jest.Mocked<ReelsNotificationsService>;
  }

  it('no-ops when the reel does not exist (deleted mid-review)', async () => {
    const reelModel = buildReelModel(null, null);
    const userModel = buildUserModel();
    const notifications = buildNotifications();
    const provider: jest.Mocked<ModerationProvider> = {
      analyze: jest.fn(),
    };
    const service = new ReelsModerationService(
      reelModel as never,
      userModel as never,
      provider,
      notifications,
    );

    await service.moderateReel(reelId);

    expect(provider.analyze).not.toHaveBeenCalled();
    expect(reelModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('no-ops when the reel was already decided (retried/duplicate job)', async () => {
    const reelModel = buildReelModel(
      basePendingReel({ status: ReelStatus.PUBLISHED }),
      null,
    );
    const userModel = buildUserModel();
    const notifications = buildNotifications();
    const provider: jest.Mocked<ModerationProvider> = { analyze: jest.fn() };
    const service = new ReelsModerationService(
      reelModel as never,
      userModel as never,
      provider,
      notifications,
    );

    await service.moderateReel(reelId);

    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it('publishes on a clean verdict and fires mention notifications exactly once', async () => {
    const reelModel = buildReelModel(
      basePendingReel({
        mentions: [
          { userId: new Types.ObjectId(mentionedId), username: 'bob' },
        ],
      }),
      { _id: new Types.ObjectId(reelId) },
    );
    const userModel = buildUserModel();
    const notifications = buildNotifications();
    const provider: jest.Mocked<ModerationProvider> = {
      analyze: jest.fn((_videoPath: string, _description: string) =>
        Promise.resolve({ verdict: 'clean' as const }),
      ),
    };
    const service = new ReelsModerationService(
      reelModel as never,
      userModel as never,
      provider,
      notifications,
    );

    await service.moderateReel(reelId);

    expect(reelModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: expect.anything(), status: ReelStatus.PENDING_MODERATION },
      expect.objectContaining({
        $set: expect.objectContaining({ status: ReelStatus.PUBLISHED }),
      }),
    );
    expect(notifications.notifyMentions).toHaveBeenCalledTimes(1);
    expect(notifications.notifyMentions).toHaveBeenCalledWith({
      actorId: creatorId,
      reelId,
      mentions: [{ userId: mentionedId, username: 'bob' }],
    });
    expect(notifications.notifyReelRejected).not.toHaveBeenCalled();
  });

  it('rejects on a flagged verdict, stores the moderation result, and notifies the owner', async () => {
    const reelModel = buildReelModel(basePendingReel(), {
      _id: new Types.ObjectId(reelId),
    });
    const userModel = buildUserModel();
    const notifications = buildNotifications();
    const provider: jest.Mocked<ModerationProvider> = {
      analyze: jest.fn((_videoPath: string, _description: string) =>
        Promise.resolve({
          verdict: 'flagged' as const,
          flaggedSource: 'video' as const,
          categories: ['nudity'],
          providerRef: 'ref-1',
        }),
      ),
    };
    const service = new ReelsModerationService(
      reelModel as never,
      userModel as never,
      provider,
      notifications,
    );

    await service.moderateReel(reelId);

    expect(reelModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: expect.anything(), status: ReelStatus.PENDING_MODERATION },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: ReelStatus.REJECTED,
          moderation: expect.objectContaining({
            verdict: 'flagged',
            flaggedSource: 'video',
            categories: ['nudity'],
            providerRef: 'ref-1',
          }),
        }),
      }),
    );
    expect(notifications.notifyReelRejected).toHaveBeenCalledWith({
      recipientId: creatorId,
      reelId,
    });
    expect(notifications.notifyMentions).not.toHaveBeenCalled();
  });

  it('leaves the reel pending and never notifies when the provider throws (fail-closed)', async () => {
    const reelModel = buildReelModel(basePendingReel(), {});
    const userModel = buildUserModel();
    const notifications = buildNotifications();
    const provider: jest.Mocked<ModerationProvider> = {
      analyze: jest.fn((_videoPath: string, _description: string) =>
        Promise.reject(new Error('provider unreachable')),
      ),
    };
    const service = new ReelsModerationService(
      reelModel as never,
      userModel as never,
      provider,
      notifications,
    );

    await expect(service.moderateReel(reelId)).rejects.toThrow(
      'provider unreachable',
    );

    expect(reelModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(notifications.notifyMentions).not.toHaveBeenCalled();
    expect(notifications.notifyReelRejected).not.toHaveBeenCalled();
  });

  it('never double-fires notifications when a concurrent/retried attempt already decided the reel', async () => {
    // findOneAndUpdate returns null: the guarded precondition
    // (status: PENDING_MODERATION) no longer matched.
    const reelModel = buildReelModel(basePendingReel(), null);
    const userModel = buildUserModel();
    const notifications = buildNotifications();
    const provider: jest.Mocked<ModerationProvider> = {
      analyze: jest.fn((_videoPath: string, _description: string) =>
        Promise.resolve({ verdict: 'clean' as const }),
      ),
    };
    const service = new ReelsModerationService(
      reelModel as never,
      userModel as never,
      provider,
      notifications,
    );

    await service.moderateReel(reelId);

    expect(notifications.notifyMentions).not.toHaveBeenCalled();
  });

  it('suppresses a mention notification when the mentioned user has blocked the creator', async () => {
    const reelModel = buildReelModel(
      basePendingReel({
        mentions: [
          { userId: new Types.ObjectId(mentionedId), username: 'bob' },
        ],
      }),
      { _id: new Types.ObjectId(reelId) },
    );
    // Reverse block: `mentionedId` blocked `creatorId`.
    const userModel = buildUserModel(
      [],
      [{ _id: new Types.ObjectId(mentionedId) }],
    );
    const notifications = buildNotifications();
    const provider: jest.Mocked<ModerationProvider> = {
      analyze: jest.fn((_videoPath: string, _description: string) =>
        Promise.resolve({ verdict: 'clean' as const }),
      ),
    };
    const service = new ReelsModerationService(
      reelModel as never,
      userModel as never,
      provider,
      notifications,
    );

    await service.moderateReel(reelId);

    expect(notifications.notifyMentions).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [] }),
    );
  });

  describe('findStalePendingIds', () => {
    it('returns the ids of reels stuck in pending_moderation past the threshold', async () => {
      const staleId = new Types.ObjectId();
      const reelModel = {
        find: jest.fn(() => ({
          select: jest.fn(() => ({
            lean: jest.fn(() => ({
              exec: jest.fn(() => Promise.resolve([{ _id: staleId }])),
            })),
          })),
        })),
      };
      const userModel = buildUserModel();
      const notifications = buildNotifications();
      const provider: jest.Mocked<ModerationProvider> = { analyze: jest.fn() };
      const service = new ReelsModerationService(
        reelModel as never,
        userModel as never,
        provider,
        notifications,
      );

      const ids = await service.findStalePendingIds(5 * 60 * 1000);

      expect(ids).toEqual([staleId.toString()]);
    });
  });
});
