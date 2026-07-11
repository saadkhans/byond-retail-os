import { Module } from '@nestjs/common';
import { LocationsModule } from '../locations/locations.module';
import { UnitsController } from './units.controller';
import { UnitsRepository } from './units.repository';
import { UnitsService } from './units.service';

@Module({
  imports: [LocationsModule],
  controllers: [UnitsController],
  providers: [UnitsService, UnitsRepository],
  exports: [UnitsRepository],
})
export class UnitsModule {}
