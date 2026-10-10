import { Global, Module } from '@nestjs/common';
import { LimitsService } from './config/limits';
import { MaxLengthFromConfigConstraint } from './validation/max-length-from-config';

/** Cross-cutting, domain-agnostic providers that every feature module may inject. */
@Global()
@Module({
  providers: [LimitsService, MaxLengthFromConfigConstraint],
  exports: [LimitsService, MaxLengthFromConfigConstraint],
})
export class CommonModule {}
