import { ServiceUnavailableException } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { FakeRedis } from '../../common/redis/fake-redis.testing';
import type { ChinaPartsDb } from '../china-parts/mysql.provider';
import { HealthController } from './health.controller';

function setup(
  overrides: {
    mongo?: () => Promise<unknown>;
    redis?: () => Promise<unknown>;
    mysql?: () => Promise<void>;
  } = {},
) {
  const redis = new FakeRedis();
  if (overrides.redis)
    jest.spyOn(redis, 'ping').mockImplementation(overrides.redis as never);
  const mongo = {
    db: { command: overrides.mongo ?? jest.fn().mockResolvedValue({ ok: 1 }) },
  } as unknown as Connection;
  const chinaParts = {
    ping: overrides.mysql ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as ChinaPartsDb;
  return new HealthController(mongo, redis.asRedis(), chinaParts);
}

async function readyFailure(controller: HealthController) {
  const error = await controller.ready().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ServiceUnavailableException);
  return (error as ServiceUnavailableException).getResponse() as {
    error: string;
    message: string;
    details: Record<string, string>;
  };
}

describe('HealthController (research R26)', () => {
  afterEach(() => jest.useRealTimers());

  it('liveness answers without touching any dependency', () => {
    const controller = setup({
      mongo: () => Promise.reject(new Error('down')),
      redis: () => Promise.reject(new Error('down')),
      mysql: () => Promise.reject(new Error('down')),
    });
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('readiness reports every dependency up', async () => {
    expect(await setup().ready()).toEqual({
      status: 'ready',
      checks: { mongodb: 'up', redis: 'up', mysql: 'up' },
    });
  });

  it.each([
    ['mongodb', { mongo: () => Promise.reject(new Error('x')) }],
    ['redis', { redis: () => Promise.reject(new Error('x')) }],
    ['mysql', { mysql: () => Promise.reject(new Error('x')) }],
  ])('is 503 NOT_READY naming %s when it is down', async (name, overrides) => {
    const body = await readyFailure(setup(overrides));

    expect(body.error).toBe('NOT_READY');
    expect(body.message).toBe(`Not ready: ${name}`);
    expect(body.details[name]).toBe('down');
  });

  it('names every dependency that is down', async () => {
    const body = await readyFailure(
      setup({
        mongo: () => Promise.reject(new Error('x')),
        mysql: () => Promise.reject(new Error('x')),
      }),
    );
    expect(body.message).toBe('Not ready: mongodb, mysql');
    expect(body.details).toEqual({
      mongodb: 'down',
      redis: 'up',
      mysql: 'down',
    });
  });

  it('counts a dependency that never answers as down, rather than hanging readiness', async () => {
    jest.useFakeTimers();
    const controller = setup({
      mysql: () => new Promise<void>(() => undefined),
    });

    const pending = controller.ready().catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(2_001);
    const error = await pending;

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(
      (
        (error as ServiceUnavailableException).getResponse() as {
          details: Record<string, string>;
        }
      ).details.mysql,
    ).toBe('down');
  });

  it('treats a missing Mongo handle as down', async () => {
    const controller = new HealthController(
      { db: undefined } as unknown as Connection,
      new FakeRedis().asRedis(),
      {
        ping: jest.fn().mockResolvedValue(undefined),
      } as unknown as ChinaPartsDb,
    );
    expect((await readyFailure(controller)).details.mongodb).toBe('down');
  });
});
