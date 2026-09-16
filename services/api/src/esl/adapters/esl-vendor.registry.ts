import { Injectable } from '@nestjs/common';
import { normalizeVendorCode } from '../esl.logic';
import { EslVendorPort, EslVendorRegistryPort } from '../ports';
import { SimulatedEslAdapter } from './simulated-esl.adapter';

/**
 * vendorCode → adapter. Adding a real vendor is a new file implementing
 * EslVendorPort plus one line in this constructor; no service, controller or
 * repository changes, which is exactly what AGENTS.md's adapter-first rule
 * asks for.
 *
 * Resolution is total: an unknown code returns null and the caller fails the
 * job UNKNOWN_VENDOR rather than throwing, so one misconfigured gateway can
 * never take the processing pass down with it.
 */
@Injectable()
export class EslVendorRegistry implements EslVendorRegistryPort {
  private readonly adapters = new Map<string, EslVendorPort>();

  constructor(simulated: SimulatedEslAdapter) {
    this.register(simulated);
  }

  private register(adapter: EslVendorPort): void {
    this.adapters.set(normalizeVendorCode(adapter.vendorCode), adapter);
  }

  resolve(vendorCode: string): EslVendorPort | null {
    return this.adapters.get(normalizeVendorCode(vendorCode)) ?? null;
  }

  vendorCodes(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
