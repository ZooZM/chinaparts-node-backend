import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Injection token for the shared Redis client (research R23). */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * One Redis connection for caches, sets and counters, injected everywhere instead of
 * re-instantiated per feature (constitution I). BullMQ and the throttler storage keep their own
 * connections, because BullMQ needs `maxRetriesPerRequest: null` and the throttler is created
 * before the container is ready.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService): Redis =>
        new Redis(
          configService.get<string>('REDIS_URL') || 'redis://localhost:6379',
        ),
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
