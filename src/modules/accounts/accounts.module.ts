import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { REQUEST_AUTHENTICATOR } from '../../common/guards/request-authenticator';
import { ChinaPartsModule } from '../china-parts/china-parts.module';
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

/**
 * Reels identities (research R5 to R7) and the China Parts sign-in. Other modules reach accounts
 * through the providers exported here, never through this module's files.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReelsAccount.name, schema: ReelsAccountSchema },
    ]),
    PassportModule,
    ChinaPartsModule,
  ],
  providers: [
    AccountsRepository,
    AccountsService,
    StandingService,
    ChinaPartsTokenStrategy,
    ChinaPartsAuthGuard,
    PassportAuthenticator,
    { provide: REQUEST_AUTHENTICATOR, useExisting: PassportAuthenticator },
  ],
  exports: [
    AccountsRepository,
    AccountsService,
    StandingService,
    REQUEST_AUTHENTICATOR,
  ],
})
export class AccountsModule {}
