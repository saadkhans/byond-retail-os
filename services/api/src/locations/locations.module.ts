import { Module } from '@nestjs/common';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

// Service-level only in Phase 1: no controller until auth exists.
@Module({
  providers: [LocationsService, LocationsRepository],
  exports: [LocationsService],
})
export class LocationsModule {}
