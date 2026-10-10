import { WorkerHost } from '@nestjs/bullmq';
import {
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { isWorkerRole } from '../config/worker-role';

/**
 * A BullMQ processor that only starts working in a worker process.
 *
 * `@nestjs/bullmq` creates a Worker for every `@Processor` it finds. Declare processors with
 * `{ autorun: false }`: the Worker then exists but stays idle until this base class starts it,
 * and only when `WORKER_ROLE` is `worker` or `all` (research R10, plan "Structure Decision").
 * An API-only instance therefore never pulls a job.
 *
 * Subclasses that schedule their own jobs (a repeating sync, a sweep) do it in `onWorkerStart`,
 * which runs under the same condition, and release them in `onWorkerStop`.
 */
export abstract class RoleAwareWorkerHost
  extends WorkerHost
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  protected readonly logger = new Logger(this.constructor.name);

  protected constructor(private readonly roleConfig: ConfigService) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!isWorkerRole(this.roleConfig)) return;
    // `run()` resolves when the worker is eventually closed, so it is not awaited here.
    this.worker.run().catch((error: unknown) => {
      this.logger.error(`Worker stopped: ${String(error)}`);
    });
    await this.onWorkerStart();
  }

  async onApplicationShutdown(): Promise<void> {
    if (!isWorkerRole(this.roleConfig)) return;
    await this.onWorkerStop();
  }

  /** Called once, in worker processes only, after the worker has started. */
  protected onWorkerStart(): Promise<void> | void {}

  /** Called on shutdown, in worker processes only. */
  protected onWorkerStop(): Promise<void> | void {}
}
