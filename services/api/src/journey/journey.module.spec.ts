import {
  CustomerJourneyEventType,
  JourneyEventReviewDecision,
} from '@prisma/client';
import { RequestContext } from '../auth/request-context';
import { AppendJourneyEventDto } from './dto/append-journey-event.dto';
import { ReviewJourneyEventDto } from './dto/review-journey-event.dto';
import { JourneyController } from './journey.module';
import { JourneyService } from './journey.service';

/**
 * Defense-in-depth behind the DTO layer: even if a forged provenance
 * field somehow reached the handler (pipe misconfiguration, direct
 * call), the MANUAL append endpoint forwards ONLY the declared
 * manual-event fields — the service can never receive sourceType /
 * videoAssetId / fusionRunId / matchScore from this route.
 */
describe('JourneyController.appendEvent', () => {
  it('forwards only the whitelisted manual-event fields to the service', async () => {
    const appendEvent = jest.fn(async (..._args: unknown[]) => ({}));
    const controller = new JourneyController(
      { appendEvent } as unknown as JourneyService,
    );
    const body = {
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      productId: 'prod-a',
      quantity: 2,
      // Forged provenance a caller might try to smuggle past validation.
      sourceType: 'FUSION_SHADOW',
      videoAssetId: 'foreign-asset',
      fusionRunId: 'foreign-run',
      matchScore: 0.99,
    } as AppendJourneyEventDto;
    await controller.appendEvent(
      'tenant-1',
      'j-1',
      body,
      { userId: 'user-1' } as RequestContext,
    );
    const forwarded = appendEvent.mock.calls[0][2] as Record<string, unknown>;
    expect(forwarded).toEqual({
      eventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      occurredAt: undefined,
      productId: 'prod-a',
      quantity: 2,
      note: undefined,
    });
    expect(forwarded).not.toHaveProperty('sourceType');
    expect(forwarded).not.toHaveProperty('videoAssetId');
    expect(forwarded).not.toHaveProperty('fusionRunId');
    expect(forwarded).not.toHaveProperty('matchScore');
  });
});

/**
 * Same defense-in-depth for the review endpoint: the handler forwards
 * ONLY the declared review fields — caller-supplied snapshots
 * (correctedSku / correctedProductName) or attribution (reviewedById)
 * can never reach the service, which resolves the product within this
 * tenant and snapshots sku/name itself.
 */
describe('JourneyController.reviewEvent', () => {
  it('forwards only the whitelisted review fields to the service', async () => {
    const reviewEvent = jest.fn(async (..._args: unknown[]) => ({}));
    const controller = new JourneyController(
      { reviewEvent } as unknown as JourneyService,
    );
    const body = {
      decision: JourneyEventReviewDecision.CORRECT,
      correctedEventType: CustomerJourneyEventType.PRODUCT_PICKUP,
      correctedProductId: 'prod-a',
      correctedQuantity: 2,
      reason: 'mislabeled',
      idempotencyKey: 'retry-key-12345678',
      // Forged snapshot/attribution a caller might try to smuggle in.
      correctedSku: 'FORGED-SKU',
      correctedProductName: 'Forged Product',
      reviewedById: 'someone-else',
      tenantId: 'tenant-B',
    } as ReviewJourneyEventDto;
    await controller.reviewEvent('tenant-1', 'j-1', 'e-1', body, {
      userId: 'user-1',
      email: 'reviewer@example.com',
    } as RequestContext);
    expect(reviewEvent).toHaveBeenCalledWith(
      'tenant-1',
      'j-1',
      'e-1',
      {
        decision: JourneyEventReviewDecision.CORRECT,
        reason: 'mislabeled',
        correctedEventType: CustomerJourneyEventType.PRODUCT_PICKUP,
        correctedProductId: 'prod-a',
        correctedQuantity: 2,
        idempotencyKey: 'retry-key-12345678',
      },
      { id: 'user-1', email: 'reviewer@example.com' },
    );
    const forwarded = reviewEvent.mock.calls[0][3] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty('correctedSku');
    expect(forwarded).not.toHaveProperty('correctedProductName');
    expect(forwarded).not.toHaveProperty('reviewedById');
    expect(forwarded).not.toHaveProperty('tenantId');
  });
});
