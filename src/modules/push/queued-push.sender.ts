import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_REELS_PUSH } from '../../common/queues/queue-names';
import type { PushJob, PushSender } from './push-sender';

export const PUSH_JOB = 'push';

/**
 * Delivery is retried, because a push can fail for reasons that pass: China Parts' database or
 * Firebase being briefly unreachable. After three tries the job is kept for a while, for a person
 * to look at, and then forgotten: a notification that cannot be delivered is not worth more.
 */
export const PUSH_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

/**
 * Hands a notification to the queue and returns, so that sending never slows or fails the like,
 * follow or publish that caused it (FR-066). The job carries ids only (research R14): what it says
 * and which devices it goes to are worked out when it is delivered, from the current state.
 */
@Injectable()
export class QueuedPushSender implements PushSender {
  constructor(@InjectQueue(QUEUE_REELS_PUSH) private readonly queue: Queue) {}

  async send(job: PushJob): Promise<void> {
    await this.queue.add(PUSH_JOB, job, PUSH_JOB_OPTIONS);
  }
}
