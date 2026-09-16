import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { DriverRegistryService } from './driver-registry.service';
import { SIMULATED_DRIVER_FACTORIES } from './drivers/simulated-drivers';
import { DRIVER_FACTORIES } from './hardware.port';

@Module({
  imports: [SyncModule],
  providers: [
    { provide: DRIVER_FACTORIES, useValue: SIMULATED_DRIVER_FACTORIES },
    DriverRegistryService,
  ],
  exports: [DriverRegistryService, DRIVER_FACTORIES],
})
export class HardwareModule {}
