import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  EvidenceSourceType,
  VisionEventType,
  VisionReviewDecision,
} from '@prisma/client';
import { IngestVisionEventDto } from './dto/ingest-vision-event.dto';
import {
  IngestAuditBuilders,
  ReviewAuditBuilders,
  VisionEventDetail,
  VisionEventsRepository,
} from './vision-events.repository';
import { VisionEventsService } from './vision-events.service';

describe('VisionEventsService', () => {
  const eventDetail = {
    id: 'event-1',
    tenantId: 'tenant-a',
    type: VisionEventType.PRODUCT_PICKUP,
    status: 'PENDING_REVIEW',
    candidates: [],
    review: null,
  } as unknown as VisionEventDetail;

  const actor = { id: 'user-1', email: 'jane@tenant-a.example' };

  const baseIngest = {
    locationId: 'loc-a1',
    unitId: 'unit-a1',
    type: VisionEventType.PRODUCT_PICKUP,
    occurredAt: '2026-07-19T10:00:00.000Z',
  };

  let repository: {
    ingest: jest.Mock;
    findByIdempotencyKey: jest.Mock;
    findById: jest.Mock;
    findBundleById: jest.Mock;
    search: jest.Mock;
    review: jest.Mock;
    bindSession: jest.Mock;
  };
  let service: VisionEventsService;

  beforeEach(() => {
    repository = {
      ingest: jest
        .fn()
        .mockResolvedValue({ event: eventDetail, replayed: false }),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(eventDetail),
      findBundleById: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
      search: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      review: jest.fn().mockResolvedValue(eventDetail),
      bindSession: jest.fn().mockResolvedValue(eventDetail),
    };
    service = new VisionEventsService(
      repository as unknown as VisionEventsRepository,
    );
  });

  describe('ingest', () => {
    it('normalizes candidate SKUs to uppercase and ranks by array order', async () => {
      await service.ingest(
        'tenant-a',
        {
          ...baseIngest,
          candidates: [{ sku: ' cola-330 ' }, { sku: 'chips-50' }],
        },
        actor,
      );
      const input = repository.ingest.mock.calls[0][1] as {
        candidates: unknown;
        quantity: number;
        occurredAt: Date;
      };
      expect(input.candidates).toEqual([
        { sku: 'COLA-330', rank: 1, score: undefined, label: undefined },
        { sku: 'CHIPS-50', rank: 2, score: undefined, label: undefined },
      ]);
      expect(input.quantity).toBe(1);
      expect(input.occurredAt).toEqual(new Date('2026-07-19T10:00:00.000Z'));
    });

    it('keeps explicit ranks when all candidates carry one', async () => {
      await service.ingest(
        'tenant-a',
        {
          ...baseIngest,
          candidates: [
            { sku: 'B', rank: 2, score: 0.4 },
            { sku: 'A', rank: 1, score: 0.9 },
          ],
        },
        actor,
      );
      const input = repository.ingest.mock.calls[0][1] as {
        candidates: { sku: string; rank: number }[];
      };
      expect(input.candidates.map((c) => [c.sku, c.rank])).toEqual([
        ['B', 2],
        ['A', 1],
      ]);
    });

    it.each([
      [
        'mixed explicit and implicit ranks',
        [{ sku: 'A', rank: 1 }, { sku: 'B' }],
      ],
      [
        'duplicate ranks',
        [
          { sku: 'A', rank: 1 },
          { sku: 'B', rank: 1 },
        ],
      ],
      ['duplicate SKUs (case-insensitive)', [{ sku: 'a' }, { sku: 'A' }]],
    ])('rejects %s with a 400', async (_label, candidates) => {
      await expect(
        service.ingest('tenant-a', { ...baseIngest, candidates }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.ingest).not.toHaveBeenCalled();
    });

    const asIngestDto = (
      fields: Record<string, unknown>,
    ): IngestVisionEventDto =>
      ({ ...baseIngest, ...fields }) as unknown as IngestVisionEventDto;

    // Phase 7 evidence policy: artifacts are rejected WHOLESALE — the
    // content no longer matters, presence alone is out of scope.
    it.each([
      [
        'a valid-looking reference descriptor',
        [{ kind: 'frame', uri: 's3://bucket/frames/1.jpg' }],
      ],
      [
        'a data: URI artifact',
        [{ kind: 'frame', uri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg' }],
      ],
      [
        'a storageKey/hash/mimeType/capturedAt descriptor',
        [
          {
            kind: 'clip',
            storageKey: 'tenant-a/clips/2026/07/20/clip-42.mp4',
            hash: 'a'.repeat(64),
            mimeType: 'video/mp4',
            capturedAt: '2026-07-20T10:00:00.000Z',
          },
        ],
      ],
      [
        'chunked encoded payloads across artifacts',
        Array.from({ length: 8 }, (_, i) => ({
          kind: 'frame',
          uri: `s3://bucket/Ab0Cd1E${i}.jpg`,
        })),
      ],
      [
        'a raw byte array artifact',
        [{ kind: 'frame', pixels: [137, 80, 78, 71] }],
      ],
      ['an empty artifacts array', []],
    ])(
      'rejects evidenceBundle.artifacts (%s) as out of scope before any write',
      async (_label, artifacts) => {
        await expect(
          service.ingest(
            'tenant-a',
            asIngestDto({ evidenceBundle: { artifacts } }),
            actor,
          ),
        ).rejects.toThrow(/out of scope for Phase 7 MVP/);
        expect(repository.ingest).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['an empty metadata object', {}],
      ['capture context', { source: 'edge-gateway-7', quality: 'medium' }],
      ['an inline media payload', { imageData: 'AAAA'.repeat(64) }],
      ['a credential-shaped nested object', { config: { apiKey: 'sk-123' } }],
      [
        'a chunked byte stream',
        {
          chunk0: [137, 80, 78, 71],
          chunk1: [13, 10, 26, 10],
        },
      ],
    ])(
      'rejects evidenceBundle.metadata (%s) as out of scope before any write',
      async (_label, metadata) => {
        await expect(
          service.ingest(
            'tenant-a',
            asIngestDto({ evidenceBundle: { metadata } }),
            actor,
          ),
        ).rejects.toThrow(/out of scope for Phase 7 MVP/);
        expect(repository.ingest).not.toHaveBeenCalled();
      },
    );

    it.each([
      'sourceId',
      'modelName',
      'modelVersion',
      'uri',
      'storageKey',
      'hash',
      'mimeType',
      'notes',
      'payload',
      'data',
    ])(
      'rejects evidence bundle field "%s" as out of scope before any write',
      async (field) => {
        await expect(
          service.ingest(
            'tenant-a',
            asIngestDto({ evidenceBundle: { [field]: 'anything' } }),
            actor,
          ),
        ).rejects.toThrow(/out of scope for Phase 7 MVP/);
        expect(repository.ingest).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['metadata', { aisle: 'A3', fps: 25 }],
      ['sourceId', 'adapter-1'],
      ['sourceId', 'rtsp://admin:hunter2@cam.local/1'],
      ['modelName', 'shelf-detector'],
      ['modelVersion', '2026.07'],
      ['artifacts', [{ kind: 'frame', uri: 's3://bucket/frames/1.jpg' }]],
    ])(
      'rejects removed event-level field %s as out of scope before any write',
      async (key, value) => {
        await expect(
          service.ingest('tenant-a', asIngestDto({ [key]: value }), actor),
        ).rejects.toThrow(/out of scope for Phase 7 MVP/);
        expect(repository.ingest).not.toHaveBeenCalled();
      },
    );

    it('accepts a lightweight lineage bundle and persists NO payload fields', async () => {
      await service.ingest(
        'tenant-a',
        {
          ...baseIngest,
          evidenceBundle: {
            sourceType: EvidenceSourceType.VISION,
            captureStartedAt: '2026-07-19T09:59:00.000Z',
            captureEndedAt: '2026-07-19T10:00:00.000Z',
          },
        },
        actor,
      );
      const input = repository.ingest.mock.calls[0][1] as {
        evidenceBundle: unknown;
      };
      // EXACTLY the lineage record — no artifact, metadata, or provenance
      // key exists on the repository input at all.
      expect(input.evidenceBundle).toEqual({
        sourceType: EvidenceSourceType.VISION,
        captureStartedAt: new Date('2026-07-19T09:59:00.000Z'),
        captureEndedAt: new Date('2026-07-19T10:00:00.000Z'),
      });
    });

    it('accepts lowercase slug reason codes', async () => {
      await service.ingest(
        'tenant-a',
        { ...baseIngest, reasonCodes: ['low-confidence', 'occlusion'] },
        actor,
      );
      expect(repository.ingest).toHaveBeenCalled();
    });

    it.each([
      ['a mixed-case encoded chunk', ['Ab0Cd1E']],
      ['free text', ['not a slug!']],
      ['an overlong code', ['a'.repeat(65)]],
      ['an empty code', ['']],
    ])('rejects non-slug reason codes (%s)', async (_label, reasonCodes) => {
      await expect(
        service.ingest('tenant-a', { ...baseIngest, reasonCodes }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.ingest).not.toHaveBeenCalled();
    });

    it('rejects providing both evidenceBundleId and an inline bundle', async () => {
      await expect(
        service.ingest(
          'tenant-a',
          {
            ...baseIngest,
            evidenceBundleId: 'bundle-1',
            evidenceBundle: { sourceType: EvidenceSourceType.VISION },
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a capture window that ends before it starts', async () => {
      await expect(
        service.ingest(
          'tenant-a',
          {
            ...baseIngest,
            evidenceBundle: {
              captureStartedAt: '2026-07-19T10:00:05.000Z',
              captureEndedAt: '2026-07-19T10:00:00.000Z',
            },
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps unknown candidate SKUs to a 400 naming them', async () => {
      repository.ingest.mockResolvedValue({ unknownSkus: ['GHOST-1'] });
      await expect(
        service.ingest(
          'tenant-a',
          { ...baseIngest, candidates: [{ sku: 'ghost-1' }] },
          actor,
        ),
      ).rejects.toThrow(/GHOST-1/);
    });

    it.each([
      'location-not-found',
      'unit-not-found',
      'unit-location-mismatch',
      'device-not-found',
      'device-unit-mismatch',
      'session-not-found',
      'session-unit-mismatch',
      'session-location-mismatch',
      'bundle-not-found',
    ])('maps %s to a 400', async (rejection) => {
      repository.ingest.mockResolvedValue(rejection);
      await expect(
        service.ingest('tenant-a', baseIngest, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('replays the winner on an idempotency-key unique race', async () => {
      repository.ingest.mockRejectedValue({ code: 'P2002' });
      repository.findByIdempotencyKey.mockResolvedValue(eventDetail);
      await expect(
        service.ingest(
          'tenant-a',
          { ...baseIngest, idempotencyKey: 'key-1' },
          actor,
        ),
      ).resolves.toBe(eventDetail);
      expect(repository.findByIdempotencyKey).toHaveBeenCalledWith(
        'tenant-a',
        'key-1',
      );
    });

    it('rejects public keys in the reserved "inference:" namespace', async () => {
      // Idempotent replay returns an existing event WITHOUT comparing
      // payloads, so a caller squatting a Phase 9 job's derived key could
      // otherwise feed the converter an arbitrary event.
      await expect(
        service.ingest(
          'tenant-a',
          { ...baseIngest, idempotencyKey: 'inference:job-1' },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.ingest).not.toHaveBeenCalled();
    });

    it('allows the reserved namespace for the trusted conversion caller', async () => {
      await expect(
        service.ingest(
          'tenant-a',
          { ...baseIngest, idempotencyKey: 'inference:job-1' },
          actor,
          { allowReservedIdempotencyKey: true },
        ),
      ).resolves.toBe(eventDetail);
    });

    it('builds CREATE audit entries for the event and inline bundle', async () => {
      await service.ingest(
        'tenant-a',
        {
          ...baseIngest,
          evidenceBundle: { sourceType: EvidenceSourceType.VISION },
        },
        actor,
      );
      const builders = repository.ingest.mock
        .calls[0][2] as IngestAuditBuilders;
      expect(builders.eventCreated(eventDetail)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actorId: 'user-1',
          action: AuditAction.CREATE,
          entityType: 'VisionEvent',
          entityId: 'event-1',
        }),
      );
      expect(
        builders.bundleCreated({ id: 'bundle-1' } as never),
      ).toEqual(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'EvidenceBundle',
          entityId: 'bundle-1',
        }),
      );
    });
  });

  describe('findById / findBundleById', () => {
    it('404s when the event is not found in this tenant', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(
        service.findById('tenant-a', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the bundle is not found in this tenant', async () => {
      repository.findBundleById.mockResolvedValue(null);
      await expect(
        service.findBundleById('tenant-a', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('bindSession', () => {
    it('binds and audits the correlation as an UPDATE on the event', async () => {
      await expect(
        service.bindSession(
          'tenant-a',
          'event-1',
          { sessionId: 'sess-1' },
          actor,
        ),
      ).resolves.toBe(eventDetail);
      expect(repository.bindSession).toHaveBeenCalledWith(
        'tenant-a',
        'event-1',
        'sess-1',
        expect.any(Function),
      );
      const build = repository.bindSession.mock.calls[0][3] as (
        before: unknown,
        after: VisionEventDetail,
      ) => unknown;
      expect(build({}, eventDetail)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actorId: 'user-1',
          action: AuditAction.UPDATE,
          entityType: 'VisionEvent',
          entityId: 'event-1',
          reason: expect.stringContaining('sess-1'),
        }),
      );
    });

    it('404s when the event does not exist in this tenant', async () => {
      repository.bindSession.mockResolvedValue(null);
      await expect(
        service.bindSession(
          'tenant-a',
          'missing',
          { sessionId: 'sess-1' },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each(['already-decided', 'already-bound'])(
      'maps %s to a 409 conflict',
      async (rejection) => {
        repository.bindSession.mockResolvedValue(rejection);
        await expect(
          service.bindSession(
            'tenant-a',
            'event-1',
            { sessionId: 'sess-1' },
            actor,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      },
    );

    it.each([
      'session-not-found',
      'session-unit-mismatch',
      'session-location-mismatch',
    ])(
      'maps %s to a 400',
      async (rejection) => {
        repository.bindSession.mockResolvedValue(rejection);
        await expect(
          service.bindSession(
            'tenant-a',
            'event-1',
            { sessionId: 'sess-1' },
            actor,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });

  describe('review', () => {
    it('requires productId and quantity for OVERRIDE', async () => {
      await expect(
        service.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.OVERRIDE },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.review).not.toHaveBeenCalled();
    });

    it.each([VisionReviewDecision.APPROVE, VisionReviewDecision.REJECT])(
      'rejects productId/quantity on %s (caller almost certainly meant OVERRIDE)',
      async (decision) => {
        await expect(
          service.review(
            'tenant-a',
            'event-1',
            { decision, productId: 'prod-1', quantity: 2 },
            actor,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(repository.review).not.toHaveBeenCalled();
      },
    );

    it('rejects a credential-bearing reason before any write', async () => {
      await expect(
        service.review(
          'tenant-a',
          'event-1',
          {
            decision: VisionReviewDecision.REJECT,
            reason: 'see rtsp://admin:hunter2@cam.local/1',
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.review).not.toHaveBeenCalled();
    });

    it.each([
      [VisionReviewDecision.APPROVE, AuditAction.APPROVE],
      [VisionReviewDecision.REJECT, AuditAction.REJECT],
    ])('audits the decision on the event as %s → %s', async (decision, action) => {
      await service.review('tenant-a', 'event-1', { decision }, actor);
      const builders = repository.review.mock
        .calls[0][3] as ReviewAuditBuilders;
      expect(builders.decided({} as never, eventDetail)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actorId: 'user-1',
          action,
          entityType: 'VisionEvent',
          entityId: 'event-1',
        }),
      );
    });

    it('audits OVERRIDE decisions with the OVERRIDE action', async () => {
      await service.review(
        'tenant-a',
        'event-1',
        {
          decision: VisionReviewDecision.OVERRIDE,
          productId: 'prod-1',
          quantity: 2,
        },
        actor,
      );
      const builders = repository.review.mock
        .calls[0][3] as ReviewAuditBuilders;
      expect(builders.decided({} as never, eventDetail).action).toBe(
        AuditAction.OVERRIDE,
      );
    });

    it('builds basket-line audit entries for each effect', async () => {
      await service.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE },
        actor,
      );
      const builders = repository.review.mock
        .calls[0][3] as ReviewAuditBuilders;
      const line = { id: 'line-1' } as never;
      expect(builders.lineAdded(line)).toEqual(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'CheckoutSessionLine',
        }),
      );
      expect(builders.lineChanged(line, line)).toEqual(
        expect.objectContaining({ action: AuditAction.UPDATE }),
      );
      expect(builders.lineRemoved(line)).toEqual(
        expect.objectContaining({ action: AuditAction.DELETE }),
      );
      expect(builders.reviewCreated({
        id: 'review-1',
        decision: 'APPROVE',
        basketEffect: 'LINE_ADDED',
      } as never)).toEqual(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'VisionEventReview',
          entityId: 'review-1',
        }),
      );
    });

    it('404s when the event does not exist in this tenant', async () => {
      repository.review.mockResolvedValue(null);
      await expect(
        service.review(
          'tenant-a',
          'missing',
          { decision: VisionReviewDecision.REJECT },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps checkout-module-disabled to a 403', async () => {
      repository.review.mockResolvedValue('checkout-module-disabled');
      await expect(
        service.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          actor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      'already-decided',
      'override-not-applicable',
      'no-candidates',
      'no-session',
      'session-terminal',
      'product-not-saleable',
      'no-line-to-decrement',
      'line-quantity-overflow',
    ])('maps %s to a 409 conflict', async (rejection) => {
      repository.review.mockResolvedValue(rejection);
      await expect(
        service.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps product-not-found to a 404', async () => {
      repository.review.mockResolvedValue('product-not-found');
      await expect(
        service.review(
          'tenant-a',
          'event-1',
          {
            decision: VisionReviewDecision.OVERRIDE,
            productId: 'ghost',
            quantity: 1,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a review unique-violation race to a controlled 409', async () => {
      repository.review.mockRejectedValue({ code: 'P2002' });
      await expect(
        service.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
