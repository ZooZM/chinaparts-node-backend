import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import type { AccountCleanupJob } from '../../../common/queues/account-cleanup-job';
import { QUEUE_ACCOUNTS_CLEANUP } from '../../../common/queues/queue-names';
import { RoleAwareWorkerHost } from '../../../common/queues/role-aware-worker.host';
import { AccountCleanupService } from './account-cleanup.service';

/**
 * Runs the cleanup of one deleted account (FR-010). The standing sync queues a job when an account
 * has been missing from China Parts on two cycles in a row. It lives in the reels module because it
 * deletes reels data, which the accounts module must not know about.
 *
 * A failure is thrown, so the queue retries it; every step is safe to repeat. Runs only in a worker
 * process (`WORKER_ROLE`).
 */
@Injectable()
@Processor(QUEUE_ACCOUNTS_CLEANUP, { autorun: false })
export class AccountCleanupProcessor extends RoleAwareWorkerHost {
  constructor(
    private readonly cleanup: AccountCleanupService,
    config: ConfigService,
  ) {
    super(config);
  }

  async process(job: Job<AccountCleanupJob>): Promise<void> {
    await this.cleanup.cleanUp(job.data.accountId);
  }
}
