import { Injectable, Logger } from '@nestjs/common';

/**
 * Activation is the moment shopper-visible prices change, and other modules
 * need to react to it — shelf labels today, and whatever comes next.
 *
 * The dependency runs ONE way: pricing knows nothing about its subscribers,
 * and a subscriber imports pricing. That is why this is a hub a listener
 * registers with at bootstrap rather than a provider pricing injects — the
 * latter would make PricingModule depend on EslModule and close a cycle.
 *
 * Delivery is best-effort ON PURPOSE. A shelf label that cannot be reached
 * must never fail the price change: the price is in force the moment the
 * activation transaction commits, whatever the hardware does afterwards. A
 * listener that misses an event is repaired by the ESL reconciliation sweep,
 * which compares each label's rendered version against the price actually in
 * force — see docs/product/esl.md.
 */
export interface PriceActivationEvent {
  readonly tenantId: string;
  readonly priceBookId: string;
  readonly priceBookVersionId: string;
  /** Null for a tenant-wide book. */
  readonly locationId: string | null;
  /** Products the activated version prices. */
  readonly productIds: readonly string[];
}

export interface PriceActivationListener {
  onVersionActivated(event: PriceActivationEvent): Promise<void>;
}

@Injectable()
export class PriceActivationHub {
  private readonly logger = new Logger(PriceActivationHub.name);
  private readonly listeners: PriceActivationListener[] = [];

  register(listener: PriceActivationListener): void {
    this.listeners.push(listener);
  }

  /**
   * Notifies every listener, isolating failures. Errors are logged by class
   * only — a listener's message could echo a gateway address, and nothing
   * about a price change is worth putting that in the log.
   */
  async publish(event: PriceActivationEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener.onVersionActivated(event);
      } catch (error) {
        this.logger.warn(
          `price activation listener ${listener.constructor.name} failed: ` +
            `${error instanceof Error ? error.name : 'UnknownError'}`,
        );
      }
    }
  }
}
