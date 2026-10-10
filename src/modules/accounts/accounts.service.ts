import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AccountType, Locale } from '../../common/http/viewer-request';
import { normalizeForMatch } from '../../common/text/normalize-for-match';
import type { ChinaPartsAccount } from '../china-parts/chinaparts-accounts.repository';
import { AccountsRepository, DisplayUpdate } from './accounts.repository';
import { generateHandleBase, isValidHandle, withSuffix } from './handle.util';
import type { ReelsAccountLean } from './schemas/reels-account.schema';

/** `GET /api/users/me` (EP24). */
export interface MeDto {
  id: string;
  accountType: AccountType;
  username: string;
  name: string;
  avatarUrl: string | null;
  bio: string;
  locale: Locale;
  followersCount: number;
  followingCount: number;
  totalLikes: number;
}

const BIO_MAX_LENGTH = 150;
/** `_2`, `_3`, ... up to `_21` (research R6), then a few random suffixes for crowded names. */
const SEQUENTIAL_SUFFIXES = 20;
const RANDOM_SUFFIXES = 5;

function toDisplay(account: ChinaPartsAccount): DisplayUpdate {
  return {
    name: account.name,
    nameNormalized: normalizeForMatch(account.name),
    avatarUrl: account.avatarUrl,
    standing: account.standing,
    preferredCurrency: account.preferredCurrency,
    syncedAt: new Date(),
  };
}

function toMe(account: ReelsAccountLean): MeDto {
  return {
    id: account._id.toString(),
    accountType: account.accountType,
    username: account.username,
    name: account.name,
    avatarUrl: account.avatarUrl,
    bio: account.bio,
    locale: account.locale,
    followersCount: account.followersCount,
    followingCount: account.followingCount,
    totalLikes: account.totalLikes,
  };
}

/** Reels identities: created on first use, kept in step with China Parts, edited by their owner. */
@Injectable()
export class AccountsService {
  constructor(private readonly accounts: AccountsRepository) {}

  /**
   * The reels account for a China Parts account, created on first use with an automatic handle
   * (FR-015) and refreshed when its display data or standing changed. Safe under concurrency:
   * two first requests race on the unique index and the loser reads the winner's document.
   */
  async resolveOrProvision(
    account: ChinaPartsAccount,
  ): Promise<ReelsAccountLean> {
    const existing = await this.accounts.findByExternal(
      account.accountType,
      account.externalId,
    );
    return existing ? this.refresh(existing, account) : this.provision(account);
  }

  async getMe(userId: string): Promise<MeDto> {
    const account = await this.accounts.findByIdLean(userId);
    if (!account) throw this.notFound();
    return toMe(account);
  }

  /** Changes the caller's handle and bio. A taken handle (after normalization) is a 409. */
  async updateMe(
    userId: string,
    input: { username?: string; bio?: string },
  ): Promise<MeDto> {
    const changes: {
      username?: string;
      usernameNormalized?: string;
      bio?: string;
    } = {};

    if (input.username !== undefined) {
      if (!isValidHandle(input.username)) {
        throw new BadRequestException({
          error: ErrorCode.VALIDATION_FAILED,
          message:
            'username must be 3 to 30 letters, digits, underscores or periods',
        });
      }
      changes.username = input.username;
      changes.usernameNormalized = normalizeForMatch(input.username);
    }
    if (input.bio !== undefined) {
      if (Array.from(input.bio).length > BIO_MAX_LENGTH) {
        throw new BadRequestException({
          error: ErrorCode.VALIDATION_FAILED,
          message: `bio must be at most ${BIO_MAX_LENGTH} characters`,
        });
      }
      changes.bio = input.bio;
    }
    if (Object.keys(changes).length === 0) return this.getMe(userId);

    const result = await this.accounts.updateProfile(userId, changes);
    if (result === 'username_taken') {
      throw new ConflictException({
        error: ErrorCode.USERNAME_TAKEN,
        message: 'That username is already taken',
      });
    }
    if (!result) throw this.notFound();
    return toMe(result);
  }

  async recordLocale(userId: string, locale: Locale): Promise<void> {
    await this.accounts.updateLocale(userId, locale);
  }

  /**
   * Everyone whose content `viewerId` must not see, and who must not see theirs: the accounts the
   * viewer blocked plus the accounts that blocked the viewer (FR-047).
   */
  async getBlockSet(viewerId: string): Promise<string[]> {
    const [own, reverse] = await Promise.all([
      this.accounts.getBlockedIds(viewerId),
      this.accounts.findBlockerIds(viewerId),
    ]);
    return [...new Set([...own, ...reverse])];
  }

  /** A directed block, toggled. It affects reels only (FR-048): nothing is written to China Parts. */
  async toggleBlock(
    viewerId: string,
    targetId: string,
  ): Promise<{ blocked: boolean }> {
    if (targetId === viewerId) {
      throw new BadRequestException({
        error: ErrorCode.CANNOT_BLOCK_SELF,
        message: 'Cannot block yourself',
      });
    }
    const target = await this.accounts.findByIdLean(targetId);
    if (!target) throw this.notFound();

    const blocked = await this.accounts.getBlockedIds(viewerId);
    if (blocked.includes(targetId)) {
      await this.accounts.removeBlock(viewerId, targetId);
      return { blocked: false };
    }
    await this.accounts.addBlock(viewerId, targetId);
    return { blocked: true };
  }

  private async refresh(
    existing: ReelsAccountLean,
    account: ChinaPartsAccount,
  ): Promise<ReelsAccountLean> {
    const unchanged =
      existing.name === account.name &&
      existing.avatarUrl === account.avatarUrl &&
      existing.standing === account.standing &&
      existing.preferredCurrency === account.preferredCurrency &&
      existing.missingSince === null;
    if (unchanged) return existing;

    const updated = await this.accounts.updateDisplay(
      existing._id.toString(),
      toDisplay(account),
    );
    return updated ?? existing;
  }

  private async provision(
    account: ChinaPartsAccount,
  ): Promise<ReelsAccountLean> {
    const base = generateHandleBase(account.name, account.accountType);
    const attempts = 1 + SEQUENTIAL_SUFFIXES + RANDOM_SUFFIXES;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const username = this.candidate(base, attempt);
      const result = await this.accounts.createProvisioned({
        ...toDisplay(account),
        accountType: account.accountType,
        externalId: account.externalId,
        username,
        usernameNormalized: normalizeForMatch(username),
        locale: 'ar',
      });

      if (result.status === 'created') return result.account;
      if (result.status === 'duplicate_external') {
        // A concurrent first request got there first: use its document.
        const winner = await this.accounts.findByExternal(
          account.accountType,
          account.externalId,
        );
        if (winner) return winner;
      }
      // duplicate_username: someone has that handle, so try the next candidate.
    }
    throw new Error(
      `Could not allocate a handle for ${account.accountType} ${account.externalId}`,
    );
  }

  private candidate(base: string, attempt: number): string {
    if (attempt === 0) return base;
    if (attempt <= SEQUENTIAL_SUFFIXES) {
      return withSuffix(base, `_${attempt + 1}`);
    }
    return withSuffix(base, `_${randomBytes(3).toString('hex')}`);
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      error: ErrorCode.ACCOUNT_NOT_FOUND,
      message: 'Account not found',
    });
  }
}
