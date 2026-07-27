import { Module } from '@nestjs/common';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { VisionModule } from '../vision/vision.module';
import { InferenceAdapterRegistry } from './adapters/adapter.registry';
import { SimulatedInferenceAdapter } from './adapters/simulated.adapter';
import { InferenceJobsController } from './inference-jobs.controller';
import { InferenceJobsRepository } from './inference-jobs.repository';
import { InferenceJobsService } from './inference-jobs.service';
import { InferenceQueuePort } from './queue/inference-queue.port';
import { PrismaInferenceQueue } from './queue/prisma-inference-queue';

/**
 * Phase 9 — CV inference adapter & event queue foundation. The module owns
 * the provider-neutral job lifecycle (QUEUED → RUNNING → SUCCEEDED/FAILED),
 * the database-backed queue behind InferenceQueuePort (message-broker
 * adapters can replace it later without touching core code), the simulated
 * adapter (the only Phase 9 implementation — no real ML), and the
 * conversion of successful results into Phase 7 vision events through the
 * EXISTING VisionEventsService ingest contract.
 */
@Module({
  imports: [VisionModule, PlatformModulesModule],
  controllers: [InferenceJobsController],
  providers: [
    InferenceJobsService,
    InferenceJobsRepository,
    SimulatedInferenceAdapter,
    InferenceAdapterRegistry,
    { provide: InferenceQueuePort, useClass: PrismaInferenceQueue },
  ],
  // Phase 10 creates inference jobs from crop artifacts through the SAME
  // service contract (screening, idempotency, queue semantics) — never by
  // writing job rows directly.
  exports: [InferenceJobsService],
})
export class InferenceModule {}
