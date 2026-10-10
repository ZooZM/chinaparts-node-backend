import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import Redis from 'ioredis';
import type { Connection } from 'mongoose';
import { ErrorCode } from '../../common/errors/error-codes';
import { Access, SkipRateLimit } from '../../common/guards/access.decorator';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { ChinaPartsDb } from '../china-parts/mysql.provider';

type Dependency = 'mongodb' | 'redis' | 'mysql';
type Status = 'up' | 'down';

/** A dependency that does not answer in time counts as down, so readiness never hangs. */
const CHECK_TIMEOUT_MS = 2_000;

@Controller('health')
@Access('public')
@SkipRateLimit()
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly chinaParts: ChinaPartsDb,
  ) {}

  /** Liveness: the process is up. Never touches a dependency. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: MongoDB, Redis and China Parts' MySQL all answer. A failure is
   * `503 NOT_READY` naming what failed (research R26). Load balancers only read the status code.
   */
  @Get('ready')
  async ready(): Promise<{
    status: 'ready';
    checks: Record<Dependency, Status>;
  }> {
    const checks: Record<Dependency, Status> = {
      mongodb: await this.check(() => this.pingMongo()),
      redis: await this.check(() => this.redis.ping()),
      mysql: await this.check(() => this.chinaParts.ping()),
    };
    const down = (Object.keys(checks) as Dependency[]).filter(
      (name) => checks[name] === 'down',
    );
    if (down.length > 0) {
      throw new ServiceUnavailableException({
        error: ErrorCode.NOT_READY,
        message: `Not ready: ${down.join(', ')}`,
        details: checks,
      });
    }
    return { status: 'ready', checks };
  }

  private async pingMongo(): Promise<void> {
    const db = this.mongo.db;
    if (!db) throw new Error('MongoDB is not connected');
    await db.command({ ping: 1 });
  }

  private async check(probe: () => Promise<unknown>): Promise<Status> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out')),
            CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
