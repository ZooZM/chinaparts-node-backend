import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

export interface ThrottleRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Counts a hit and sets the window's expiry in one atomic step. Two separate commands could be
 * interrupted between them, leaving a counter that never expires and blocks a caller for good.
 */
const HIT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

function parseHit(value: unknown): { hits: number; ttlMs: number } {
  if (
    !Array.isArray(value) ||
    typeof value[0] !== 'number' ||
    typeof value[1] !== 'number'
  ) {
    throw new Error('Unexpected reply from the throttler script');
  }
  return { hits: value[0], ttlMs: value[1] };
}

/**
 * Rate-limit counters shared by every API instance (constitution VI), implementing the interface
 * `@nestjs/throttler` expects. `ttl` and `blockDuration` are milliseconds.
 */
@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const counterKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${counterKey}:block`;

    const blockTtlMs = await this.redis.pttl(blockKey);
    if (blockTtlMs > 0) {
      const blockSeconds = Math.ceil(blockTtlMs / 1000);
      return {
        totalHits: limit + 1,
        timeToExpire: blockSeconds,
        isBlocked: true,
        timeToBlockExpire: blockSeconds,
      };
    }

    const { hits, ttlMs } = parseHit(
      await this.redis.eval(HIT_SCRIPT, 1, counterKey, ttl),
    );
    const timeToExpire = Math.ceil((ttlMs > 0 ? ttlMs : ttl) / 1000);

    if (hits > limit) {
      // A block only exists when the caller asked for one: `SET ... PX 0` is an error in Redis.
      if (blockDuration > 0) {
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
      }
      return {
        totalHits: hits,
        timeToExpire,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    return {
      totalHits: hits,
      timeToExpire,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
