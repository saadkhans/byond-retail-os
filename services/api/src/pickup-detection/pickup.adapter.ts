import { BadRequestException, Injectable } from '@nestjs/common';
import { InferenceJobType } from '@prisma/client';
import {
  InferenceAdapter,
  InferenceAdapterInput,
  InferenceAdapterRawOutput,
  InferenceJobContext,
  NormalizedInferenceResult,
} from '../inference/adapters/inference-adapter';
import { SimulatedInferenceAdapter } from '../inference/adapters/simulated.adapter';
import { PICKUP_ADAPTER_KEY } from './pickup-detection.service';

/**
 * Phase 9 adapter registration for the Phase 10 pickup pipeline.
 *
 * WHERE THE REAL WORK LIVES: the pixel analysis (motion window, removal
 * region, reference matching) runs in PickupDetectionService BEFORE the
 * job's `complete` call — the adapter seam receives the already-computed
 * detections and owns validation + normalization, exactly like every other
 * adapter. `run()` therefore echoes its input; the adapterKey and the
 * result's modelKey (`classical-hsv-histogram+ncc`) record precisely which
 * method produced the numbers. Nothing here fabricates a detection.
 *
 * Validation and normalization DELEGATE to the simulated adapter's
 * implementations — those are the pinned Phase 8/9 contract semantics
 * (occurredAt offset rule, quantity sign rules, dedupe/rank/round-half-even)
 * — with the job-type gate tightened to PRODUCT_RECOGNITION only.
 */
@Injectable()
export class PickupClassicalAdapter implements InferenceAdapter {
  readonly adapterKey = PICKUP_ADAPTER_KEY;
  readonly supportedJobTypes: readonly InferenceJobType[] = [
    InferenceJobType.PRODUCT_RECOGNITION,
  ];

  private readonly contractDelegate = new SimulatedInferenceAdapter();

  validateInput(
    context: InferenceJobContext,
    input: InferenceAdapterInput,
  ): void {
    if (!this.supportedJobTypes.includes(context.jobType)) {
      throw new BadRequestException(
        `Adapter "${this.adapterKey}" does not support job type ${context.jobType}`,
      );
    }
    this.contractDelegate.validateInput(context, input);
  }

  run(
    _context: InferenceJobContext,
    input: InferenceAdapterInput,
  ): Promise<InferenceAdapterRawOutput> {
    return Promise.resolve(input);
  }

  normalizeResult(
    output: InferenceAdapterRawOutput,
  ): NormalizedInferenceResult {
    return this.contractDelegate.normalizeResult(output);
  }
}
