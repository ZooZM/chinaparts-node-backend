import type { Type } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { startInfra, TestInfra } from './containers';
import { TestApi } from './api';

export const ADMIN_KEY = 'e2e-admin-key';

/**
 * What a test app gets by default. Rate limits are generous so an unrelated test never trips one;
 * a suite that is about a limit overrides it through `env`. Everything else is the production
 * default, so a test exercises the same configuration a deployment would.
 */
function defaultEnv(infra: TestInfra, mongoUri: string, storageDir: string) {
  return {
    NODE_ENV: 'test',
    PORT: '0',
    WORKER_ROLE: 'all',
    MONGODB_URI: mongoUri,
    REDIS_URL: infra.redisUrl,
    CHINAPARTS_MYSQL_HOST: infra.mysql.host,
    CHINAPARTS_MYSQL_PORT: String(infra.mysql.port),
    CHINAPARTS_MYSQL_DATABASE: infra.mysql.database,
    CHINAPARTS_MYSQL_USER: infra.mysql.user,
    CHINAPARTS_MYSQL_PASSWORD: infra.mysql.password,
    CHINAPARTS_MYSQL_SSL: 'false',
    CHINAPARTS_DISK_URLS: 'public=http://china-parts.test/storage',
    CHINAPARTS_PUBLIC_STORAGE_URL: 'http://china-parts.test/storage',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: storageDir,
    S3_PRIVATE_BUCKET: 'reels-private',
    S3_PUBLIC_BUCKET: 'reels-public',
    MEDIA_PUBLIC_BASE_URL: 'http://media.test/reels-public',
    MODERATION_PROVIDER: 'stub',
    ADMIN_API_KEY: ADMIN_KEY,
    IP_RATE_LIMIT_PER_MINUTE: '100000',
    USER_RATE_LIMIT_PER_MINUTE: '100000',
    GUEST_RATE_LIMIT_PER_MINUTE: '100000',
    UPLOAD_RATE_LIMIT_PER_HOUR: '1000',
    WRITE_RATE_LIMIT_PER_MINUTE: '1000',
    LINKS_PUBLIC_BASE_URL: 'http://reels.test',
    SEED_DEMO_CONTENT: 'false',
  } satisfies Record<string, string>;
}

export interface TestApp {
  app: NestExpressApplication;
  api: TestApi;
  infra: TestInfra;
  mongoUri: string;
  /** Where the local storage driver writes: `<storageDir>/<bucket>/<key>`. */
  storageDir: string;
  /** Deletes every Mongo document and Redis key, keeping indexes. Leaves China Parts alone. */
  resetReelsData(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  /** Overrides for the environment the app boots with, for example a tiny rate limit. */
  env?: Record<string, string>;
  /** Extra controllers, for a probe route a suite needs that the product does not have. */
  controllers?: Array<Type<unknown>>;
  /** Lets a suite replace a provider, for example the push client. */
  configure?: (builder: ReturnType<typeof Test.createTestingModule>) => void;
}

/**
 * Boots the whole `AppModule` against real services: a MySQL with the China Parts fixtures and a
 * Redis (from `startInfra`), an in-memory MongoDB replica set, and the local storage driver. The
 * app is configured by the same `configureApp` as production.
 */
export async function createTestApp(
  options: CreateTestAppOptions = {},
): Promise<TestApp> {
  const infra = await startInfra();
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const storageDir = await mkdtemp(join(tmpdir(), 'reels-e2e-storage-'));

  // ConfigModule reads `process.env`. Set every key this app cares about, and put the process
  // back as found on close, so one suite never leaks into the next.
  const env = {
    ...defaultEnv(infra, mongo.getUri('reels'), storageDir),
    ...options.env,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  let app: NestExpressApplication | undefined;
  try {
    const builder = Test.createTestingModule({
      imports: [AppModule.register()],
      controllers: options.controllers ?? [],
    });
    options.configure?.(builder);
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  } catch (error) {
    await app?.close().catch(() => undefined);
    await mongo.stop().catch(() => undefined);
    await infra.stop();
    await rm(storageDir, { recursive: true, force: true });
    restore(previous);
    throw error;
  }

  const ready = app;
  return {
    app: ready,
    api: new TestApi(ready.getHttpServer()),
    infra,
    mongoUri: mongo.getUri('reels'),
    storageDir,
    async resetReelsData(): Promise<void> {
      const connection = ready.get<Connection>(getConnectionToken());
      const collections = await connection.db?.collections();
      for (const collection of collections ?? []) {
        await collection.deleteMany({});
      }
      await infra.resetRedis();
    },
    async close(): Promise<void> {
      await ready.close();
      await mongo.stop();
      await infra.stop();
      await rm(storageDir, { recursive: true, force: true });
      restore(previous);
    },
  };
}

function restore(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
