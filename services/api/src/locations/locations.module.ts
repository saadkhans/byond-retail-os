import { Module } from '@nestjs/common';
import {
  LocationsController,
  LocationsListController,
  StoresListController,
} from './locations.controller';
import { LocationsRepository } from './locations.repository';
import { LocationsService } from './locations.service';

@Module({
  controllers: [
    LocationsController,
    LocationsListController,
    StoresListController,
  ],
  providers: [LocationsService, LocationsRepository],
  exports: [LocationsService, LocationsRepository],
})
export class LocationsModule {}
