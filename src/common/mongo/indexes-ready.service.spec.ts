import type { Connection } from 'mongoose';
import { MongoIndexesReady } from './indexes-ready.service';

function connectionWith(models: Record<string, { init: () => Promise<void> }>) {
  return { models } as unknown as Connection;
}

describe('MongoIndexesReady', () => {
  it('waits for every model to finish building its indexes', async () => {
    const finished: string[] = [];
    const slow = (name: string, ms: number) => ({
      init: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            finished.push(name);
            resolve();
          }, ms),
        ),
    });
    const service = new MongoIndexesReady(
      connectionWith({
        accounts: slow('accounts', 20),
        reels: slow('reels', 5),
      }),
    );

    await service.onModuleInit();

    expect(finished.sort()).toEqual(['accounts', 'reels']);
  });

  it('fails startup when an index cannot be built, instead of running without it', async () => {
    const service = new MongoIndexesReady(
      connectionWith({
        accounts: {
          init: () => Promise.reject(new Error('E11000 duplicate key')),
        },
      }),
    );

    await expect(service.onModuleInit()).rejects.toThrow('duplicate key');
  });

  it('is fine with no models', async () => {
    await expect(
      new MongoIndexesReady(connectionWith({})).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
