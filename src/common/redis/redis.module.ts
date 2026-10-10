import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Injection token for the shared Redis client (research R23). */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Closes the shared client when the application shuts down, after every other provider has had its
 * own shutdown hook (queues and workers drain first), so a graceful stop leaves no connection
 * behind. `quit` lets pending replies finish; if the connection is already gone it throws, and the
 * socket is released with `disconnect`.
 */
@Injectable()
export class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

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
    RedisShutdown,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
