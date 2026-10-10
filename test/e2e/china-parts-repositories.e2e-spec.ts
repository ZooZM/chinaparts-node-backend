import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ChinaPartsAccountsRepository } from '../../src/modules/china-parts/chinaparts-accounts.repository';
import { ChinaPartsConfig } from '../../src/modules/china-parts/china-parts.config';
import { ChinaPartsMediaRepository } from '../../src/modules/china-parts/media.repository';
import {
  ChinaPartsDb,
  createChinaPartsPool,
} from '../../src/modules/china-parts/mysql.provider';
import { TokensRepository } from '../../src/modules/china-parts/tokens.repository';
import { startInfra, TestInfra } from '../utils/containers';

/**
 * The China Parts repositories against a real MySQL, as the real column-grant user. Fake-database
 * specs cannot prove that a query is allowed by the grants, that `IN (?)` expands, or that Arabic
 * survives the round trip. This one can.
 */
describe('China Parts repositories against MySQL (column-level grants)', () => {
  let infra: TestInfra;
  let db: ChinaPartsDb;
  let accounts: ChinaPartsAccountsRepository;
  let tokens: TokensRepository;

  beforeAll(async () => {
    infra = await startInfra();
    const values: Record<string, unknown> = {
      CHINAPARTS_MYSQL_HOST: infra.mysql.host,
      CHINAPARTS_MYSQL_PORT: infra.mysql.port,
      CHINAPARTS_MYSQL_DATABASE: infra.mysql.database,
      CHINAPARTS_MYSQL_USER: infra.mysql.user,
      CHINAPARTS_MYSQL_PASSWORD: infra.mysql.password,
      CHINAPARTS_DISK_URLS: 'public=http://localhost:8000/storage',
      CHINAPARTS_PUBLIC_STORAGE_URL: 'http://localhost:8000/storage',
    };
    const configService = {
      get: (key: string) => values[key],
    } as unknown as ConfigService;
    db = new ChinaPartsDb(createChinaPartsPool(configService));
    const config = new ChinaPartsConfig(configService);
    accounts = new ChinaPartsAccountsRepository(
      db,
      config,
      new ChinaPartsMediaRepository(db, config),
    );
    tokens = new TokensRepository(db);
  });

  afterAll(async () => {
    await db.onModuleDestroy();
    await infra.stop();
  });

  it('reads customers: public name, standing and currency, and Arabic-safe', async () => {
    const found = await accounts.getCustomers([1, 2, 3, 999]);

    expect(found).toEqual([
      {
        accountType: 'customer',
        externalId: 1,
        name: 'Sara K.',
        avatarUrl: 'http://localhost:8000/storage/customers/sara.jpg',
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
  });

  it('reads sellers: the shop name (Arabic), its logo, and standing from account status', async () => {
    const found = await accounts.getSellers([1, 2, 3]);

    expect(found).toEqual([
      {
        accountType: 'seller',
        externalId: 1,
        name: 'قطع غيار الرياض',
        avatarUrl: 'http://localhost:8000/storage/2/riyadh-logo.png',
        standing: 'good',
        preferredCurrency: null,
      },
      {
        accountType: 'seller',
        externalId: 2,
        name: 'Dammam Auto Parts',
        avatarUrl: null,
        standing: 'suspended',
        preferredCurrency: null,
      },
      {
        accountType: 'seller',
        externalId: 3,
        name: 'Yousef R.',
        avatarUrl: null,
        standing: 'suspended',
        preferredCurrency: null,
      },
    ]);
  });

  it('sees a change made in China Parts on the next read, and a deleted row as absent', async () => {
    await infra.rootQuery(
      'UPDATE customers SET status = 0, preferred_currency = ? WHERE id = 1',
      ['eur'],
    );
    const [changed] = await accounts.getCustomers([1]);
    expect(changed).toMatchObject({
      standing: 'suspended',
      preferredCurrency: 'EUR',
    });

    await infra.rootQuery(
      'UPDATE customers SET status = 1, preferred_currency = NULL WHERE id = 1',
    );

    await infra.rootQuery(
      "INSERT INTO customers (id, first_name, last_name, password) VALUES (50, 'Tmp', 'User', 'x')",
    );
    expect((await accounts.getCustomers([50])).length).toBe(1);
    await infra.rootQuery('DELETE FROM customers WHERE id = 50');
    expect(await accounts.getCustomers([50])).toEqual([]);
  });

  describe('Sanctum tokens', () => {
    const secret = 'integration-secret';
    const hash = createHash('sha256').update(secret).digest('hex');

    afterEach(async () => {
      await infra.rootQuery('DELETE FROM personal_access_tokens');
    });

    it('finds a token by id and by the hash of its secret', async () => {
      await infra.rootQuery(
        `INSERT INTO personal_access_tokens (id, tokenable_type, tokenable_id, name, token, abilities, created_at)
         VALUES (11, 'App\\\\Models\\\\Seller', 1, 'test', ?, '["*"]', '2026-10-01 08:00:00')`,
        [hash],
      );

      const byId = await tokens.findById(11);
      const byHash = await tokens.findByHash(hash);

      expect(byId).toEqual(byHash);
      expect(byId).toMatchObject({
        id: 11,
        tokenableType: 'App\\Models\\Seller',
        tokenableId: 1,
        tokenHash: hash,
        expiresAt: null,
      });
    });

    it('reads timestamps as UTC instants, whatever the server time zone is', async () => {
      await infra.rootQuery(
        `INSERT INTO personal_access_tokens (id, tokenable_type, tokenable_id, name, token, expires_at, created_at)
         VALUES (12, 'App\\\\Models\\\\Customer', 1, 'test', ?, '2026-12-01 10:30:00', '2026-10-01 08:00:00')`,
        [hash],
      );

      const token = await tokens.findById(12);

      expect(token?.expiresAt?.toISOString()).toBe('2026-12-01T10:30:00.000Z');
      expect(token?.createdAt?.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    });

    it('returns null for an unknown token', async () => {
      expect(await tokens.findById(404)).toBeNull();
      expect(await tokens.findByHash('0'.repeat(64))).toBeNull();
    });
  });

  it('is refused anything the grants do not allow, and reports it as 503 UPSTREAM_UNAVAILABLE', async () => {
    await expect(
      db.query('SELECT email FROM customers WHERE id = ?', [1]),
    ).rejects.toMatchObject({ status: 503 });
    await expect(db.query('SELECT * FROM customers')).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      db.query('UPDATE customers SET status = 0 WHERE id = 1'),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('answers 503 during an outage and recovers by itself afterwards', async () => {
    await infra.stopMysql();
    await expect(accounts.getCustomers([1])).rejects.toMatchObject({
      status: 503,
    });
    await expect(db.ping()).rejects.toMatchObject({ status: 503 });

    await infra.startMysql();
    await expect(db.ping()).resolves.toBeUndefined();
    expect((await accounts.getCustomers([1])).length).toBe(1);
  });
});
