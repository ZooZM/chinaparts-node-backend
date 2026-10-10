import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

/**
 * Holds startup until every collection's indexes exist.
 *
 * Mongoose builds a model's indexes in the background once it connects. That is too late for the
 * unique indexes this service relies on: a request that arrives in the first moments, such as a
 * user's first sign-in, could be provisioned before the unique index on the handle exists and
 * create a duplicate (FR-006, FR-015). Waiting here means the first request is served only when
 * the constraints that make concurrent first requests safe are in place. Building an index that
 * already exists is a no-op, so a restart is not slowed down.
 *
 * It fails closed: if an index cannot be built (for example existing data that breaks a unique
 * rule), startup fails and says so, instead of running without the constraint.
 */
@Injectable()
export class MongoIndexesReady implements OnModuleInit {
  private readonly logger = new Logger(MongoIndexesReady.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onModuleInit(): Promise<void> {
    const models = Object.values(this.connection.models);
    await Promise.all(models.map((model) => model.init()));
    this.logger.log(`Indexes are in place for ${models.length} collections`);
  }
}
