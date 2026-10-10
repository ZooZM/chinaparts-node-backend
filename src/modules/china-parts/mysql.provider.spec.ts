import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { ChinaPartsDb } from './mysql.provider';

function dbWith(query: jest.Mock): { db: ChinaPartsDb; end: jest.Mock } {
  const end = jest.fn().mockResolvedValue(undefined);
  const db = new ChinaPartsDb({ query, end } as unknown as Pool);
  return { db, end };
}

describe('ChinaPartsDb', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs a parameterized query with a timeout and returns its rows', async () => {
    const query = jest.fn().mockResolvedValue([[{ id: 7 }], []]);
    const { db } = dbWith(query);

    const rows = await db.query('SELECT id FROM customers WHERE id = ?', [7]);

    expect(rows).toEqual([{ id: 7 }]);
    expect(query).toHaveBeenCalledWith({
      sql: 'SELECT id FROM customers WHERE id = ?',
      values: [7],
      timeout: 5000,
    });
  });

  it.each([
    [
      'a refused connection',
      { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.5:3306' },
    ],
    [
      'a denied column',
      {
        code: 'ER_COLUMNACCESS_DENIED_ERROR',
        message: 'SELECT command denied',
      },
    ],
    [
      'a timeout',
      {
        code: 'PROTOCOL_SEQUENCE_TIMEOUT',
        message: 'Query inactivity timeout',
      },
    ],
  ])(
    'turns %s into 503 UPSTREAM_UNAVAILABLE without leaking the driver message',
    async (_label, error) => {
      const { db } = dbWith(
        jest
          .fn()
          .mockRejectedValue(Object.assign(new Error(error.message), error)),
      );

      const failure = await db.query('SELECT 1').catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ServiceUnavailableException);
      const body = (failure as ServiceUnavailableException).getResponse();
      expect(body).toEqual({
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'China Parts is temporarily unavailable',
      });
      expect(JSON.stringify(body)).not.toContain('10.0.0.5');
    },
  );

  it('logs the driver error code server-side, never the query values', async () => {
    const logged: string[] = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    const { db } = dbWith(
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('down'), { code: 'ECONNREFUSED' }),
        ),
    );

    await db
      .query('SELECT id FROM personal_access_tokens WHERE token = ?', [
        'secret-hash',
      ])
      .catch(() => undefined);

    expect(logged.join(' ')).toContain('ECONNREFUSED');
    expect(logged.join(' ')).not.toContain('secret-hash');
  });

  it('pings with a trivial query', async () => {
    const query = jest.fn().mockResolvedValue([[{ ok: 1 }], []]);
    await dbWith(query).db.ping();
    const [[call]] = query.mock.calls as Array<[{ sql: string }]>;
    expect(call.sql).toBe('SELECT 1 AS ok');
  });

  it('reports an unreachable database from ping as 503', async () => {
    const { db } = dbWith(jest.fn().mockRejectedValue(new Error('ETIMEDOUT')));
    await expect(db.ping()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('closes the pool on shutdown', async () => {
    const { db, end } = dbWith(jest.fn());
    await db.onModuleDestroy();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
