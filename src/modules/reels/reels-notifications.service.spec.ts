import { ReelsNotificationsService } from './reels-notifications.service';
import { NotificationEventType } from './schemas/notification-event.schema';

interface MockEventModel {
  create: jest.Mock;
}
interface MockUserModel {
  findById: jest.Mock;
}
interface MockPushService {
  sendPush: jest.Mock;
}
interface MockDeviceTokens {
  getTokens: jest.Mock;
}

/**
 * FR-054: no self-events, no re-notify on a duplicate action, delivery is
 * attempted only after the event is durably recorded.
 */
describe('ReelsNotificationsService', () => {
  let eventModel: MockEventModel;
  let userModel: MockUserModel;
  let pushService: MockPushService;
  let deviceTokens: MockDeviceTokens;
  let service: ReelsNotificationsService;

  const actorId = '65f1a2b3c4d5e6f7a8b9c0d1';
  const recipientId = '65f1a2b3c4d5e6f7a8b9c0d2';
  const reelId = '65f1a2b3c4d5e6f7a8b9c0e1';

  beforeEach(() => {
    eventModel = { create: jest.fn().mockResolvedValue({}) };
    userModel = {
      findById: jest.fn(() => ({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve({ name: 'Actor' }) }),
        }),
      })),
    };
    pushService = { sendPush: jest.fn().mockResolvedValue(undefined) };
    deviceTokens = {
      getTokens: jest.fn().mockResolvedValue([{ token: 'device-token-1' }]),
    };
    service = new ReelsNotificationsService(
      eventModel as never,
      userModel as never,
      pushService as never,
      deviceTokens as never,
    );
  });

  it('records an event and sends a push for a new follower', async () => {
    await service.notifyNewFollower({ actorId, recipientId });

    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationEventType.NEW_FOLLOWER }),
    );
    expect(pushService.sendPush).toHaveBeenCalledTimes(1);
  });

  it('never notifies on a self-action (like your own reel)', async () => {
    await service.notifyReelLike({
      actorId: recipientId,
      recipientId,
      reelId,
    });

    expect(eventModel.create).not.toHaveBeenCalled();
    expect(pushService.sendPush).not.toHaveBeenCalled();
  });

  it('skips the push (but still attempted the write) when the event already exists (duplicate-key dedup)', async () => {
    eventModel.create.mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
    );

    await service.notifyReelLike({ actorId, recipientId, reelId });

    expect(eventModel.create).toHaveBeenCalledTimes(1);
    expect(pushService.sendPush).not.toHaveBeenCalled();
  });

  it('does not push when the recipient has no device tokens, but the event is still recorded', async () => {
    deviceTokens.getTokens.mockResolvedValue([]);

    await service.notifyReelLike({ actorId, recipientId, reelId });

    expect(eventModel.create).toHaveBeenCalledTimes(1);
    expect(pushService.sendPush).not.toHaveBeenCalled();
  });

  it('notifyMentions skips self-mentions and notifies only resolved others', async () => {
    await service.notifyMentions({
      actorId,
      reelId,
      mentions: [
        { userId: actorId, username: 'self' },
        { userId: recipientId, username: 'other' },
      ],
    });

    expect(eventModel.create).toHaveBeenCalledTimes(1);
    expect(eventModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationEventType.REEL_MENTION }),
    );
    expect(pushService.sendPush).toHaveBeenCalledTimes(1);
  });
});
