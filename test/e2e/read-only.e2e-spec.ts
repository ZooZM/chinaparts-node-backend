import type { RowDataPacket } from 'mysql2/promise';
import {
  QUEUE_ACCOUNTS_CLEANUP,
  QUEUE_MEDIA_VISIBILITY,
} from '../../src/common/queues/queue-names';
import { createTestApp, TestApp } from '../utils/app';
import {
  createPublishedReel,
  drainQueue,
  runSync,
  SAMPLE_10S,
} from '../utils/fixtures';
import { createPerson } from '../utils/people';
import { issueToken } from '../utils/tokens';

/**
 * SC-006: the reels service never changes anything in China Parts' database. Two proofs: the
 * database itself, because the user the service connects as has column-level SELECT and nothing
 * else, and the data, because a full run of everything the service does leaves every table exactly
 * as it was.
 */
describe('The China Parts database is read only (e2e)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
  });

  /** A checksum of every table, read by the audit user, which can read everything and write nothing. */
  async function checksums(): Promise<Record<string, number | null>> {
    const audit = await testApp.infra.connectAs('reels_audit');
    try {
      const [tables] = await audit.query<RowDataPacket[]>('SHOW TABLES');
      const names = tables.map((row) => String(Object.values(row)[0]));
      const result: Record<string, number | null> = {};
      for (const name of names) {
        const [rows] = await audit.query<RowDataPacket[]>(
          `CHECKSUM TABLE \`${name}\``,
        );
        result[name] = rows[0].Checksum as number | null;
      }
      return result;
    } finally {
      await audit.end();
    }
  }

  it('leaves every table exactly as it was after a full scripted run of the service', async () => {
    // Setup is China Parts' own doing, so it happens before the first checksum: the people and
    // their sessions, and an account that China Parts then deletes.
    // Fixture seller 1 owns products 101 and 102, which a reel may link.
    const seller = {
      externalId: 1,
      token: await issueToken(testApp.infra, 'seller', 1),
    };
    const fan = await createPerson(testApp, 'customer');
    const other = await createPerson(testApp, 'customer');
    const leaver = await createPerson(testApp, 'customer');
    const reel = await createPublishedReel(testApp, seller.externalId);
    await testApp.infra.rootQuery('DELETE FROM customers WHERE id = ?', [
      leaver.externalId,
    ]);

    const before = await checksums();
    expect(Object.keys(before).length).toBeGreaterThan(5);

    const api = testApp.api;
    // Sign in (every request validates the session), then use everything.
    await api.get('/api/users/me', { token: fan.token });
    const upload = await api.post<{ id: string }>('/api/reels', {
      token: seller.token,
      multipart: {
        fields: { description: 'a reel', productIds: '101' },
        files: [{ field: 'video', path: SAMPLE_10S, contentType: 'video/mp4' }],
      },
    });
    expect(upload.status).toBe(201);
    await api.post(`/api/reels/${reel.id}/like`, { token: fan.token });
    await api.post(`/api/reels/${reel.id}/save`, { token: fan.token });
    await api.post(`/api/reels/${reel.id}/view`, { token: fan.token });
    const comment = await api.post<{ comment: { id: string } }>(
      `/api/reels/${reel.id}/comments`,
      {
        token: fan.token,
        body: { text: 'a comment' },
      },
    );
    await api.post(`/api/reels/${reel.id}/report`, {
      token: other.token,
      body: { reason: 'spam' },
    });
    await api.post(
      `/api/reels/${reel.id}/comments/${comment.data.comment.id}/report`,
      {
        token: other.token,
        body: { reason: 'spam' },
      },
    );
    const sellerId = (
      await api.get<{ id: string }>('/api/users/me', { token: seller.token })
    ).data.id;
    await api.post(`/api/users/${sellerId}/follow`, { token: fan.token });
    await api.post(`/api/users/${other.id}/block`, { token: fan.token });
    await api.put(`/api/reels/${reel.id}/products`, {
      token: seller.token,
      body: { productIds: [101, 102] },
    });
    await api.get(`/api/reels/${reel.id}`, { token: fan.token });
    await api.get('/api/reels/search', { token: fan.token, query: { q: 'x' } });
    await api.patch('/api/users/me', {
      token: fan.token,
      body: { bio: 'hello' },
    });
    // The sync twice, which deletes the leaver and queues the cleanup, and everything that follows.
    await runSync(testApp);
    await runSync(testApp);
    await drainQueue(testApp, QUEUE_ACCOUNTS_CLEANUP);
    await drainQueue(testApp, QUEUE_MEDIA_VISIBILITY);
    // A suspension too: standing is read, never written.
    await testApp.infra.rootQuery(
      "UPDATE sellers SET status = 'suspended' WHERE id = ?",
      [seller.externalId],
    );
    const suspended = await checksums();
    await runSync(testApp);
    await drainQueue(testApp, QUEUE_MEDIA_VISIBILITY);
    const afterSuspension = await checksums();

    expect(afterSuspension).toEqual(suspended);
    // Only the tables the setup and the suspension changed differ from the start: China Parts' own.
    const changed = Object.keys(before).filter(
      (name) => before[name] !== suspended[name],
    );
    expect(changed.sort()).toEqual(['sellers']);
  });

  describe('the database user the service connects as', () => {
    async function asReadOnly<T>(
      run: (
        connection: Awaited<ReturnType<TestApp['infra']['connectAs']>>,
      ) => Promise<T>,
    ) {
      const connection = await testApp.infra.connectAs('reels_ro');
      try {
        return await run(connection);
      } finally {
        await connection.end();
      }
    }

    it.each([
      [
        'inserting a customer',
        "INSERT INTO customers (first_name, last_name, password) VALUES ('a', 'b', 'c')",
      ],
      [
        'updating a customer',
        "UPDATE customers SET first_name = 'x' WHERE id = 1",
      ],
      ['deleting a customer', 'DELETE FROM customers WHERE id = 1'],
      [
        'updating a token',
        'UPDATE personal_access_tokens SET last_used_at = NOW()',
      ],
      ['dropping a table', 'DROP TABLE customers'],
      ['truncating a table', 'TRUNCATE TABLE products'],
      ['creating a table', 'CREATE TABLE intruder (id INT)'],
    ])('refuses %s', async (_label, statement) => {
      await expect(asReadOnly((c) => c.query(statement))).rejects.toMatchObject(
        {
          code: expect.stringMatching(
            /ACCESS_DENIED|TABLEACCESS_DENIED|COLUMNACCESS_DENIED|DBACCESS_DENIED/,
          ) as string,
        },
      );
    });

    it.each([
      ["a customer's email", 'SELECT email FROM customers'],
      ["a customer's password", 'SELECT password FROM customers'],
      ["a customer's phone", 'SELECT phone FROM customers'],
      ['everything about a customer', 'SELECT * FROM customers'],
      ["a seller's national id", 'SELECT national_id_number FROM sellers'],
      ["a seller's email", 'SELECT email FROM sellers'],
      [
        "a seller's commission",
        'SELECT sales_commission_percentage FROM sellers',
      ],
      ["a product's cost price", 'SELECT cost_price FROM product_variants'],
    ])('refuses to read %s', async (_label, statement) => {
      await expect(asReadOnly((c) => c.query(statement))).rejects.toMatchObject(
        {
          code: expect.stringMatching(
            /ACCESS_DENIED|COLUMNACCESS_DENIED|TABLEACCESS_DENIED/,
          ) as string,
        },
      );
    });

    it('reads what the service needs, and only that', async () => {
      const [rows] = await asReadOnly((c) =>
        c.query<RowDataPacket[]>(
          'SELECT id, first_name, last_name, status, preferred_currency FROM customers WHERE id = 1',
        ),
      );
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual([
        'first_name',
        'id',
        'last_name',
        'preferred_currency',
        'status',
      ]);
    });
  });
});
