import { Logger } from '@nestjs/common';
import type { StandingService } from '../../accounts/standing.service';
import type { ReelsService } from '../reels.service';
import type { AccountCleanupRepository } from './account-cleanup.repository';
import { AccountCleanupService } from './account-cleanup.service';

const accountId = '650000000000000000000001';

function setup(reelPages: string[][] = [[]]) {
  const order: string[] = [];
  const step =
    (name: string, result: unknown = 0) =>
    () => {
      order.push(name);
      return Promise.resolve(result);
    };
  let page = 0;
  const cleanup = {
    listReelIds: jest.fn(() => {
      order.push('listReelIds');
      return Promise.resolve(reelPages[page++] ?? []);
    }),
    removeComments: jest.fn(step('comments', 3)),
    removeLikes: jest.fn(step('likes', 2)),
    removeFollows: jest.fn(step('follows', 4)),
    removeReelReports: jest.fn(step('reports', 1)),
    removeOtherRelations: jest.fn(step('relations')),
    removeFromBlockLists: jest.fn(step('blocks')),
    removeNotificationEvents: jest.fn(step('events')),
    forgetTapper: jest.fn(step('taps')),
    deleteAccount: jest.fn(step('account')),
  };
  const reels = {
    deleteReelOf: jest.fn((_owner: string, id: string) => {
      order.push(`reel ${id}`);
      return Promise.resolve({ deleted: true });
    }),
  };
  const standing = { remove: jest.fn(step('standing')) };
  const service = new AccountCleanupService(
    cleanup as unknown as AccountCleanupRepository,
    reels as unknown as ReelsService,
    standing as unknown as StandingService,
  );
  return { service, cleanup, reels, standing, order };
}

describe('AccountCleanupService (FR-010)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('deletes the reels first, through the same path the owner uses, then the footprint, then the account', async () => {
    const { service, order, reels } = setup([['r1', 'r2'], []]);

    await service.cleanUp(accountId);

    expect(reels.deleteReelOf.mock.calls).toEqual([
      [accountId, 'r1'],
      [accountId, 'r2'],
    ]);
    expect(order).toEqual([
      'listReelIds',
      'reel r1',
      'reel r2',
      'listReelIds',
      'comments',
      'likes',
      'follows',
      'reports',
      'relations',
      'blocks',
      'events',
      'taps',
      'standing',
      'account',
    ]);
  });

  it('pages through every reel the account made', async () => {
    const { service, cleanup, reels } = setup([['a', 'b'], ['c'], []]);

    await service.cleanUp(accountId);

    expect(reels.deleteReelOf).toHaveBeenCalledTimes(3);
    expect(cleanup.listReelIds.mock.calls).toEqual([
      [accountId, null, 200],
      [accountId, 'b', 200],
      [accountId, 'c', 200],
    ]);
  });

  it('leaves the account in place until everything else is done, so a failure can be retried', async () => {
    const { service, cleanup } = setup();
    cleanup.removeFollows.mockRejectedValue(new Error('mongo is down'));

    await expect(service.cleanUp(accountId)).rejects.toThrow('mongo is down');

    expect(cleanup.deleteAccount).not.toHaveBeenCalled();
    expect(cleanup.removeReelReports).not.toHaveBeenCalled();
  });

  it('stops at a reel that cannot be deleted, and the retry starts again from the first', async () => {
    const { service, reels, cleanup } = setup([['r1', 'r2'], []]);
    reels.deleteReelOf.mockRejectedValueOnce(new Error('storage is down'));

    await expect(service.cleanUp(accountId)).rejects.toThrow('storage is down');
    expect(cleanup.removeComments).not.toHaveBeenCalled();
  });

  it('removes the account from the not-in-good-standing set as it goes', async () => {
    const { service, standing } = setup();
    await service.cleanUp(accountId);
    expect(standing.remove).toHaveBeenCalledWith(accountId);
  });

  it('is fine for an account with nothing at all', async () => {
    const { service, reels, cleanup } = setup();

    await expect(service.cleanUp(accountId)).resolves.toBeUndefined();

    expect(reels.deleteReelOf).not.toHaveBeenCalled();
    expect(cleanup.deleteAccount).toHaveBeenCalledWith(accountId);
  });
});
