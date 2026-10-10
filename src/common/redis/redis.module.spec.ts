import type Redis from 'ioredis';
import { RedisShutdown } from './redis.module';

describe('RedisShutdown', () => {
  function clientWith(quitResult: () => Promise<'OK'>) {
    const quit = jest.fn(quitResult);
    const disconnect = jest.fn();
    return {
      client: { quit, disconnect } as unknown as Redis,
      quit,
      disconnect,
    };
  }

  it('quits the shared client so pending replies finish', async () => {
    const { client, quit, disconnect } = clientWith(() =>
      Promise.resolve('OK'),
    );

    await new RedisShutdown(client).onApplicationShutdown();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('releases the socket when the connection is already gone', async () => {
    const { client, disconnect } = clientWith(() =>
      Promise.reject(new Error('Connection is closed.')),
    );

    await expect(
      new RedisShutdown(client).onApplicationShutdown(),
    ).resolves.toBeUndefined();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
