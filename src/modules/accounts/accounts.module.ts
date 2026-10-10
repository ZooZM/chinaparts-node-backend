import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { REQUEST_AUTHENTICATOR } from '../../common/guards/request-authenticator';
import {
  QUEUE_ACCOUNTS_SYNC,
  QUEUE_MEDIA_VISIBILITY,
} from '../../common/queues/queue-names';
import { ChinaPartsModule } from '../china-parts/china-parts.module';
import { AccountsController } from './accounts.controller';
import { AccountsRepository } from './accounts.repository';
import { AccountsService } from './accounts.service';
import { ChinaPartsAuthGuard } from './china-parts-auth.guard';
import { ChinaPartsTokenStrategy } from './china-parts-token.strategy';
import { PassportAuthenticator } from './passport-authenticator';
import {
  ReelsAccount,
  ReelsAccountSchema,
} from './schemas/reels-account.schema';
import { StandingService } from './standing.service';
import { StandingSyncProcessor } from './standing-sync.processor';

/**
 * Reels identities (research R5 to R7) and the China Parts sign-in. Other modules reach accounts
 * through the providers exported here, never through this module's files.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReelsAccount.name, schema: ReelsAccountSchema },
    ]),
    BullModule.registerQueue({ name: QUEUE_ACCOUNTS_SYNC }),
    // Producer side only: the sync enqueues a job for every account whose standing changed.
    BullModule.registerQueue({ name: QUEUE_MEDIA_VISIBILITY }),
    PassportModule,
    ChinaPartsModule,
  ],
  controllers: [AccountsController],
  providers: [
    AccountsRepository,
    AccountsService,
    StandingService,
    StandingSyncProcessor,
    ChinaPartsTokenStrategy,
    ChinaPartsAuthGuard,
    PassportAuthenticator,
    { provide: REQUEST_AUTHENTICATOR, useExisting: PassportAuthenticator },
  ],
  exports: [
    AccountsRepository,
    AccountsService,
    StandingService,
    StandingSyncProcessor,
    REQUEST_AUTHENTICATOR,
  ],
})
export class AccountsModule {}
