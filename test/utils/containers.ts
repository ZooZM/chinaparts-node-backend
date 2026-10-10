import { MySqlContainer } from '@testcontainers/mysql';
import { RedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { Connection, createConnection } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { AddressInfo, connect, createServer, Server, Socket } from 'node:net';
import { join } from 'node:path';

/**
 * Test infrastructure for the end-to-end suites: a MySQL 8.0 loaded with the China Parts schema
 * subset, and a Redis. Both come from Testcontainers unless these variables point at existing
 * instances (useful when Docker is not available, and in CI with service containers):
 *
 *   E2E_MYSQL_HOST, E2E_MYSQL_PORT (default 3306), E2E_MYSQL_ROOT_USER (default root),
 *   E2E_MYSQL_ROOT_PASSWORD  -> the `chinaparts_dev` database is dropped and recreated
 *   E2E_REDIS_URL            -> the selected database is flushed. Never point it at a real one.
 */

const FIXTURES = join(__dirname, '..', 'fixtures');
// Order matters: schema, then seed data, then the read-only grants.
const FIXTURE_FILES = [
  'chinaparts-schema.sql',
  'chinaparts-seed.sql',
  'grants.sql',
];

export const MYSQL_DATABASE = 'chinaparts_dev';
export const READ_ONLY_USER = {
  user: 'reels_ro',
  password: 'reels_ro_local',
} as const;
export const AUDIT_USER = {
  user: 'reels_audit',
  password: 'reels_audit_local',
} as const;

export interface MysqlSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface TestInfra {
  /** The reels_ro settings, reached through the outage proxy. Feed these to the app. */
  mysql: MysqlSettings;
  redisUrl: string;
  /** Runs SQL as root. Test-only setup such as inserting tokens or suspending a seller. */
  rootQuery<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  /** Opens a direct connection (not through the proxy) as the read-only or the audit user. */
  connectAs(kind: 'reels_ro' | 'reels_audit'): Promise<Connection>;
  /** Simulates a China Parts outage: refuses and drops every connection through the proxy. */
  stopMysql(): Promise<void>;
  startMysql(): Promise<void>;
  /** Clears every Redis key (caches, throttler counters, queues). */
  resetRedis(): Promise<void>;
  stop(): Promise<void>;
}

/** A TCP forwarder that can be switched off and on, to simulate the database being unreachable. */
class TcpProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private listenPort = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  get port(): number {
    return this.listenPort;
  }

  async start(): Promise<void> {
    const server = createServer((client) => {
      const upstream = connect(this.target.port, this.target.host);
      this.track(client);
      this.track(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.listenPort, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.listenPort = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }
}

async function openRoot(
  host: string,
  port: number,
  user: string,
  password: string,
): Promise<Connection> {
  return createConnection({
    host,
    port,
    user,
    password,
    multipleStatements: true,
    charset: 'utf8mb4',
  });
}

export async function startInfra(): Promise<TestInfra> {
  const closers: Array<() => Promise<void>> = [];

  // --- MySQL -------------------------------------------------------------------------------
  let mysqlHost: string;
  let mysqlPort: number;
  let rootUser = 'root';
  let rootPassword: string;
  const externalMysql = process.env.E2E_MYSQL_HOST !== undefined;

  if (externalMysql) {
    mysqlHost = process.env.E2E_MYSQL_HOST as string; // guarded by the check above
    mysqlPort = Number(process.env.E2E_MYSQL_PORT ?? 3306);
    rootUser = process.env.E2E_MYSQL_ROOT_USER ?? 'root';
    rootPassword = process.env.E2E_MYSQL_ROOT_PASSWORD ?? '';
  } else {
    const container = await new MySqlContainer('mysql:8.0')
      .withDatabase(MYSQL_DATABASE)
      .withRootPassword('root_local')
      .withCommand([
        '--character-set-server=utf8mb4',
        '--collation-server=utf8mb4_unicode_ci',
      ])
      .start();
    closers.push(async () => {
      await container.stop();
    });
    mysqlHost = container.getHost();
    mysqlPort = container.getPort();
    rootPassword = container.getRootPassword();
  }

  let root = await openRoot(mysqlHost, mysqlPort, rootUser, rootPassword);
  closers.push(async () => {
    await root.end().catch(() => undefined);
  });
  if (externalMysql) {
    await root.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``);
  }
  for (const file of FIXTURE_FILES) {
    await root.query(readFileSync(join(FIXTURES, file), 'utf8'));
  }
  await root.query(`USE \`${MYSQL_DATABASE}\``);

  const proxy = new TcpProxy({ host: mysqlHost, port: mysqlPort });
  await proxy.start();
  closers.push(() => proxy.stop());

  // --- Redis -------------------------------------------------------------------------------
  let redisUrl: string;
  if (process.env.E2E_REDIS_URL) {
    redisUrl = process.env.E2E_REDIS_URL;
  } else {
    const container = await new RedisContainer('redis:7-alpine').start();
    closers.push(async () => {
      await container.stop();
    });
    redisUrl = container.getConnectionUrl();
  }

  const resetRedis = async (): Promise<void> => {
    const client = new Redis(redisUrl);
    try {
      await client.flushdb();
    } finally {
      client.disconnect();
    }
  };
  await resetRedis();

  return {
    mysql: {
      host: '127.0.0.1',
      port: proxy.port,
      database: MYSQL_DATABASE,
      ...READ_ONLY_USER,
    },
    redisUrl,
    async rootQuery<T = unknown>(
      sql: string,
      params?: unknown[],
    ): Promise<T> {
      try {
        const [rows] = await root.query(sql, params);
        return rows as T;
      } catch (error) {
        // The root connection may have been dropped (idle timeout). Reconnect once.
        if ((error as { code?: string }).code !== 'PROTOCOL_CONNECTION_LOST') {
          throw error;
        }
        root = await openRoot(mysqlHost, mysqlPort, rootUser, rootPassword);
        await root.query(`USE \`${MYSQL_DATABASE}\``);
        const [rows] = await root.query(sql, params);
        return rows as T;
      }
    },
    async connectAs(kind: 'reels_ro' | 'reels_audit'): Promise<Connection> {
      const credentials = kind === 'reels_ro' ? READ_ONLY_USER : AUDIT_USER;
      return createConnection({
        host: mysqlHost,
        port: mysqlPort,
        database: MYSQL_DATABASE,
        charset: 'utf8mb4',
        ...credentials,
      });
    },
    stopMysql: () => proxy.stop(),
    startMysql: () => proxy.start(),
    resetRedis,
    async stop(): Promise<void> {
      for (const close of closers.reverse()) {
        await close().catch(() => undefined);
      }
    },
  };
}
