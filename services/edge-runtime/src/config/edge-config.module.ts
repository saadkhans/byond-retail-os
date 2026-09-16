import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EdgeConfigService } from './edge-config.service';
import { NodeIdentityService } from './node-identity.service';
import { validateEdgeEnv } from './env.validation';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEdgeEnv,
    }),
  ],
  providers: [EdgeConfigService, NodeIdentityService],
  exports: [EdgeConfigService, NodeIdentityService],
})
export class EdgeConfigModule {}
