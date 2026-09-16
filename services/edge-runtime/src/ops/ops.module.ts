import { Module } from '@nestjs/common';
import { DecisioningModule } from '../decisioning/decisioning.module';
import { HardwareModule } from '../hardware/hardware.module';
import { SyncModule } from '../sync/sync.module';
import { MetricsService } from './metrics.service';
import { OpsController } from './ops.controller';

@Module({
  imports: [SyncModule, DecisioningModule, HardwareModule],
  controllers: [OpsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class OpsModule {}
