import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { ChinaPartsAccount } from '../china-parts/chinaparts-accounts.repository';
import {
  AccountsRepository,
  ProvisionData,
  ProvisionResult,
} from './accounts.repository';
import { AccountsService } from './accounts.service';
import type { ReelsAccountLean } from './schemas/reels-account.schema';

function lean(overrides: Partial<ReelsAccountLean> = {}): ReelsAccountLean {
  return {
    _id: new Types.ObjectId(),
    accountType: 'customer',
    externalId: 1,
    name: 'Sara K.',
    nameNormalized: 'sara k.',
    username: 'Sara_K',
    usernameNormalized: 'sara_k',
    bio: '',
    avatarUrl: null,
    standing: 'good',
    locale: 'ar',
    preferredCurrency: null,
    missingSince: null,
    blockedUsers: [],
    followersCount: 0,
    followingCount: 0,
    totalLikes: 0,
    syncedAt: null,
    ...overrides,
  };
}

function remote(overrides: Partial<ChinaPartsAccount> = {}): ChinaPartsAccount {
  return {
    accountType: 'customer',
    externalId: 1,
    name: 'Sara K.',
    avatarUrl: null,
    standing: 'good',
    preferredCurrency: null,
    ...overrides,
  };
}

type Repo = jest.Mocked<
  Pick<
    AccountsRepository,
    | 'findByExternal'
    | 'findByUsernamesNormalized'
    | 'findByIdLean'
    | 'createProvisioned'
    | 'updateDisplay'
    | 'updateProfile'
    | 'updateLocale'
    | 'getBlockedIds'
    | 'findBlockerIds'
    | 'addBlock'
    | 'removeBlock'
  >
>;

function setup() {
  const repo: Repo = {
    findByExternal: jest.fn(),
    findByUsernamesNormalized: jest.fn(),
    findByIdLean: jest.fn(),
    createProvisioned: jest.fn(),
    updateDisplay: jest.fn(),
    updateProfile: jest.fn(),
    updateLocale: jest.fn(),
    getBlockedIds: jest.fn(),
    findBlockerIds: jest.fn(),
    addBlock: jest.fn(),
    removeBlock: jest.fn(),
  };
  const service = new AccountsService(repo as unknown as AccountsRepository);
  return { repo, service };
}

