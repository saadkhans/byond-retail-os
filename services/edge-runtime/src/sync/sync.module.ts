import { Module } from '@nestjs/common';
import { EdgeConfigService } from '../config/edge-config.service';
import { LoggingModule } from '../logging/logging.module';
import { CLOUD_CLIENT, CloudClientPort } from './cloud-client.port';
import { ConfigurationService } from './configuration.service';
import { HttpCloudClient } from './http-cloud-client.adapter';
import { OfflineCloudClient } from './offline-cloud-client.adapter';
import { OutboxService } from './outbox.service';
import { SyncService } from './sync.service';

@Module({
  imports: [LoggingModule],
  providers: [
    {
      provide: CLOUD_CLIENT,
      inject: [EdgeConfigService],
      useFactory: (config: EdgeConfigService): CloudClientPort => {
        const baseUrl = config.cloudBaseUrl;
        const token = config.cloudToken;
        // An unconfigured node runs offline on purpose: facts accumulate in
        // the outbox rather than being discarded by a no-op client.
        if (baseUrl === undefined || token === undefined) {
          return new OfflineCloudClient();
        }
        return new HttpCloudClient(baseUrl, token, config.deviceId);
      },
    },
    OutboxService,
    ConfigurationService,
    SyncService,
  ],
  exports: [OutboxService, ConfigurationService, SyncService, CLOUD_CLIENT],
})
export class SyncModule {}
