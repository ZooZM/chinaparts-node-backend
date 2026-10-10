import { Global, Module } from '@nestjs/common';
import { LimitsService } from './config/limits';
import { MongoIndexesReady } from './mongo/indexes-ready.service';
import { MaxLengthFromConfigConstraint } from './validation/max-length-from-config';

/** Cross-cutting, domain-agnostic providers that every feature module may inject. */
@Global()
@Module({
  providers: [LimitsService, MaxLengthFromConfigConstraint, MongoIndexesReady],
  exports: [LimitsService, MaxLengthFromConfigConstraint],
})
export class CommonModule {}
