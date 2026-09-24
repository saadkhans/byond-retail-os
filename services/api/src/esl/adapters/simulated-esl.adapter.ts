import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EslUpdateErrorCode } from '@prisma/client';
import { SIMULATED_VENDOR_CODE } from '../esl.constants';
import {
  EslGatewayContext,
  EslPushOutcome,
  EslPushRequest,
  EslVendorLabel,
  EslVendorPort,
} from '../ports';

/**
 * The adapter every deployment has. It talks to nothing: dev, test and CI can
 * exercise the whole propagation path — batching, partial failure, retry,
 * health — with no hardware, no network and no vendor account.
 *
 * Behaviour is DETERMINISTIC and derived from the label id, so a test can
 * choose an outcome by naming a label rather than by stubbing the adapter:
 *
 * - an id containing `-UNREACHABLE` fails LABEL_UNREACHABLE (retryable),
 * - an id containing `-REJECT` fails VENDOR_REJECTED (retryable),
 * - an id containing `-TIMEOUT` fails VENDOR_TIMEOUT (retryable),
 * - anything else succeeds.
 *
 * Battery and signal are a stable hash of the id, so repeated reads do not
 * make a label look like it is flapping.
 */
@Injectable()
export class SimulatedEslAdapter extends EslVendorPort {
  readonly vendorCode = SIMULATED_VENDOR_CODE;

  discoverLabels(ctx: EslGatewayContext): Promise<EslVendorLabel[]> {
    // A simulated gateway reports three labels whose ids derive from its own
    // code, so two gateways in one tenant never collide.
    const labels = [1, 2, 3].map((index) =>
      this.describe(`${ctx.gatewayCode}-SIM-${index}`),
    );
    return Promise.resolve(labels);
  }

  readHealth(
    _ctx: EslGatewayContext,
    vendorLabelId: string,
  ): Promise<EslVendorLabel | null> {
    return Promise.resolve(this.describe(vendorLabelId));
  }

  pushBatch(
    _ctx: EslGatewayContext,
    requests: readonly EslPushRequest[],
  ): Promise<EslPushOutcome[]> {
    return Promise.resolve(
      requests.map((request) => this.push(request.vendorLabelId)),
    );
  }

  private push(vendorLabelId: string): EslPushOutcome {
    const upper = vendorLabelId.toUpperCase();
    const failure = FAILURE_MARKERS.find(([marker]) => upper.includes(marker));
    if (failure) {
      return {
        vendorLabelId,
        ok: false,
        errorCode: failure[1],
        message: `simulated ${failure[1].toLowerCase()}`,
      };
    }
    return { vendorLabelId, ok: true, label: this.describe(vendorLabelId) };
  }

  private describe(vendorLabelId: string): EslVendorLabel {
    const digest = createHash('sha256').update(vendorLabelId).digest();
    return {
      vendorLabelId,
      // 40–100 %: a simulated label is never reported as flat, which would
      // make "replace the battery" advice meaningless in a demo.
      batteryPercent: 40 + (digest[0] % 61),
      signalPercent: 40 + (digest[1] % 61),
    };
  }
}

const FAILURE_MARKERS: ReadonlyArray<readonly [string, EslUpdateErrorCode]> = [
  ['-UNREACHABLE', EslUpdateErrorCode.LABEL_UNREACHABLE],
  ['-REJECT', EslUpdateErrorCode.VENDOR_REJECTED],
  ['-TIMEOUT', EslUpdateErrorCode.VENDOR_TIMEOUT],
];
