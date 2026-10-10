import { Module } from '@nestjs/common';
import { ChinaPartsModule } from '../china-parts/china-parts.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ChinaPartsModule],
  controllers: [HealthController],
})
export class HealthModule {}
