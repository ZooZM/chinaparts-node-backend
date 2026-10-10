import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChinaPartsAccountsRepository } from './chinaparts-accounts.repository';
import { ChinaPartsConfig } from './china-parts.config';
import { ChinaPartsMediaRepository } from './media.repository';
import {
  CHINAPARTS_POOL,
  ChinaPartsDb,
  createChinaPartsPool,
} from './mysql.provider';
import { TokensRepository } from './tokens.repository';

/**
 * The only module that talks to China Parts' database (constitution, permitted exception 1).
 * Other modules inject its repositories and never open a connection of their own.
 */
@Module({
  providers: [
    {
      provide: CHINAPARTS_POOL,
      inject: [ConfigService],
      useFactory: createChinaPartsPool,
    },
    ChinaPartsDb,
    ChinaPartsConfig,
    ChinaPartsMediaRepository,
    TokensRepository,
    ChinaPartsAccountsRepository,
  ],
  exports: [
    ChinaPartsDb,
    ChinaPartsConfig,
    TokensRepository,
    ChinaPartsAccountsRepository,
    ChinaPartsMediaRepository,
  ],
})
export class ChinaPartsModule {}
