import { Injectable, Logger } from '@nestjs/common';
import type { PushJob, PushSender } from './push-sender';

/** Used until real delivery is wired in: records that a push would have been sent. */
@Injectable()
export class NoopPushSender implements PushSender {
  private readonly logger = new Logger(NoopPushSender.name);

  send(job: PushJob): Promise<void> {
    this.logger.debug(
      `push skipped (no sender): ${job.type} to ${job.recipientId}`,
    );
    return Promise.resolve();
  }
}
