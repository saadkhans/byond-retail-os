import { Injectable } from '@nestjs/common';
import { InferenceAdapter } from './inference-adapter';
import { SimulatedInferenceAdapter } from './simulated.adapter';

/**
 * Registry of available inference adapters, keyed by their opaque
 * adapterKey. Phase 9 registers exactly one: the simulated adapter. Future
 * provider adapters register here without touching core job/queue code —
 * the service resolves adapters only through this registry.
 */
@Injectable()
export class InferenceAdapterRegistry {
  private readonly adapters = new Map<string, InferenceAdapter>();

  constructor(simulated: SimulatedInferenceAdapter) {
    this.register(simulated);
  }

  register(adapter: InferenceAdapter): void {
    this.adapters.set(adapter.adapterKey, adapter);
  }

  get(adapterKey: string): InferenceAdapter | undefined {
    return this.adapters.get(adapterKey);
  }

  keys(): string[] {
    return [...this.adapters.keys()];
  }
}
