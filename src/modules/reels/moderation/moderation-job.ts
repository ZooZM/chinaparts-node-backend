export const MODERATION_JOB = 'moderate';

/**
 * Screening is retried with exponential backoff, and fails closed: a reel is never published
 * without a clean verdict (FR-031). The jobs are removed when they finish, whether they succeed or
 * exhaust their attempts, because a job id (the reel id) that still exists blocks `queue.add` from
 * creating another. That is what lets the sweep re-enqueue a reel whose retries ran out during a
 * long provider outage.
 */
export const MODERATION_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;
