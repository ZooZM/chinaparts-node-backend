import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Job } from 'bullmq';
import { ReelsModerationService } from './reels-moderation.service';

export const REELS_MODERATION_QUEUE = 'reels-moderation';
/** R17: reels stuck pending past this age are candidates for the sweep. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
/** R17: how often the sweep scans for stuck reels. */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * v3 (R17): thin BullMQ wrapper — all moderation logic lives in
 * `ReelsModerationService` so it can be exercised without a live queue
 * (see that file's docstring). This class owns only: pulling jobs off the
 * real queue, and the periodic sweep that re-enqueues reels stuck pending
 * (Redis hiccup at enqueue time, or a worker crash mid-job — fail-closed,
 * never fail-open).
 */
@Injectable()
@Processor(REELS_MODERATION_QUEUE)
export class ReelsModerationProcessor
  extends WorkerHost
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReelsModerationProcessor.name);
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly moderation: ReelsModerationService,
    @InjectQueue(REELS_MODERATION_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // NOTE: the actual BullMQ Worker (bound to this class's `process()`) is
  // created externally by `@nestjs/bullmq`'s `BullExplorer` — a
  // `DiscoveryService`-driven registrar that scans for `@Processor`-
  // decorated providers at application bootstrap. `WorkerHost` itself
  // declares no lifecycle hooks (just the `worker` getter), so this
  // `onModuleInit` only ever needs to own the sweep timer.
  onModuleInit(): void {
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async process(job: Job<{ reelId: string }>): Promise<void> {
    // Fail-closed (FR-066): a thrown error here is the point — BullMQ's
    // retry policy (registered in reels.module.ts) takes over and the reel
    // simply stays pending_moderation.
    await this.moderation.moderateReel(job.data.reelId);
  }

  private async sweep(): Promise<void> {
    try {
      const staleIds = await this.moderation.findStalePendingIds(
        STALE_THRESHOLD_MS,
      );
      for (const reelId of staleIds) {
        await this.queue.add('moderate', { reelId }, { jobId: reelId });
      }
      if (staleIds.length > 0) {
        this.logger.log(`Sweep re-enqueued ${staleIds.length} stale reel(s)`);
      }
    } catch (err) {
      this.logger.warn(`Sweep failed: ${(err as Error).message}`);
    }
  }
}
