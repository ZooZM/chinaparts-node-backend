import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

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
  ) {
    const counterKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:${throttlerName}:${key}:block`;

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

    const totalHits = await this.redis.incr(counterKey);
    if (totalHits === 1) {
      await this.redis.pexpire(counterKey, ttl);
    }
    const ttlRemainingMs = await this.redis.pttl(counterKey);
    const timeToExpire = Math.ceil(
      (ttlRemainingMs > 0 ? ttlRemainingMs : ttl) / 1000,
    );

    if (totalHits > limit) {
      await this.redis.set(blockKey, '1', 'PX', blockDuration);
      return {
        totalHits,
        timeToExpire,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockDuration / 1000),
      };
    }

    return {
      totalHits,
      timeToExpire,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  async onApplicationShutdown() {
    await this.redis.quit();
  }
}
