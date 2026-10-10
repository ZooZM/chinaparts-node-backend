import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { RoleAwareWorkerHost } from '../../common/queues/role-aware-worker.host';
import { QUEUE_REELS_MODERATION } from '../../common/queues/queue-names';
import {
  MODERATION_JOB,
  MODERATION_JOB_OPTIONS,
} from './moderation/moderation-job';
import { ReelsModerationService } from './reels-moderation.service';

/** Reels stuck pending for longer than this are candidates for the sweep. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
/** How often the sweep scans for stuck reels. */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * A thin BullMQ wrapper: all moderation logic lives in `ReelsModerationService`. It owns pulling
 * jobs off the queue, and the periodic sweep that re-enqueues reels stuck pending (a Redis
 * hiccup at enqueue time, a worker crash mid-job, or retries that ran out during a provider
 * outage), failing closed and never open (FR-031).
 *
 * Runs only in a worker process (`WORKER_ROLE`), see `RoleAwareWorkerHost`.
 */
@Injectable()
@Processor(QUEUE_REELS_MODERATION, { autorun: false })
export class ReelsModerationProcessor extends RoleAwareWorkerHost {
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly moderation: ReelsModerationService,
    @InjectQueue(QUEUE_REELS_MODERATION) private readonly queue: Queue,
    config: ConfigService,
  ) {
    super(config);
  }

  protected onWorkerStart(): void {
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  protected onWorkerStop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async process(job: Job<{ reelId: string }>): Promise<void> {
    // A thrown error is the point: the queue's retry policy takes over and the reel stays pending.
    await this.moderation.moderateReel(job.data.reelId);
  }

  /** Re-enqueues every stale pending reel. Exposed for tests. */
  async sweep(): Promise<void> {
    try {
      const staleIds =
        await this.moderation.findStalePendingIds(STALE_THRESHOLD_MS);
      for (const reelId of staleIds) {
        await this.queue.add(
          MODERATION_JOB,
          { reelId },
          { jobId: reelId, ...MODERATION_JOB_OPTIONS },
        );
      }
      if (staleIds.length > 0) {
        this.logger.log(`Sweep re-enqueued ${staleIds.length} stale reel(s)`);
      }
    } catch (error) {
      this.logger.warn(`Sweep failed: ${String(error)}`);
    }
  }
}
