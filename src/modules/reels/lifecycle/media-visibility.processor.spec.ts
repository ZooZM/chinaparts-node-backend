import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { MediaVisibilityProcessor } from './media-visibility.processor';
import type { MediaVisibilityJob } from '../../../common/queues/media-visibility-job';
import type { ReelLifecycleService } from './reel-lifecycle.service';
import type { ReelSnapshot, ReelsRepository } from '../reels.repository';

function snapshot(id: string): ReelSnapshot {
  return {
    id,
    creatorId: 'account-1',
    status: 'published',
    media: {
      videoKey: `reels/${id}/video.mp4`,
      thumbnailKey: `reels/${id}/thumb.jpg`,
      location: 'public',
    },
    hashtagsNormalized: [],
  };
}

function setup(reelIds: string[]) {
  const all = reelIds.map(snapshot);
  const listPublishedByCreator = jest.fn(
    (_creatorId: string, afterId: string | null, limit: number) =>
      Promise.resolve(
        all
          .filter((reel) => afterId === null || reel.id > afterId)
          .slice(0, limit),
      ),
  );
  const syncMediaVisibility = jest.fn().mockResolvedValue(undefined);
  const processor = new MediaVisibilityProcessor(
    { listPublishedByCreator } as unknown as ReelsRepository,
    { syncMediaVisibility } as unknown as ReelLifecycleService,
    { get: () => 'api' } as unknown as ConfigService,
  );
  const run = (accountId = 'account-1') =>
    processor.process({ data: { accountId } } as Job<MediaVisibilityJob>);
  return { run, listPublishedByCreator, syncMediaVisibility };
}

describe('MediaVisibilityProcessor (research R12)', () => {
  it('re-applies the rule to every published reel of the account', async () => {
    const { run, syncMediaVisibility } = setup(['a', 'b', 'c']);

    await run();

    expect(
      syncMediaVisibility.mock.calls.map(([reel]: [ReelSnapshot]) => reel.id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('asks for the reels of the account in the job, page by page, until there are no more', async () => {
    const ids = Array.from({ length: 250 }, (_, index) =>
      String(index).padStart(4, '0'),
    );
    const { run, listPublishedByCreator, syncMediaVisibility } = setup(ids);

    await run('account-9');

    expect(syncMediaVisibility).toHaveBeenCalledTimes(250);
    expect(listPublishedByCreator.mock.calls.map((call) => call[0])).toEqual([
      'account-9',
      'account-9',
      'account-9',
    ]);
    // 100, 100, 50: the last short page ends it, with no extra empty read.
    expect(listPublishedByCreator.mock.calls.map((call) => call[1])).toEqual([
      null,
      '0099',
      '0199',
    ]);
  });

  it('does nothing for an account with no published reels', async () => {
    const { run, syncMediaVisibility } = setup([]);

    await run();

    expect(syncMediaVisibility).not.toHaveBeenCalled();
  });

  it('fails the job when a reel cannot be put right, so the queue retries it', async () => {
    const { run, syncMediaVisibility } = setup(['a', 'b']);
    syncMediaVisibility.mockRejectedValueOnce(new Error('storage is down'));

    await expect(run()).rejects.toThrow('storage is down');
  });
});
