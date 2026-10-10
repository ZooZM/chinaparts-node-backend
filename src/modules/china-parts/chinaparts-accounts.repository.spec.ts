import {
  ChinaPartsAccountsRepository,
  publicName,
} from './chinaparts-accounts.repository';
import { ChinaPartsMediaRepository } from './media.repository';
import { configWith, FakeChinaPartsDb } from './testing';

function setup(env: Record<string, unknown> = {}) {
  const config = configWith({
    CHINAPARTS_DISK_URLS: 'public=https://cp.example/storage',
    CHINAPARTS_PUBLIC_STORAGE_URL: 'https://cp.example/storage',
    ...env,
  });
  const db = new FakeChinaPartsDb();
  const repository = new ChinaPartsAccountsRepository(
    db.asDb(),
    config,
    new ChinaPartsMediaRepository(db.asDb(), config),
  );
  return { db, repository };
}

const customer = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    first_name: 'Sara',
    last_name: 'Khalid',
    image: null,
    status: 1,
    preferred_currency: null,
    ...over,
  }) as never;

const seller = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    first_name: 'Ahmed',
    last_name: 'Salem',
    status: 'approved',
    preferred_currency: null,
    shop_id: 1,
    shop_name: 'قطع غيار الرياض',
    ...over,
  }) as never;

describe('publicName (FR-011, FR-012)', () => {
  it.each([
    ['Sara', 'Khalid', 'Sara K.'],
    ['sara', 'khalid', 'sara K.'],
    ['Omar', '', 'Omar'],
    ['  Lina ', ' Hassan ', 'Lina H.'],
    ['أحمد', 'سالم', 'أحمد س.'],
    ['', 'Khalid', 'K.'],
    ['Zoë', 'Émile', 'Zoë É.'],
    ['Kim', '😀smith', 'Kim 😀.'],
  ])('%s %s -> %s', (first, last, expected) => {
    expect(publicName(first, last)).toBe(expected);
  });
});

