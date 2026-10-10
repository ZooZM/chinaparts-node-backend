import { Logger } from '@nestjs/common';
import { NotificationEventsRepository } from './notification-events.repository';
import { ReelsNotificationsService } from './reels-notifications.service';
import { NotificationEventType } from './schemas/notification-event.schema';

/**
 * FR-062 to FR-066: no self-events, no re-notify on a duplicate action, delivery is attempted
 * only after the event is durably recorded, and a failure never reaches the caller.
 */
describe('ReelsNotificationsService', () => {
  const actorId = '65f1a2b3c4d5e6f7a8b9c0d1';
  const recipientId = '65f1a2b3c4d5e6f7a8b9c0d2';
  const reelId = '65f1a2b3c4d5e6f7a8b9c0e1';

  let events: { recordIfNew: jest.Mock };
  let sender: { send: jest.Mock };
  let service: ReelsNotificationsService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    events = { recordIfNew: jest.fn().mockResolvedValue(true) };
    sender = { send: jest.fn().mockResolvedValue(undefined) };
    service = new ReelsNotificationsService(
      events as unknown as NotificationEventsRepository,
      sender,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('records an event and sends a job for a new follower', async () => {
    await service.notifyNewFollower({ actorId, recipientId });

    expect(events.recordIfNew).toHaveBeenCalledWith({
      type: NotificationEventType.NEW_FOLLOWER,
      actorId,
      recipientId,
    });
    expect(sender.send).toHaveBeenCalledWith({
      recipientId,
      type: 'newFollower',
      actorId,
      reelId: undefined,
    });
  });

  it('sends a like with the reel id', async () => {
    await service.notifyReelLike({ actorId, recipientId, reelId });
    expect(sender.send).toHaveBeenCalledWith({
      recipientId,
      type: 'reelLike',
      actorId,
      reelId,
    });
  });

  it('carries ids only, never a name or any text (FR-073a)', async () => {
    await service.notifyReelLike({ actorId, recipientId, reelId });
    const [job] = sender.send.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(job).sort()).toEqual([
      'actorId',
      'recipientId',
      'reelId',
      'type',
    ]);
  });

  it('never notifies on a self-action', async () => {
    await service.notifyReelLike({ actorId: recipientId, recipientId, reelId });
    await service.notifyNewFollower({ actorId: recipientId, recipientId });

    expect(events.recordIfNew).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('does not send when the event already exists (unlike then like again)', async () => {
    events.recordIfNew.mockResolvedValue(false);

    await service.notifyReelLike({ actorId, recipientId, reelId });

    expect(events.recordIfNew).toHaveBeenCalledTimes(1);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('records the event before it sends', async () => {
    const order: string[] = [];
    events.recordIfNew.mockImplementation(() => {
      order.push('record');
      return Promise.resolve(true);
    });
    sender.send.mockImplementation(() => {
      order.push('send');
      return Promise.resolve();
    });

    await service.notifyReelLike({ actorId, recipientId, reelId });

    expect(order).toEqual(['record', 'send']);
  });

  it('notifyMentions skips self-mentions and notifies only the others', async () => {
    await service.notifyMentions({
      actorId,
      reelId,
      mentions: [
        { userId: actorId, username: 'self' },
        { userId: recipientId, username: 'other' },
      ],
    });

    expect(events.recordIfNew).toHaveBeenCalledTimes(1);
    expect(events.recordIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationEventType.REEL_MENTION,
        recipientId,
      }),
    );
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('a rejected reel notifies its owner with no actor, and the self-skip does not apply', async () => {
    await service.notifyReelRejected({ recipientId: actorId, reelId });

    expect(events.recordIfNew).toHaveBeenCalledWith({
      type: NotificationEventType.REEL_REJECTED,
      actorId: null,
      recipientId: actorId,
      reelId,
    });
    expect(sender.send).toHaveBeenCalledWith({
      recipientId: actorId,
      type: 'reelRejected',
      actorId: undefined,
      reelId,
    });
  });

  describe('a failure never reaches the caller (FR-066)', () => {
    it('when delivery fails', async () => {
      sender.send.mockRejectedValue(new Error('queue down'));
      await expect(
        service.notifyReelLike({ actorId, recipientId, reelId }),
      ).resolves.toBeUndefined();
    });

    it('when recording the event fails', async () => {
      events.recordIfNew.mockRejectedValue(new Error('db down'));
      await expect(
        service.notifyNewFollower({ actorId, recipientId }),
      ).resolves.toBeUndefined();
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('and one failed mention does not stop the rest', async () => {
      events.recordIfNew
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue(true);
      await service.notifyMentions({
        actorId,
        reelId,
        mentions: [
          { userId: 'a'.repeat(24), username: 'first' },
          { userId: 'b'.repeat(24), username: 'second' },
        ],
      });
      expect(sender.send).toHaveBeenCalledTimes(1);
    });
  });
});
