import type { ConfigService } from '@nestjs/config';

export type WorkerRole = 'api' | 'worker' | 'all';

/**
 * The API process and the worker process run the same image (plan, "Structure Decision"), and
 * `WORKER_ROLE` decides which of them runs queue processors and scheduled jobs. `api` serves
 * requests only, `worker` runs background work, and `all` (the default) does both, which is what
 * a single-instance setup and the tests want.
 */
export function isWorkerRole(config: ConfigService): boolean {
  const role = config.get<WorkerRole>('WORKER_ROLE') ?? 'all';
  return role === 'worker' || role === 'all';
}