describe('AccountsService.resolveOrProvision', () => {
  it('returns an existing account untouched when nothing changed', async () => {
    const { repo, service } = setup();
    const existing = lean();
    repo.findByExternal.mockResolvedValue(existing);

    expect(await service.resolveOrProvision(remote())).toBe(existing);
    expect(repo.updateDisplay).not.toHaveBeenCalled();
    expect(repo.createProvisioned).not.toHaveBeenCalled();
  });

  it.each([
    ['name', { name: 'Sara Q.' }],
    ['avatar', { avatarUrl: 'https://x/a.jpg' }],
    ['standing', { standing: 'suspended' as const }],
    ['currency', { preferredCurrency: 'USD' }],
  ])('refreshes display data when the %s changed', async (_label, change) => {
    const { repo, service } = setup();
    const existing = lean();
    const updated = lean({ _id: existing._id, ...change });
    repo.findByExternal.mockResolvedValue(existing);
    repo.updateDisplay.mockResolvedValue(updated);

    const result = await service.resolveOrProvision(remote(change));

    expect(result).toBe(updated);
    const [id, display] = repo.updateDisplay.mock.calls[0];
    expect(id).toBe(existing._id.toString());
    expect(display).toMatchObject(change);
    expect(typeof display.nameNormalized).toBe('string');
  });

  it('refreshes an account that was marked missing, because the row is back', async () => {
    const { repo, service } = setup();
    const existing = lean({ missingSince: new Date() });
    repo.findByExternal.mockResolvedValue(existing);
    repo.updateDisplay.mockResolvedValue(lean({ _id: existing._id }));

    await service.resolveOrProvision(remote());

    expect(repo.updateDisplay).toHaveBeenCalledTimes(1);
  });

  it('stores the normalized name so Arabic spellings match', async () => {
    const { repo, service } = setup();
    repo.findByExternal.mockResolvedValue(lean({ name: 'old' }));
    repo.updateDisplay.mockResolvedValue(lean());

    await service.resolveOrProvision(remote({ name: 'أحمد س.' }));

    expect(repo.updateDisplay.mock.calls[0][1]).toMatchObject({
      name: 'أحمد س.',
      nameNormalized: 'احمد س.',
    });
  });

  describe('first use', () => {
    const created = (data: ProvisionData): ProvisionResult => ({
      status: 'created',
      account: lean({ username: data.username, accountType: data.accountType }),
    });

    it('provisions an account with an automatic handle (FR-015)', async () => {
      const { repo, service } = setup();
      repo.findByExternal.mockResolvedValue(null);
      repo.createProvisioned.mockImplementation((data) =>
        Promise.resolve(created(data)),
      );

      const account = await service.resolveOrProvision(
        remote({
          accountType: 'seller',
          externalId: 7,
          name: 'قطع غيار الرياض',
        }),
      );

      expect(account.username).toBe('قطع_غيار_الرياض');
      expect(repo.createProvisioned).toHaveBeenCalledWith(
        expect.objectContaining({
          accountType: 'seller',
          externalId: 7,
          username: 'قطع_غيار_الرياض',
          usernameNormalized: 'قطع_غيار_الرياض',
          locale: 'ar',
          standing: 'good',
        }),
      );
    });

    it('starts a customer with their standing from China Parts', async () => {
      const { repo, service } = setup();
      repo.findByExternal.mockResolvedValue(null);
      repo.createProvisioned.mockImplementation((data) =>
        Promise.resolve(created(data)),
      );

      await service.resolveOrProvision(remote({ standing: 'suspended' }));

      expect(repo.createProvisioned.mock.calls[0][0].standing).toBe(
        'suspended',
      );
    });

    it('gives two shops with the same name distinct handles: _2, _3, ...', async () => {
      const { repo, service } = setup();
      repo.findByExternal.mockResolvedValue(null);
      const taken = new Set(['Auto_Parts', 'Auto_Parts_2']);
      repo.createProvisioned.mockImplementation((data) =>
        Promise.resolve(
          taken.has(data.username)
            ? { status: 'duplicate_username' as const }
            : created(data),
        ),
      );

      const account = await service.resolveOrProvision(
        remote({ accountType: 'seller', name: 'Auto Parts' }),
      );

      expect(account.username).toBe('Auto_Parts_3');
    });

    it('treats a handle that differs only by Arabic spelling as taken', async () => {
      const { repo, service } = setup();
      repo.findByExternal.mockResolvedValue(null);
      repo.createProvisioned.mockImplementation((data) =>
        Promise.resolve(
          data.usernameNormalized === 'احمد'
            ? { status: 'duplicate_username' as const }
            : created(data),
        ),
      );

      const account = await service.resolveOrProvision(
        remote({ name: 'أحمد' }),
      );

      // أحمد normalizes to احمد, which is taken, so the next candidate is used.
      expect(account.username).toBe('أحمد_2');
    });

    it('falls back to random suffixes when the sequential ones are exhausted', async () => {
      const { repo, service } = setup();
      repo.findByExternal.mockResolvedValue(null);
      repo.createProvisioned.mockImplementation((data) =>
        Promise.resolve(
          /^Crowded(_([2-9]|1\d|2[01]))?$/.test(data.username)
            ? { status: 'duplicate_username' as const }
            : created(data),
        ),
      );

      const account = await service.resolveOrProvision(
        remote({ name: 'Crowded' }),
      );

      expect(account.username).toMatch(/^Crowded_[0-9a-f]{6}$/);
      expect(repo.createProvisioned).toHaveBeenCalledTimes(22);
    });

    it('gives up with an error after every attempt collided', async () => {
      const { repo, service } = setup();
      repo.findByExternal.mockResolvedValue(null);
      repo.createProvisioned.mockResolvedValue({
        status: 'duplicate_username',
      });

      await expect(service.resolveOrProvision(remote())).rejects.toThrow(
        /Could not allocate a handle/,
      );
      expect(repo.createProvisioned).toHaveBeenCalledTimes(26);
    });

    it('uses the winner when two first requests race (unique account key)', async () => {
      const { repo, service } = setup();
      const winner = lean({ username: 'winner' });
      repo.findByExternal
        .mockResolvedValueOnce(null) // the first look
        .mockResolvedValueOnce(winner); // after losing the race
      repo.createProvisioned.mockResolvedValue({
        status: 'duplicate_external',
      });

      expect(await service.resolveOrProvision(remote())).toBe(winner);
      expect(repo.createProvisioned).toHaveBeenCalledTimes(1);
    });

    it('keeps handles within 30 characters even with a suffix', async () => {
      const { repo, service } = setup();
      repo.findByExternal.mockResolvedValue(null);
      repo.createProvisioned.mockImplementation((data) =>
        Promise.resolve(
          data.username.length === 30 && !data.username.includes('_')
            ? { status: 'duplicate_username' as const }
            : created(data),
        ),
      );

      const account = await service.resolveOrProvision(
        remote({ name: 'a'.repeat(60) }),
      );

      expect(Array.from(account.username)).toHaveLength(30);
      expect(account.username.endsWith('_2')).toBe(true);
    });
  });
});

