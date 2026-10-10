import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module';
import { GoodStandingGuard } from './common/guards/good-standing.guard';
import { IdentityThrottlerGuard } from './common/guards/identity-throttler.guard';
import { IpThrottlerGuard } from './common/guards/ip-throttler.guard';
import { ViewerAuthGuard } from './common/guards/viewer-auth.guard';
import { RedisModule } from './common/redis/redis.module';
import { StorageModule } from './common/storage/storage.module';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { envValidationSchema } from './config/env.validation';
import { AccountsModule } from './modules/accounts/accounts.module';
import { ChinaPartsModule } from './modules/china-parts/china-parts.module';
import { HealthModule } from './modules/health/health.module';
import { ReelsModule } from './modules/reels/reels.module';

@Module({
  imports: [
    // Every environment variable is validated here at boot (constitution IV).
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
      }),
    }),

    // Queues. BullMQ workers use blocking commands, which are incompatible with ioredis's default
    // per-request retry cap, hence `maxRetriesPerRequest: null`.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL') || 'redis://localhost:6379',
          maxRetriesPerRequest: null,
        },
      }),
    }),

    // Rate-limit counters live in Redis so every API instance shares them (constitution VI). The
    // package's own guard is deliberately not registered: the custom guards below use this storage
    // directly, with limits that depend on who is calling (research R10).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new RedisThrottlerStorage(
          config.get<string>('REDIS_URL') || 'redis://localhost:6379',
        ),
      }),
    }),

    RedisModule,
    CommonModule,
    StorageModule,
    ChinaPartsModule,
    AccountsModule,
    HealthModule,
    ReelsModule,
  ],
  providers: [
    // The global guard chain. THE ORDER IS LOAD-BEARING (research R10):
    // 1. the per-IP limit runs before any token lookup, so invented tokens cannot reach China
    //    Parts' database without limit;
    // 2. identity is resolved, and the route's access level enforced;
    // 3. limits that depend on who is calling need that identity;
    // 4. good standing needs the resolved user.
    { provide: APP_GUARD, useClass: IpThrottlerGuard },
    { provide: APP_GUARD, useClass: ViewerAuthGuard },
    { provide: APP_GUARD, useClass: IdentityThrottlerGuard },
    { provide: APP_GUARD, useClass: GoodStandingGuard },
  ],
})
export class AppModule {}
