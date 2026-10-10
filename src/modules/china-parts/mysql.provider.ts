import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPool } from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ErrorCode } from '../../common/errors/error-codes';

export const CHINAPARTS_POOL = Symbol('CHINAPARTS_POOL');

/** Fails fast: a slow China Parts must not stall every request behind a connection. */
const QUERY_TIMEOUT_MS = 5_000;

/**
 * The read-only connection to China Parts' MySQL (research R3). The configured user has
 * column-level `SELECT` grants only, so the service physically cannot write to China Parts or
 * read a private column, whatever a query says.
 */
export function createChinaPartsPool(config: ConfigService): Pool {
  const pool = createPool({
    host: config.get<string>('CHINAPARTS_MYSQL_HOST'),
    port: config.get<number>('CHINAPARTS_MYSQL_PORT'),
    database: config.get<string>('CHINAPARTS_MYSQL_DATABASE'),
    user: config.get<string>('CHINAPARTS_MYSQL_USER'),
    password: config.get<string>('CHINAPARTS_MYSQL_PASSWORD'),
    ssl:
      config.get<boolean>('CHINAPARTS_MYSQL_SSL') === true
        ? { rejectUnauthorized: true }
        : undefined,
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 5_000,
    charset: 'utf8mb4',
    // Timestamps are read as UTC whatever the server's own zone is (see the connection hook).
    timezone: 'Z',
  });
  // Laravel stores TIMESTAMP columns in UTC. Reading them in a session pinned to UTC means a
  // token's `expires_at` is compared as the same instant China Parts wrote, on any server.
  //
  // Listen on the core (callback) pool: the promise pool re-emits this event with the core
  // connection, whatever its typings say, and awaiting or `.catch`-ing it there never settles.
  // Commands on a connection run in the order they are queued, so this runs before any query.
  pool.pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'", () => undefined);
  });
  return pool;
}

/**
 * Thin wrapper over the pool. Every driver error, from a refused connection to a denied column,
 * becomes `503 UPSTREAM_UNAVAILABLE`: the service never grants anything it could not verify and
 * never treats an outage as "no data" (constitution exception 1, error table in rest-api.md).
 */
@Injectable()
export class ChinaPartsDb implements OnModuleDestroy {
  private readonly logger = new Logger(ChinaPartsDb.name);

  constructor(@Inject(CHINAPARTS_POOL) private readonly pool: Pool) {}

  /** Parameterized: values go through the driver's escaping, never into the SQL text. */
  async query<T extends RowDataPacket>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    try {
      const [rows] = await this.pool.query<T[]>({
        sql,
        values,
        timeout: QUERY_TIMEOUT_MS,
      });
      return rows;
    } catch (error) {
      // Message and code only: never the values, which may include token hashes.
      const detail = error as { code?: string; message?: string };
      this.logger.error(
        `China Parts query failed: ${detail.code ?? 'UNKNOWN'} ${detail.message ?? ''}`,
      );
      throw new ServiceUnavailableException({
        error: ErrorCode.UPSTREAM_UNAVAILABLE,
        message: 'China Parts is temporarily unavailable',
      });
    }
  }

  /** For the readiness probe. Throws `503 UPSTREAM_UNAVAILABLE` when MySQL is down. */
  async ping(): Promise<void> {
    await this.query('SELECT 1 AS ok');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