describe('AccountsService.getMe', () => {
  it("returns the caller's own account in the contract shape", async () => {
    const { repo, service } = setup();
    const account = lean({ bio: 'hi', followersCount: 3, totalLikes: 9 });
    repo.findByIdLean.mockResolvedValue(account);

    expect(await service.getMe(account._id.toString())).toEqual({
      id: account._id.toString(),
      accountType: 'customer',
      username: 'Sara_K',
      name: 'Sara K.',
      avatarUrl: null,
      bio: 'hi',
      locale: 'ar',
      followersCount: 3,
      followingCount: 0,
      totalLikes: 9,
    });
  });

  it('is a 404 for an unknown account', async () => {
    const { repo, service } = setup();
    repo.findByIdLean.mockResolvedValue(null);
    await expect(
      service.getMe('650000000000000000000001'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AccountsService.updateMe', () => {
  it('changes handle and bio, and stores the normalized handle', async () => {
    const { repo, service } = setup();
    repo.updateProfile.mockResolvedValue(
      lean({ username: 'أحمد_سالم', bio: 'ورشة' }),
    );

    const me = await service.updateMe('650000000000000000000001', {
      username: 'أحمد_سالم',
      bio: 'ورشة',
    });

    expect(me).toMatchObject({ username: 'أحمد_سالم', bio: 'ورشة' });
    expect(repo.updateProfile).toHaveBeenCalledWith(
      '650000000000000000000001',
      {
        username: 'أحمد_سالم',
        usernameNormalized: 'احمد_سالم',
        bio: 'ورشة',
      },
    );
  });

  it('answers 409 USERNAME_TAKEN when the normalized handle collides', async () => {
    const { repo, service } = setup();
    repo.updateProfile.mockResolvedValue('username_taken');

    const error = await service
      .updateMe('650000000000000000000001', { username: 'احمد' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      error: 'USERNAME_TAKEN',
    });
  });

  it.each(['ab', 'x'.repeat(31), 'has space', 'emoji😀', ''])(
    'rejects the invalid handle %p without touching the database',
    async (username) => {
      const { repo, service } = setup();
      await expect(
        service.updateMe('650000000000000000000001', { username }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateProfile).not.toHaveBeenCalled();
    },
  );

  it('rejects a bio over 150 characters, counting characters', async () => {
    const { repo, service } = setup();
    await expect(
      service.updateMe('650000000000000000000001', { bio: 'ب'.repeat(151) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.updateProfile).not.toHaveBeenCalled();

    repo.updateProfile.mockResolvedValue(lean());
    await service.updateMe('650000000000000000000001', {
      bio: 'ب'.repeat(150),
    });
    expect(repo.updateProfile).toHaveBeenCalledTimes(1);
  });

  it('returns the current account when there is nothing to change', async () => {
    const { repo, service } = setup();
    repo.findByIdLean.mockResolvedValue(lean());
    await service.updateMe('650000000000000000000001', {});
    expect(repo.updateProfile).not.toHaveBeenCalled();
    expect(repo.findByIdLean).toHaveBeenCalledTimes(1);
  });

  it('is a 404 when the account vanished', async () => {
    const { repo, service } = setup();
    repo.updateProfile.mockResolvedValue(null);
    await expect(
      service.updateMe('650000000000000000000001', { bio: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AccountsService blocking', () => {
  const me = '650000000000000000000001';
  const other = '650000000000000000000002';

  it('the block set is who I blocked plus who blocked me, without duplicates', async () => {
    const { repo, service } = setup();
    repo.getBlockedIds.mockResolvedValue(['a', 'b']);
    repo.findBlockerIds.mockResolvedValue(['b', 'c']);

    expect((await service.getBlockSet(me)).sort()).toEqual(['a', 'b', 'c']);
  });

  it('toggles a block on and off', async () => {
    const { repo, service } = setup();
    repo.findByIdLean.mockResolvedValue(lean());

    repo.getBlockedIds.mockResolvedValueOnce([]);
    expect(await service.toggleBlock(me, other)).toEqual({ blocked: true });
    expect(repo.addBlock).toHaveBeenCalledWith(me, other);

    repo.getBlockedIds.mockResolvedValueOnce([other]);
    expect(await service.toggleBlock(me, other)).toEqual({ blocked: false });
    expect(repo.removeBlock).toHaveBeenCalledWith(me, other);
  });

  it('refuses to block yourself with CANNOT_BLOCK_SELF', async () => {
    const { service } = setup();
    const error = await service.toggleBlock(me, me).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      error: 'CANNOT_BLOCK_SELF',
    });
  });

  it('is a 404 ACCOUNT_NOT_FOUND for an unknown target', async () => {
    const { repo, service } = setup();
    repo.findByIdLean.mockResolvedValue(null);
    const error = await service.toggleBlock(me, other).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      error: 'ACCOUNT_NOT_FOUND',
    });
  });
});

it("records the caller's locale", async () => {
  const { repo, service } = setup();
  await service.recordLocale('650000000000000000000001', 'en');
  expect(repo.updateLocale).toHaveBeenCalledWith(
    '650000000000000000000001',
    'en',
  );
});

describe('AccountsService.resolveMentions', () => {
  it('returns the accounts that own the handles, by id and handle as typed', async () => {
    const { repo, service } = setup();
    const id = new Types.ObjectId();
    repo.findByUsernamesNormalized.mockResolvedValue([
      { _id: id, username: 'قطع_الرياض' },
    ]);

    expect(await service.resolveMentions(['قطع_الرياض', 'nobody'])).toEqual([
      { userId: id.toString(), username: 'قطع_الرياض' },
    ]);
    expect(repo.findByUsernamesNormalized).toHaveBeenCalledWith([
      'قطع_الرياض',
      'nobody',
    ]);
  });

  it('returns nothing when no handle matches', async () => {
    const { repo, service } = setup();
    repo.findByUsernamesNormalized.mockResolvedValue([]);
    expect(await service.resolveMentions(['nobody'])).toEqual([]);
  });
});
