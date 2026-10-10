import { FakeRedis } from '../../common/redis/fake-redis.testing';
import { STANDING_EXCLUDED_KEY, StandingService } from './standing.service';

describe('StandingService', () => {
  let redis: FakeRedis;
  let service: StandingService;

  beforeEach(() => {
    jest.useFakeTimers();
    redis = new FakeRedis();
    service = new StandingService(redis.asRedis());
  });

  afterEach(() => jest.useRealTimers());

  it('adds and removes accounts, and answers a single check from Redis', async () => {
    await service.add('a1');
    expect(await service.isExcluded('a1')).toBe(true);
    expect(await service.isExcluded('a2')).toBe(false);

    await service.remove('a1');
    expect(await service.isExcluded('a1')).toBe(false);
  });

  it('reads the whole set, and caches it in memory for a few seconds', async () => {
    await service.add('a1');
    const spy = jest.spyOn(redis, 'smembers');

    expect([...(await service.members())]).toEqual(['a1']);
    await service.members();
    await service.members();
    expect(spy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10_001);
    await service.members();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('sees its own changes at once, because a write drops the local copy', async () => {
    await service.add('a1');
    expect([...(await service.members())]).toEqual(['a1']);

    await service.add('a2');
    expect([...(await service.members())].sort()).toEqual(['a1', 'a2']);

    await service.remove('a1');
    expect([...(await service.members())]).toEqual(['a2']);
  });

  describe('replaceAll', () => {
    it('swaps in a new set and drops the old members', async () => {
      await service.add('old');
      await service.replaceAll(['n1', 'n2']);
      expect([...(await service.members())].sort()).toEqual(['n1', 'n2']);
      expect(await service.isExcluded('old')).toBe(false);
    });

    it('builds under a temporary key and renames it, leaving no temporary key behind', async () => {
      const rename = jest.spyOn(redis, 'rename');
      await service.replaceAll(['n1']);

      expect(rename).toHaveBeenCalledTimes(1);
      const [source, destination] = rename.mock.calls[0];
      expect(source).toMatch(new RegExp(`^${STANDING_EXCLUDED_KEY}:tmp:`));
      expect(destination).toBe(STANDING_EXCLUDED_KEY);
      expect(redis.keys()).toEqual([STANDING_EXCLUDED_KEY]);
    });

    it('clears the set when nothing is excluded', async () => {
      await service.add('a1');
      await service.replaceAll([]);
      expect([...(await service.members())]).toEqual([]);
      expect(redis.keys()).toEqual([]);
    });

    it('adds in batches', async () => {
      const sadd = jest.spyOn(redis, 'sadd');
      const ids = Array.from({ length: 12_000 }, (_, index) => `id${index}`);

      await service.replaceAll(ids);

      expect(sadd.mock.calls.map((call) => call.length - 1)).toEqual([
        5000, 5000, 2000,
      ]);
      expect((await service.members()).size).toBe(12_000);
    });

    it('cleans up the temporary key and rethrows when the swap fails', async () => {
      jest.spyOn(redis, 'rename').mockRejectedValue(new Error('boom'));
      const del = jest.spyOn(redis, 'del');

      await expect(service.replaceAll(['n1'])).rejects.toThrow('boom');

      expect(del).toHaveBeenCalledTimes(1);
      expect(redis.keys()).toEqual([]);
    });
  });
});
