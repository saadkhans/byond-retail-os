import { Module } from '@nestjs/common';
import { UnitsModule } from '../units/units.module';
import { DevicesController } from './devices.controller';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';
import { EdgeRegistrationController } from './edge-registration.controller';
import { EdgeRegistrationRepository } from './edge-registration.repository';
import { EdgeRegistrationService } from './edge-registration.service';

@Module({
  imports: [UnitsModule],
  controllers: [DevicesController, EdgeRegistrationController],
  providers: [
    DevicesService,
    DevicesRepository,
    EdgeRegistrationService,
    EdgeRegistrationRepository,
  ],
})
export class DevicesModule {}
