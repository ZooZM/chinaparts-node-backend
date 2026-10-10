import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { AccountCleanupJob } from '../../../common/queues/account-cleanup-job';
import { AccountCleanupProcessor } from './account-cleanup.processor';
import type { AccountCleanupService } from './account-cleanup.service';

describe('AccountCleanupProcessor (FR-010)', () => {
  const run = (cleanUp: jest.Mock) =>
    new AccountCleanupProcessor(
      { cleanUp } as unknown as AccountCleanupService,
      { get: () => 'worker' } as unknown as ConfigService,
    ).process({ data: { accountId: 'a1' } } as Job<AccountCleanupJob>);

  it('cleans up the account in the job', async () => {
    const cleanUp = jest.fn().mockResolvedValue(undefined);
    await run(cleanUp);
    expect(cleanUp).toHaveBeenCalledWith('a1');
  });

  it('lets a failure through, so the queue retries it', async () => {
    await expect(
      run(jest.fn().mockRejectedValue(new Error('storage is down'))),
    ).rejects.toThrow('storage is down');
  });
});
