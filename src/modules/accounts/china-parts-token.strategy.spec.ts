import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { FakeRedis } from '../../common/redis/fake-redis.testing';
import type { ChinaPartsAccount } from '../china-parts/chinaparts-accounts.repository';
import { ChinaPartsAccountsRepository } from '../china-parts/chinaparts-accounts.repository';
import { configWith } from '../china-parts/testing';
import {
  PersonalAccessToken,
  TokensRepository,
} from '../china-parts/tokens.repository';
import { AccountsService } from './accounts.service';
import { ChinaPartsTokenStrategy } from './china-parts-token.strategy';
import type { ReelsAccountLean } from './schemas/reels-account.schema';
import { StandingService } from './standing.service';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function tokenRow(
  secret: string,
  overrides: Partial<PersonalAccessToken> = {},
): PersonalAccessToken {
  return {
    id: 7,
    tokenableType: 'App\\Models\\Seller',
    tokenableId: 1,
    tokenHash: sha256(secret),
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function remoteAccount(
  accountType: 'customer' | 'seller',
  externalId: number,
  overrides: Partial<ChinaPartsAccount> = {},
): ChinaPartsAccount {
  return {
    accountType,
    externalId,
    name: `${accountType} ${externalId}`,
    avatarUrl: null,
    standing: 'good',
    preferredCurrency: null,
    ...overrides,
  };
}

function setup(env: Record<string, unknown> = {}, cacheSeconds = 60) {
  const redis = new FakeRedis();
  const tokens = {
    findById: jest.fn<Promise<PersonalAccessToken | null>, [number]>(),
    findByHash: jest.fn<Promise<PersonalAccessToken | null>, [string]>(),
  };
  const chinaParts = {
    getCustomers: jest.fn<Promise<ChinaPartsAccount[]>, [number[]]>((ids) =>
      Promise.resolve(ids.map((id) => remoteAccount('customer', id))),
    ),
    getSellers: jest.fn<Promise<ChinaPartsAccount[]>, [number[]]>((ids) =>
      Promise.resolve(ids.map((id) => remoteAccount('seller', id))),
    ),
  };
  // One reels account per (type, external id): the heart of SC-005.
  const provisioned = new Map<string, ReelsAccountLean>();
  const accounts = {
    resolveOrProvision: jest.fn<Promise<ReelsAccountLean>, [ChinaPartsAccount]>(
      (remote) => {
        const key = `${remote.accountType}:${remote.externalId}`;
        let account = provisioned.get(key);
        if (!account) {
          account = {
            _id: new Types.ObjectId(),
            accountType: remote.accountType,
            externalId: remote.externalId,
            name: remote.name,
            nameNormalized: remote.name,
            username: key.replace(':', '_'),
            usernameNormalized: key.replace(':', '_'),
            bio: '',
            avatarUrl: null,
            standing: remote.standing,
            locale: 'ar',
            preferredCurrency: remote.preferredCurrency,
            missingSince: null,
            blockedUsers: [],
            followersCount: 0,
            followingCount: 0,
            totalLikes: 0,
            syncedAt: null,
          };
          provisioned.set(key, account);
        }
        return Promise.resolve({ ...account, standing: remote.standing });
      },
    ),
  };
  const standing = {
    add: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
    remove: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  };
  const strategy = new ChinaPartsTokenStrategy(
    tokens as unknown as TokensRepository,
    chinaParts as unknown as ChinaPartsAccountsRepository,
    configWith(env),
    accounts as unknown as AccountsService,
    standing as unknown as StandingService,
    redis.asRedis(),
    { getOrThrow: () => cacheSeconds } as unknown as ConfigService,
  );
  return { strategy, redis, tokens, chinaParts, accounts, standing };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(UnauthorizedException);
  expect((error as UnauthorizedException).getResponse()).toMatchObject({
    error: 'AUTH_INVALID_SESSION',
  });
}

describe('ChinaPartsTokenStrategy (research R4)', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-10-10T10:00:00Z') }),
  );
  afterEach(() => jest.useRealTimers());

  describe('a valid session', () => {
    it('accepts an `id|secret` token for a seller, and looks the row up by id', async () => {
      const { strategy, tokens, chinaParts } = setup();
      tokens.findById.mockResolvedValue(tokenRow('seller-secret'));

      const user = await strategy.validate('7|seller-secret');

      expect(tokens.findById).toHaveBeenCalledWith(7);
      expect(chinaParts.getSellers).toHaveBeenCalledWith([1]);
      expect(user).toMatchObject({
        accountType: 'seller',
        externalId: 1,
        standing: 'good',
        locale: 'ar',
        preferredCurrency: null,
      });
      expect(Types.ObjectId.isValid(user.userId)).toBe(true);
    });

    it('accepts a customer token', async () => {
      const { strategy, tokens, chinaParts } = setup();
      tokens.findById.mockResolvedValue(
        tokenRow('c-secret', {
          tokenableType: 'App\\Models\\Customer',
          tokenableId: 5,
        }),
      );

      const user = await strategy.validate('7|c-secret');

      expect(chinaParts.getCustomers).toHaveBeenCalledWith([5]);
      expect(user).toMatchObject({ accountType: 'customer', externalId: 5 });
    });

    it('accepts a token without a pipe by the hash of the whole token, like Sanctum', async () => {
      const { strategy, tokens } = setup();
      tokens.findByHash.mockResolvedValue(tokenRow('pipeless-token'));

      const user = await strategy.validate('pipeless-token');

      expect(tokens.findByHash).toHaveBeenCalledWith(sha256('pipeless-token'));
      expect(tokens.findById).not.toHaveBeenCalled();
      expect(user.accountType).toBe('seller');
    });

    it('accepts a token whose secret carries a prefix, because the whole secret is hashed', async () => {
      const { strategy, tokens } = setup();
      const secret = 'cpr_AbCdEf0123456789abcdef01';
      tokens.findById.mockResolvedValue(tokenRow(secret));

      await expect(strategy.validate(`7|${secret}`)).resolves.toMatchObject({
        accountType: 'seller',
      });
    });

    it('keeps a pipe inside the secret: only the first one separates the id', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(tokenRow('a|b'));
      await expect(strategy.validate('7|a|b')).resolves.toBeDefined();
    });

    it("hands back the account's locale and preferred currency", async () => {
      const { strategy, tokens, chinaParts } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));
      chinaParts.getSellers.mockResolvedValue([
        remoteAccount('seller', 1, { preferredCurrency: 'USD' }),
      ]);

      expect(await strategy.validate('7|s')).toMatchObject({
        preferredCurrency: 'USD',
        locale: 'ar',
      });
    });
  });

  describe('a session that is refused (FR-004a, FR-007)', () => {
    it('refuses an unknown token', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(null);
      await expectInvalid(strategy.validate('99|whatever'));
    });

    it('refuses a wrong secret for a known id', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(tokenRow('right-secret'));
      await expectInvalid(strategy.validate('7|wrong-secret'));
    });

    it('refuses a pipeless token that matches nothing', async () => {
      const { strategy, tokens } = setup();
      tokens.findByHash.mockResolvedValue(null);
      await expectInvalid(strategy.validate('nothing'));
    });

    it('refuses a stored hash of the wrong length without throwing a RangeError', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s', { tokenHash: 'abcd' }));
      await expectInvalid(strategy.validate('7|s'));
    });

    it.each([
      ['an empty token', ''],
      ['a non-numeric id', 'abc|secret'],
      ['an empty id', '|secret'],
      ['an empty secret', '7|'],
      ['an id that is too long to be real', `${'9'.repeat(20)}|secret`],
      ['a negative id', '-7|secret'],
      ['an enormous token', 'x'.repeat(600)],
    ])('refuses %s without touching the database', async (_label, token) => {
      const { strategy, tokens, chinaParts } = setup();
      await expectInvalid(strategy.validate(token));
      expect(tokens.findById).not.toHaveBeenCalled();
      expect(tokens.findByHash).not.toHaveBeenCalled();
      expect(chinaParts.getCustomers).not.toHaveBeenCalled();
    });

    it('refuses an expired token, and accepts one that has not expired yet', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(
        tokenRow('s', { expiresAt: new Date('2026-10-10T09:59:59Z') }),
      );
      await expectInvalid(strategy.validate('7|s'));

      tokens.findById.mockResolvedValue(
        tokenRow('s', { expiresAt: new Date('2026-10-10T10:00:01Z') }),
      );
      await expect(strategy.validate('7|s')).resolves.toBeDefined();
    });

    it('refuses a token exactly at its expiry instant', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(
        tokenRow('s', { expiresAt: new Date('2026-10-10T10:00:00Z') }),
      );
      await expectInvalid(strategy.validate('7|s'));
    });

    it.each([
      ['older than the window', new Date('2026-10-10T08:59:00Z'), false],
      ['exactly at the window', new Date('2026-10-10T09:00:00Z'), false],
      ['inside the window', new Date('2026-10-10T09:30:00Z'), true],
      ['missing', null, false],
    ])(
      'mirrors sanctum.expiration (60 minutes) for a token created %s',
      async (_label, createdAt, accepted) => {
        const { strategy, tokens } = setup({
          CHINAPARTS_TOKEN_EXPIRATION_MINUTES: 60,
        });
        tokens.findById.mockResolvedValue(tokenRow('s', { createdAt }));

        if (accepted) {
          await expect(strategy.validate('7|s')).resolves.toBeDefined();
        } else {
          await expectInvalid(strategy.validate('7|s'));
        }
      },
    );

    it('ignores created_at when no global expiration is configured', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(
        tokenRow('s', { createdAt: new Date('2020-01-01T00:00:00Z') }),
      );
      await expect(strategy.validate('7|s')).resolves.toBeDefined();
    });

    it.each(['App\\Models\\Admin', 'admin', 'App\\Models\\User', ''])(
      'refuses a token of type %p, and never looks the account up (FR-007)',
      async (tokenableType) => {
        const { strategy, tokens, chinaParts } = setup();
        tokens.findById.mockResolvedValue(tokenRow('s', { tokenableType }));

        await expectInvalid(strategy.validate('7|s'));

        expect(chinaParts.getCustomers).not.toHaveBeenCalled();
        expect(chinaParts.getSellers).not.toHaveBeenCalled();
      },
    );

    it('refuses a token whose account China Parts no longer has', async () => {
      const { strategy, tokens, chinaParts } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));
      chinaParts.getSellers.mockResolvedValue([]);
      await expectInvalid(strategy.validate('7|s'));
    });
  });

  describe('standing', () => {
    it('removes a good account from the exclusion set', async () => {
      const { strategy, tokens, standing } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));

      const user = await strategy.validate('7|s');

      expect(standing.remove).toHaveBeenCalledWith(user.userId);
      expect(standing.add).not.toHaveBeenCalled();
    });

    it('adds a suspended account to the exclusion set, and reports its standing (FR-008)', async () => {
      const { strategy, tokens, chinaParts, standing } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));
      chinaParts.getSellers.mockResolvedValue([
        remoteAccount('seller', 1, { standing: 'suspended' }),
      ]);

      const user = await strategy.validate('7|s');

      expect(user.standing).toBe('suspended');
      expect(standing.add).toHaveBeenCalledWith(user.userId);
    });
  });

  describe('customer 1 and seller 1 are different people (SC-005)', () => {
    it('resolves to different reels accounts, through different China Parts tables', async () => {
      const { strategy, tokens, chinaParts } = setup();
      tokens.findById.mockImplementation((id) =>
        Promise.resolve(
          id === 1
            ? tokenRow('cust', {
                id: 1,
                tokenableType: 'App\\Models\\Customer',
                tokenableId: 1,
              })
            : tokenRow('sell', {
                id: 2,
                tokenableType: 'App\\Models\\Seller',
                tokenableId: 1,
              }),
        ),
      );

      const customer = await strategy.validate('1|cust');
      const seller = await strategy.validate('2|sell');

      expect(customer.externalId).toBe(1);
      expect(seller.externalId).toBe(1);
      expect(customer.accountType).toBe('customer');
      expect(seller.accountType).toBe('seller');
      expect(customer.userId).not.toBe(seller.userId);
      expect(chinaParts.getCustomers).toHaveBeenCalledWith([1]);
      expect(chinaParts.getSellers).toHaveBeenCalledWith([1]);
    });

    it('never mixes their cached sessions', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockImplementation((id) =>
        Promise.resolve(
          id === 1
            ? tokenRow('cust', {
                id: 1,
                tokenableType: 'customer',
                tokenableId: 1,
              })
            : tokenRow('sell', {
                id: 2,
                tokenableType: 'seller',
                tokenableId: 1,
              }),
        ),
      );
      const firstCustomer = await strategy.validate('1|cust');
      const firstSeller = await strategy.validate('2|sell');

      // Both now come from the cache.
      expect((await strategy.validate('1|cust')).userId).toBe(
        firstCustomer.userId,
      );
      expect((await strategy.validate('2|sell')).userId).toBe(
        firstSeller.userId,
      );
    });
  });

  describe('caching (R4 step 5, R7)', () => {
    it('serves a repeat from the cache without touching China Parts', async () => {
      const { strategy, tokens, chinaParts, accounts } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));
      const first = await strategy.validate('7|s');

      const second = await strategy.validate('7|s');

      expect(second).toEqual(first);
      expect(tokens.findById).toHaveBeenCalledTimes(1);
      expect(chinaParts.getSellers).toHaveBeenCalledTimes(1);
      expect(accounts.resolveOrProvision).toHaveBeenCalledTimes(1);
    });

    it('never stores the token, or its secret, in a Redis key', async () => {
      const { strategy, tokens, redis } = setup();
      tokens.findById.mockResolvedValue(tokenRow('very-secret-value'));
      await strategy.validate('7|very-secret-value');

      expect(redis.keys().length).toBeGreaterThan(0);
      for (const key of redis.keys()) {
        expect(key).not.toContain('very-secret-value');
      }
      expect(redis.keys()).toContain(
        `auth:tok:${sha256('7|very-secret-value')}`,
      );
    });

    it('stops trusting a revoked token once the token cache expires (FR-005)', async () => {
      const { strategy, tokens } = setup({}, 2);
      tokens.findById.mockResolvedValue(tokenRow('s'));
      await strategy.validate('7|s');

      // China Parts signs the user out: Sanctum deletes the row.
      tokens.findById.mockResolvedValue(null);
      await expect(strategy.validate('7|s')).resolves.toBeDefined(); // still cached

      jest.advanceTimersByTime(2_001);
      await expectInvalid(strategy.validate('7|s'));
    });

    it('re-reads the account when its 60-second cache expires, so a suspension takes effect', async () => {
      const { strategy, tokens, chinaParts } = setup({}, 300);
      tokens.findById.mockResolvedValue(tokenRow('s'));
      expect((await strategy.validate('7|s')).standing).toBe('good');

      chinaParts.getSellers.mockResolvedValue([
        remoteAccount('seller', 1, { standing: 'suspended' }),
      ]);
      expect((await strategy.validate('7|s')).standing).toBe('good'); // still within 60 s

      jest.advanceTimersByTime(60_001);
      expect((await strategy.validate('7|s')).standing).toBe('suspended');
      // The token itself was not re-checked: only the account.
      expect(tokens.findById).toHaveBeenCalledTimes(1);
    });

    it('treats a corrupt cache entry as a miss', async () => {
      const { strategy, tokens, redis } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));
      await redis.set(`auth:tok:${sha256('7|s')}`, '{not json', 'EX', 60);
      await redis.set('auth:acct:seller:1', '{"accountId": 5}', 'EX', 60);

      await expect(strategy.validate('7|s')).resolves.toMatchObject({
        accountType: 'seller',
      });
      expect(tokens.findById).toHaveBeenCalledTimes(1);
    });

    it('does not cache a refused token', async () => {
      const { strategy, tokens, redis } = setup();
      tokens.findById.mockResolvedValue(null);
      await expectInvalid(strategy.validate('7|s'));
      expect(redis.keys()).toEqual([]);
    });
  });

  describe('an outage at China Parts', () => {
    const outage = () =>
      new ServiceUnavailableException({
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'China Parts is temporarily unavailable',
      });

    it('is a 503, never a 401, when the token cannot be looked up', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockRejectedValue(outage());

      const error = await rejection(strategy.validate('7|s'));

      expect(error).toBeInstanceOf(ServiceUnavailableException);
    });

    it('is a 503 when the account cannot be read', async () => {
      const { strategy, tokens, chinaParts } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));
      chinaParts.getSellers.mockRejectedValue(outage());

      expect(await rejection(strategy.validate('7|s'))).toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('does not cache anything for the failed attempt', async () => {
      const { strategy, tokens, redis } = setup();
      tokens.findById.mockRejectedValue(outage());
      await rejection(strategy.validate('7|s'));
      expect(redis.keys()).toEqual([]);
    });

    it('keeps serving a cached session during an outage', async () => {
      const { strategy, tokens } = setup();
      tokens.findById.mockResolvedValue(tokenRow('s'));
      await strategy.validate('7|s');

      tokens.findById.mockRejectedValue(outage());
      await expect(strategy.validate('7|s')).resolves.toBeDefined();
    });
  });
});
