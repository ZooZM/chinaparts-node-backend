/** What an account-cleanup job carries: the reels account to remove. */
export interface AccountCleanupJob {
  accountId: string;
}

export const ACCOUNT_CLEANUP_JOB = 'cleanup-account';

/**
 * Cleanup is retried with backoff, and every step is safe to repeat. A finished job is removed, so
 * the same account's job id can be queued again if it is ever needed.
 */
export const ACCOUNT_CLEANUP_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;
