import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessControlModule } from './access-control/access-control.module';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { LocationsModule } from './locations/locations.module';
import { PlatformModulesModule } from './platform-modules/platform-modules.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    HealthModule,
    TenantsModule,
    UsersModule,
    AccessControlModule,
    LocationsModule,
    PlatformModulesModule,
  ],
})
export class AppModule {}
