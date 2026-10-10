import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export const STANDING_EXCLUDED_KEY = 'standing:excluded';

/** How long a process trusts its own copy of the set. Well inside the 15 minutes of FR-009. */
const LOCAL_CACHE_MS = 10_000;
const BATCH_SIZE = 5_000;

/**
 * The set of reels accounts that are not in good standing (research R7), kept in Redis so every API
 * instance sees the same set. Every read of content removes these accounts' content for everyone
 * but the owner, which is what makes FR-009 hold without new query paths or indexes.
 */
@Injectable()
export class StandingService {
  private local: { ids: ReadonlySet<string>; loadedAt: number } | null = null;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** A single, always-fresh check (used where a stale answer would leave media public). */
  async isExcluded(accountId: string): Promise<boolean> {
    return (await this.redis.sismember(STANDING_EXCLUDED_KEY, accountId)) === 1;
  }

  /** The whole set, cached in memory for a few seconds because every feed read needs it. */
  async members(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.local && now - this.local.loadedAt < LOCAL_CACHE_MS) {
      return this.local.ids;
    }
    const ids: ReadonlySet<string> = new Set(
      await this.redis.smembers(STANDING_EXCLUDED_KEY),
    );
    this.local = { ids, loadedAt: now };
    return ids;
  }

  async add(accountId: string): Promise<void> {
    await this.redis.sadd(STANDING_EXCLUDED_KEY, accountId);
    this.local = null;
  }

  async remove(accountId: string): Promise<void> {
    await this.redis.srem(STANDING_EXCLUDED_KEY, accountId);
    this.local = null;
  }

  /**
   * Swaps in a freshly built set atomically: it is built under a temporary key and renamed over
   * the live one, so a reader never sees a half-built set (and never an empty one mid-rebuild).
   */
  async replaceAll(accountIds: string[]): Promise<void> {
    if (accountIds.length === 0) {
      await this.redis.del(STANDING_EXCLUDED_KEY);
      this.local = null;
      return;
    }
    const temporary = `${STANDING_EXCLUDED_KEY}:tmp:${randomUUID()}`;
    try {
      for (let index = 0; index < accountIds.length; index += BATCH_SIZE) {
        await this.redis.sadd(
          temporary,
          ...accountIds.slice(index, index + BATCH_SIZE),
        );
      }
      await this.redis.rename(temporary, STANDING_EXCLUDED_KEY);
    } catch (error) {
      await this.redis.del(temporary).catch(() => undefined);
      throw error;
    }
    this.local = null;
  }
}
