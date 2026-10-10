/** What a media-visibility job carries: the account whose reels' files may need to move. */
export interface MediaVisibilityJob {
  accountId: string;
}

export const MEDIA_VISIBILITY_JOB = 'sync-account';

/**
 * Re-applying the rule is idempotent, so a failed job is simply retried. Jobs are removed when
 * they finish, so a job id that is reused later (the next standing change) is never blocked by an
 * old one.
 */
export const MEDIA_VISIBILITY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;
