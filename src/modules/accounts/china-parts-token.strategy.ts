import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import Redis from 'ioredis';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Strategy as BearerStrategy } from 'passport-http-bearer';
import { ErrorCode } from '../../common/errors/error-codes';
import type {
  AccountType,
  AuthenticatedUser,
  Locale,
  Standing,
} from '../../common/http/viewer-request';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import {
  ChinaPartsAccount,
  ChinaPartsAccountsRepository,
} from '../china-parts/chinaparts-accounts.repository';
import { ChinaPartsConfig } from '../china-parts/china-parts.config';
import {
  PersonalAccessToken,
  TokensRepository,
} from '../china-parts/tokens.repository';
import { AccountsService } from './accounts.service';
import { StandingService } from './standing.service';

/** How long a caller's standing and display data are trusted (research R7: lost within a minute). */
const ACCOUNT_CACHE_SECONDS = 60;
/** Far beyond any real token, so a giant header never gets hashed or looked up. */
const MAX_TOKEN_LENGTH = 512;

interface CachedToken {
  accountType: AccountType;
  externalId: number;
}

interface CachedAccount {
  accountId: string;
  standing: Standing;
  locale: Locale;
  preferredCurrency: string | null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseCachedToken(raw: string | null): CachedToken | null {
  const value = parseJson(raw);
  if (
    isRecord(value) &&
    (value.accountType === 'customer' || value.accountType === 'seller') &&
    typeof value.externalId === 'number'
  ) {
    return { accountType: value.accountType, externalId: value.externalId };
  }
  return null;
}

function parseCachedAccount(raw: string | null): CachedAccount | null {
  const value = parseJson(raw);
  if (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    (value.standing === 'good' ||
      value.standing === 'suspended' ||
      value.standing === 'deleted') &&
    (value.locale === 'ar' || value.locale === 'en') &&
    (typeof value.preferredCurrency === 'string' ||
      value.preferredCurrency === null)
  ) {
    return {
      accountId: value.accountId,
      standing: value.standing,
      locale: value.locale,
      preferredCurrency: value.preferredCurrency,
    };
  }
  return null;
}

/**
 * Validates the Laravel Sanctum token China Parts' apps already send (research R4), so users have
 * single sign-on with no reels-specific login (FR-003). It only ever reads: `last_used_at` is not
 * touched, because the service has no write access to China Parts.
 *
 * A token that does not validate is `401 AUTH_INVALID_SESSION`. If China Parts cannot be reached
 * the 503 from the database layer propagates, so an outage never signs anyone out. This is the
 * one place in the service where authentication is delegated to the host platform
 * (constitution, permitted exception 2).
 */
@Injectable()
export class ChinaPartsTokenStrategy extends PassportStrategy(
  BearerStrategy,
  'chinaparts',
) {
  private readonly tokenCacheSeconds: number;

  constructor(
    private readonly tokens: TokensRepository,
    private readonly chinaParts: ChinaPartsAccountsRepository,
    private readonly chinaPartsConfig: ChinaPartsConfig,
    private readonly accounts: AccountsService,
    private readonly standing: StandingService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    super();
    this.tokenCacheSeconds = config.getOrThrow<number>(
      'AUTH_CACHE_TTL_SECONDS',
    );
  }

  async validate(token: string): Promise<AuthenticatedUser> {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw this.invalid();
    }

    // Keyed by the hash of the whole token, never the token itself (R4 step 5).
    const tokenKey = `auth:tok:${sha256Hex(token)}`;
    const cached = parseCachedToken(await this.redis.get(tokenKey));
    if (cached) return this.loadUser(cached.accountType, cached.externalId);

    const row = await this.findToken(token);
    this.assertUsable(row);
    const accountType = this.chinaPartsConfig.accountTypeOf(row.tokenableType);
    // Admins, and any other kind of token, are refused here (FR-007).
    if (!accountType) throw this.invalid();

    const user = await this.loadUser(accountType, row.tokenableId);
    const entry: CachedToken = { accountType, externalId: row.tokenableId };
    await this.redis.set(
      tokenKey,
      JSON.stringify(entry),
      'EX',
      this.tokenCacheSeconds,
    );
    return user;
  }

  /** R4 steps 1 and 2: `id|secret` is looked up by id and compared in constant time, like Sanctum. */
  private async findToken(token: string): Promise<PersonalAccessToken> {
    const separator = token.indexOf('|');
    if (separator < 0) {
      const row = await this.tokens.findByHash(sha256Hex(token));
      if (!row) throw this.invalid();
      return row;
    }

    const idPart = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    if (!/^\d{1,15}$/.test(idPart) || secret.length === 0) throw this.invalid();

    const row = await this.tokens.findById(Number(idPart));
    if (!row) throw this.invalid();

    const expected = Buffer.from(row.tokenHash, 'hex');
    const actual = Buffer.from(sha256Hex(secret), 'hex');
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw this.invalid();
    }
    return row;
  }

  /** R4 step 3, mirroring Sanctum: `expires_at`, and `sanctum.expiration` counted from `created_at`. */
  private assertUsable(row: PersonalAccessToken): void {
    const now = Date.now();
    if (row.expiresAt && row.expiresAt.getTime() <= now) throw this.invalid();

    const minutes = this.chinaPartsConfig.tokenExpirationMinutes;
    if (minutes !== null) {
      if (!row.createdAt) throw this.invalid();
      if (row.createdAt.getTime() + minutes * 60_000 <= now) {
        throw this.invalid();
      }
    }
  }

  /**
   * The caller's reels account, from the 60-second cache or, when it expired, re-read from China
   * Parts. A suspended caller therefore loses write access within a minute (R7), and an account
   * China Parts no longer has can no longer sign in.
   */
  private async loadUser(
    accountType: AccountType,
    externalId: number,
  ): Promise<AuthenticatedUser> {
    const key = `auth:acct:${accountType}:${externalId}`;
    const cached = parseCachedAccount(await this.redis.get(key));
    if (cached) return this.toUser(accountType, externalId, cached);

    const remote = await this.fetchAccount(accountType, externalId);
    if (!remote) throw this.invalid();

    const account = await this.accounts.resolveOrProvision(remote);
    const accountId = account._id.toString();
    if (account.standing === 'good') {
      await this.standing.remove(accountId);
    } else {
      await this.standing.add(accountId);
    }

    const entry: CachedAccount = {
      accountId,
      standing: account.standing,
      locale: account.locale,
      preferredCurrency: account.preferredCurrency,
    };
    await this.redis.set(
      key,
      JSON.stringify(entry),
      'EX',
      ACCOUNT_CACHE_SECONDS,
    );
    return this.toUser(accountType, externalId, entry);
  }

  private async fetchAccount(
    accountType: AccountType,
    externalId: number,
  ): Promise<ChinaPartsAccount | undefined> {
    const [account] =
      accountType === 'customer'
        ? await this.chinaParts.getCustomers([externalId])
        : await this.chinaParts.getSellers([externalId]);
    return account;
  }

  private toUser(
    accountType: AccountType,
    externalId: number,
    cached: CachedAccount,
  ): AuthenticatedUser {
    return {
      userId: cached.accountId,
      accountType,
      externalId,
      standing: cached.standing,
      locale: cached.locale,
      preferredCurrency: cached.preferredCurrency,
    };
  }

  private invalid(): UnauthorizedException {
    return new UnauthorizedException({
      error: ErrorCode.AUTH_INVALID_SESSION,
      message: 'Your session is invalid or has expired',
    });
  }
}
