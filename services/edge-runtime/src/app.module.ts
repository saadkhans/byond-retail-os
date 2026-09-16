import { Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { EdgeConfigModule } from './config/edge-config.module';
import { NodeIdentityService } from './config/node-identity.service';
import { DecisioningModule } from './decisioning/decisioning.module';
import { DriverRegistryService } from './hardware/driver-registry.service';
import { HardwareModule } from './hardware/hardware.module';
import { LedgerModule } from './ledger/ledger.module';
import { LocalLedgerService } from './ledger/local-ledger.service';
import { LoggingModule } from './logging/logging.module';
import { OpsModule } from './ops/ops.module';
import { EdgeStoreModule } from './store/edge-store.module';
import { SyncModule } from './sync/sync.module';
import { SyncService } from './sync/sync.service';

@Module({
  imports: [
    EdgeConfigModule,
    LoggingModule,
    EdgeStoreModule,
    LedgerModule,
    SyncModule,
    DecisioningModule,
    HardwareModule,
    OpsModule,
  ],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly identity: NodeIdentityService,
    private readonly ledger: LocalLedgerService,
    private readonly sync: SyncService,
    private readonly drivers: DriverRegistryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Tenant first: a store sealed to another tenant, location or device must
    // stop the node before a single fact is read out of it or pushed up under
    // this device's credential.
    await this.identity.seal();
    // Stock is a projection: rebuild it from the ledger before anything reads
    // it, so a restart can never resume from a stale cached number.
    await this.ledger.rebuild();
    this.drivers.registerConfigured();
    await this.drivers.connectAll();
    this.drivers.start();
    this.sync.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.sync.stop();
    this.drivers.stop();
    await this.drivers.disconnectAll();
  }
}
