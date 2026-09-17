import { Module } from '@nestjs/common';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { PricingModule } from '../pricing/pricing.module';
import { EslVendorRegistry } from './adapters/esl-vendor.registry';
import { SimulatedEslAdapter } from './adapters/simulated-esl.adapter';
import { EslQueueConfig } from './esl-queue.config';
import { EslQueueWorker } from './esl-queue.worker';
import { EslController } from './esl.controller';
import { EslRepository } from './esl.repository';
import { EslService } from './esl.service';
import { ESL_VENDOR_REGISTRY } from './ports';

/**
 * Electronic shelf labels. The dependency on pricing runs ONE way: this
 * module imports PricingModule and subscribes to PriceActivationHub at
 * bootstrap, so pricing never learns that labels exist and the module graph
 * stays acyclic.
 *
 * Adding a real vendor means one new adapter class registered in
 * EslVendorRegistry — no controller, service or repository change
 * (AGENTS.md adapter-first rule).
 *
 * EslQueueWorker is the clock behind the queue: it calls the same service
 * methods the operator routes call, and it is OFF unless
 * ESL_QUEUE_WORKER_ENABLED says otherwise, so registering it here costs a
 * deployment that drives the queue some other way exactly nothing.
 */
@Module({
  imports: [PlatformModulesModule, PricingModule],
  controllers: [EslController],
  providers: [
    EslService,
    EslRepository,
    EslQueueConfig,
    EslQueueWorker,
    SimulatedEslAdapter,
    EslVendorRegistry,
    { provide: ESL_VENDOR_REGISTRY, useExisting: EslVendorRegistry },
  ],
  exports: [EslService],
})
export class EslModule {}
