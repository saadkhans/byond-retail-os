import { CustomerJourneyEventType } from '@prisma/client';
import { RequestContext } from '../auth/request-context';
import { AppendJourneyEventDto } from './dto/append-journey-event.dto';
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