describe('ChinaPartsAccountsRepository.getCustomers', () => {
  it('maps public name, standing and currency, and never asks for private columns', async () => {
    const { db, repository } = setup();
    db.on(/FROM customers/, [
      customer({ id: 1 }),
      customer({
        id: 2,
        first_name: 'Omar',
        last_name: 'Nasser',
        preferred_currency: ' usd ',
      }),
      customer({ id: 3, first_name: 'Lina', last_name: 'Hassan', status: 0 }),
    ]);

    const accounts = await repository.getCustomers([1, 2, 3]);

    expect(accounts).toEqual([
      {
        accountType: 'customer',
        externalId: 1,
        name: 'Sara K.',
        avatarUrl: null,
        standing: 'good',
        preferredCurrency: null,
      },
      {
        accountType: 'customer',
        externalId: 2,
        name: 'Omar N.',
        avatarUrl: null,
        standing: 'good',
        preferredCurrency: 'USD',
      },
      {
        accountType: 'customer',
        externalId: 3,
        name: 'Lina H.',
        avatarUrl: null,
        standing: 'suspended',
        preferredCurrency: null,
      },
    ]);
    expect(db.queries[0].sql).toBe(
      'SELECT id, first_name, last_name, image, status, preferred_currency FROM customers WHERE id IN (?)',
    );
    db.expectNoSelectStar();
    for (const secret of ['email', 'phone', 'password', 'remember_token']) {
      expect(db.queries[0].sql).not.toContain(secret);
    }
  });

  it('treats only status 1 as good, whatever the driver returns', async () => {
    const { db, repository } = setup();
    db.on(/FROM customers/, [
      customer({ id: 1, status: '1' }),
      customer({ id: 2, status: 2 }),
      customer({ id: 3, status: 0 }),
    ]);
    const accounts = await repository.getCustomers([1, 2, 3]);
    expect(accounts.map((a) => a.standing)).toEqual([
      'good',
      'suspended',
      'suspended',
    ]);
  });

  it('resolves a relative avatar against the storage base, and keeps an absolute one', async () => {
    const { db, repository } = setup();
    db.on(/FROM customers/, [
      customer({ id: 1, image: 'customers/sara.jpg' }),
      customer({ id: 2, image: '/customers/omar.jpg' }),
      customer({ id: 3, image: 'https://cdn.example/lina.png' }),
      customer({ id: 4, image: '   ' }),
    ]);
    const accounts = await repository.getCustomers([1, 2, 3, 4]);
    expect(accounts.map((a) => a.avatarUrl)).toEqual([
      'https://cp.example/storage/customers/sara.jpg',
      'https://cp.example/storage/customers/omar.jpg',
      'https://cdn.example/lina.png',
      null,
    ]);
  });

  it('has no avatar for a relative path when no storage base is configured', async () => {
    const { db, repository } = setup({ CHINAPARTS_PUBLIC_STORAGE_URL: '' });
    db.on(/FROM customers/, [customer({ image: 'customers/sara.jpg' })]);
    expect((await repository.getCustomers([1]))[0].avatarUrl).toBeNull();
  });

  it('ignores a currency that is not a three-letter code', async () => {
    const { db, repository } = setup();
    db.on(/FROM customers/, [
      customer({ id: 1, preferred_currency: 'US' }),
      customer({ id: 2, preferred_currency: 'dollars' }),
      customer({ id: 3, preferred_currency: '' }),
    ]);
    const accounts = await repository.getCustomers([1, 2, 3]);
    expect(accounts.map((a) => a.preferredCurrency)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('returns only the rows that exist, so a missing account is absent', async () => {
    const { db, repository } = setup();
    db.on(/FROM customers/, [customer({ id: 1 })]);
    expect(
      (await repository.getCustomers([1, 999])).map((a) => a.externalId),
    ).toEqual([1]);
  });

  it('does not query for an empty list, and de-duplicates ids', async () => {
    const { db, repository } = setup();
    expect(await repository.getCustomers([])).toEqual([]);
    expect(db.queries).toHaveLength(0);

    await repository.getCustomers([5, 5, 5, 6]);
    expect(db.queries[0].values).toEqual([[5, 6]]);
  });

  it('batches in groups of 1,000', async () => {
    const { db, repository } = setup();
    const ids = Array.from({ length: 2_500 }, (_, index) => index + 1);

    await repository.getCustomers(ids);

    expect(db.queries.map((q) => (q.values[0] as number[]).length)).toEqual([
      1000, 1000, 500,
    ]);
  });
});

describe('ChinaPartsAccountsRepository.getSellers', () => {
  it('uses the shop name as the public name, and the shop logo as the avatar', async () => {
    const { db, repository } = setup();
    db.on(/FROM sellers/, [seller()]);
    db.on(/FROM media/, [
      {
        id: 2,
        model_type: 'App\\Models\\Shop',
        model_id: 1,
        uuid: null,
        file_name: 'riyadh-logo.png',
        disk: 'public',
        collection_name: 'logo',
        order_column: 1,
      } as never,
    ]);

    const [account] = await repository.getSellers([1]);

    expect(account).toEqual({
      accountType: 'seller',
      externalId: 1,
      name: 'قطع غيار الرياض',
      avatarUrl: 'https://cp.example/storage/2/riyadh-logo.png',
      standing: 'good',
      preferredCurrency: null,
    });
  });

  it('asks for the lowest-id shop and for no private column', async () => {
    const { db, repository } = setup();
    db.on(/FROM sellers/, [seller()]);

    await repository.getSellers([1]);

    const sql = db.queries[0].sql;
    expect(sql).toContain(
      '(SELECT name FROM shops WHERE seller_id = s.id ORDER BY id LIMIT 1) AS shop_name',
    );
    expect(sql).toContain(
      '(SELECT id FROM shops WHERE seller_id = s.id ORDER BY id LIMIT 1) AS shop_id',
    );
    for (const secret of [
      'email',
      'phone',
      'national_id',
      'identity',
      'password',
      'commission',
    ]) {
      expect(sql).not.toContain(secret);
    }
    db.expectNoSelectStar();
  });

  it('falls back to the seller name when there is no shop', async () => {
    const { db, repository } = setup();
    db.on(/FROM sellers/, [
      seller({
        id: 3,
        first_name: 'Yousef',
        last_name: 'Rashed',
        shop_id: null,
        shop_name: null,
      }),
    ]);
    const [account] = await repository.getSellers([3]);
    expect(account.name).toBe('Yousef R.');
  });

  it('falls back to the seller avatar when the shop has no logo', async () => {
    const { db, repository } = setup();
    db.on(/FROM sellers/, [seller()]);
    // The two media lookups differ only in the collection they ask for.
    db.on((sql, values) => /FROM media/.test(sql) && values[2] === 'logo', []);
    db.on(
      (sql, values) => /FROM media/.test(sql) && values[2] === 'avatar',
      [
        {
          id: 8,
          model_type: 'App\\Models\\Seller',
          model_id: 1,
          uuid: null,
          file_name: 'me.jpg',
          disk: 'public',
          collection_name: 'avatar',
          order_column: 1,
        } as never,
      ],
    );

    const [account] = await repository.getSellers([1]);

    expect(account.avatarUrl).toBe('https://cp.example/storage/8/me.jpg');
  });

  it.each([
    ['approved', 'good'],
    ['Approved', 'good'],
    ['1', 'good'],
    ['pending', 'suspended'],
    ['rejected', 'suspended'],
    ['suspended', 'suspended'],
    ['3', 'suspended'],
    ['', 'suspended'],
  ])('seller status %p is %s', async (status, standing) => {
    const { db, repository } = setup();
    db.on(/FROM sellers/, [seller({ status })]);
    expect((await repository.getSellers([1]))[0].standing).toBe(standing);
  });

  it('ignores the identity review status: only account status counts (spec, FR-008)', async () => {
    const { db, repository } = setup();
    // The query never reads identity_status, so a pending or rejected review cannot matter.
    db.on(/FROM sellers/, [
      seller({ status: 'approved', identity_status: 'rejected' }),
    ]);
    expect((await repository.getSellers([1]))[0].standing).toBe('good');
    expect(db.queries[0].sql).not.toContain('identity_status');
  });

  it('follows a configured set of approved values', async () => {
    const { db, repository } = setup({
      CHINAPARTS_SELLER_APPROVED_VALUES: 'active',
    });
    db.on(/FROM sellers/, [
      seller({ id: 1, status: 'active' }),
      seller({ id: 2, status: 'approved' }),
    ]);
    const accounts = await repository.getSellers([1, 2]);
    expect(accounts.map((a) => a.standing)).toEqual(['good', 'suspended']);
  });

  it('does not query for an empty list', async () => {
    const { db, repository } = setup();
    expect(await repository.getSellers([])).toEqual([]);
    expect(db.queries).toHaveLength(0);
  });
});
