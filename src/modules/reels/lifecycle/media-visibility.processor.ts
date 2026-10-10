import { Processor } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { QUEUE_MEDIA_VISIBILITY } from '../../../common/queues/queue-names';
import { RoleAwareWorkerHost } from '../../../common/queues/role-aware-worker.host';
import { REELS_REPOSITORY } from '../reels.repository';
import type { ReelsRepository } from '../reels.repository';
import type { MediaVisibilityJob } from '../../../common/queues/media-visibility-job';
import { ReelLifecycleService } from './reel-lifecycle.service';

const PAGE_SIZE = 100;

/**
 * Moves an account's published reels' files to where the rule puts them, after the account's
 * standing changed (FR-009, FR-014): public while the reel is published and the creator is in good
 * standing, private otherwise. The sync enqueues one job per account whose standing changed.
 *
 * It decides nothing: `ReelLifecycleService.syncMediaVisibility` applies the rule to each reel,
 * and is idempotent, so a retried job or a job for an account that has not really changed is
 * harmless. Runs only in a worker process (`WORKER_ROLE`).
 */
@Injectable()
@Processor(QUEUE_MEDIA_VISIBILITY, { autorun: false })
export class MediaVisibilityProcessor extends RoleAwareWorkerHost {
  constructor(
    @Inject(REELS_REPOSITORY) private readonly reels: ReelsRepository,
    private readonly lifecycle: ReelLifecycleService,
    config: ConfigService,
  ) {
    super(config);
  }

  async process(job: Job<MediaVisibilityJob>): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const page = await this.reels.listPublishedByCreator(
        job.data.accountId,
        after,
        PAGE_SIZE,
      );
      for (const reel of page) {
        // A failure fails the job; the retry starts over and the reels already put right are skipped.
        await this.lifecycle.syncMediaVisibility(reel);
      }
      if (page.length < PAGE_SIZE) return;
      after = page[page.length - 1].id;
    }
  }
}
