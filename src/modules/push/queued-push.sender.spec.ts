import type { Queue } from 'bullmq';
import {
  PUSH_JOB,
  PUSH_JOB_OPTIONS,
  QueuedPushSender,
} from './queued-push.sender';
import type { PushJob } from './push-sender';

describe('QueuedPushSender (FR-066, research R14)', () => {
  const job: PushJob = {
    type: 'reelLike',
    recipientId: 'r',
    actorId: 'a',
    reelId: 'x',
  };

  it('queues the job with its ids and nothing else, with retries', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const sender = new QueuedPushSender({ add } as unknown as Queue);

    await sender.send(job);

    expect(add).toHaveBeenCalledWith(PUSH_JOB, job, PUSH_JOB_OPTIONS);
    expect(PUSH_JOB_OPTIONS.attempts).toBe(3);
    expect(PUSH_JOB_OPTIONS.backoff.type).toBe('exponential');
  });

  it('lets a queue failure through, for the notification service to log (it never fails the like)', async () => {
    const sender = new QueuedPushSender({
      add: jest.fn().mockRejectedValue(new Error('Redis is down')),
    } as unknown as Queue);

    await expect(sender.send(job)).rejects.toThrow('Redis is down');
  });
});
