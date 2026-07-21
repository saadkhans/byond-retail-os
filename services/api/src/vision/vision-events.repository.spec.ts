import {
  CheckoutSessionLineStatus,
  CheckoutSessionStatus,
  VisionBasketEffect,
  VisionEventStatus,
  VisionEventType,
  VisionReviewDecision,
} from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { TenantIdRequiredError } from '../common/errors/domain.errors';
import { PrismaService } from '../prisma/prisma.service';
import {
  IngestAuditBuilders,
  ReviewAuditBuilders,
  VisionEventsRepository,
} from './vision-events.repository';

describe('VisionEventsRepository', () => {
  const auditEntry = (marker: string): AuditEntry => ({
    tenantId: 'tenant-a',
    actorEmail: 'jane@tenant-a.example',
    action: 'CREATE',
    entityType: marker,
  });

  const ingestBuilders: IngestAuditBuilders = {
    eventCreated: () => auditEntry('VisionEvent'),
    bundleCreated: () => auditEntry('EvidenceBundle'),
  };

  const reviewBuilders: ReviewAuditBuilders = {
    decided: () => auditEntry('VisionEvent'),
    reviewCreated: () => auditEntry('VisionEventReview'),
    lineAdded: () => auditEntry('CheckoutSessionLine'),
    lineChanged: () => auditEntry('CheckoutSessionLine'),
    lineRemoved: () => auditEntry('CheckoutSessionLine'),
  };

  const baseIngest = {
    locationId: 'loc-a1',
    unitId: 'unit-a1',
    type: VisionEventType.PRODUCT_PICKUP,
    occurredAt: new Date('2026-07-19T10:00:00.000Z'),
    quantity: 2,
    candidates: [
      { sku: 'COLA-330', rank: 1, score: 0.92, label: 'red can' },
      { sku: 'CHIPS-50', rank: 2, score: 0.41 },
    ],
  };

  const pendingEvent = {
    id: 'event-1',
    tenantId: 'tenant-a',
    locationId: 'loc-a1',
    unitId: 'unit-a1',
    sessionId: 'sess-1',
    type: VisionEventType.PRODUCT_PICKUP,
    status: VisionEventStatus.PENDING_REVIEW,
    quantity: 2,
    sourceType: 'VISION',
    sourceId: 'adapter-1',
    evidenceBundleId: 'bundle-1',
    evidenceScore: 0.92,
    evidenceQuality: 'HIGH',
    reasonCodes: ['auto-detected'],
    candidates: [
      { id: 'cand-1', productId: 'prod-cola', rank: 1, sku: 'COLA-330' },
      { id: 'cand-2', productId: 'prod-chips', rank: 2, sku: 'CHIPS-50' },
    ],
  };

  let tx: {
    $queryRaw: jest.Mock;
    visionEvent: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findFirstOrThrow: jest.Mock;
    };
    visionEventReview: { create: jest.Mock };
    evidenceBundle: { findFirst: jest.Mock; create: jest.Mock };
    location: { findFirst: jest.Mock };
    retailUnit: { findFirst: jest.Mock };
    device: { findFirst: jest.Mock };
    checkoutSession: { findFirst: jest.Mock };
    checkoutSessionLine: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    product: { findMany: jest.Mock; findFirst: jest.Mock };
    platformModule: { findUnique: jest.Mock };
    tenantModule: { findFirst: jest.Mock };
  };
  let auditLog: { record: jest.Mock };
  let repository: VisionEventsRepository;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      visionEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'event-1', ...data }),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ ...pendingEvent, ...data }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ ...pendingEvent, sessionId: 'sess-1' }),
          ),
      },
      visionEventReview: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'review-1', ...data }),
          ),
      },
      evidenceBundle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'bundle-new', ...data }),
          ),
      },
      location: { findFirst: jest.fn().mockResolvedValue({ id: 'loc-a1' }) },
      retailUnit: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'unit-a1', locationId: 'loc-a1' }),
      },
      device: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'dev-1', unitId: 'unit-a1' }),
      },
      checkoutSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'sess-1',
          unitId: 'unit-a1',
          locationId: 'loc-a1',
          status: CheckoutSessionStatus.ACTIVE,
        }),
      },
      checkoutSessionLine: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'line-1', ...data }),
          ),
        update: jest
          .fn()
          .mockImplementation(
            ({
              where,
              data,
            }: {
              where: { id_tenantId: { id: string } };
              data: object;
            }) => Promise.resolve({ id: where.id_tenantId.id, ...data }),
          ),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'prod-cola', sku: 'COLA-330', name: 'Cola 330ml' },
          { id: 'prod-chips', sku: 'CHIPS-50', name: 'Chips 50g' },
        ]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-cola',
          sku: 'COLA-330',
          name: 'Cola 330ml',
          unitOfMeasure: 'EACH',
          status: 'ACTIVE',
        }),
      },
      // Checkout module enabled by default; tests flip these to prove the
      // basket path is gated on it.
      platformModule: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'module-checkout', isActive: true }),
      },
      tenantModule: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tm-a-checkout' }),
      },
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService;
    repository = new VisionEventsRepository(
      prisma,
      auditLog as never,
    );
  });

  describe('tenant isolation', () => {
    it('throws on a blank tenantId instead of widening the query', () => {
      expect(() =>
        repository.ingest('', baseIngest, ingestBuilders),
      ).toThrow(TenantIdRequiredError);
      expect(() =>
        repository.review(
          '  ',
          'event-1',
          { decision: VisionReviewDecision.REJECT },
          reviewBuilders,
        ),
      ).toThrow(TenantIdRequiredError);
    });

    it('scopes every ingest reference check to the tenant', async () => {
      await repository.ingest(
        'tenant-a',
        { ...baseIngest, deviceId: 'dev-1', sessionId: 'sess-1' },
        ingestBuilders,
      );
      expect(tx.location.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
      expect(tx.retailUnit.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
      expect(tx.device.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
      expect(tx.checkoutSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
      expect(tx.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
    });
  });

  describe('ingest', () => {
    it('creates the event with product snapshots from the tenant catalog', async () => {
      const result = await repository.ingest(
        'tenant-a',
        baseIngest,
        ingestBuilders,
      );
      expect(result).toEqual(
        expect.objectContaining({ replayed: false }),
      );
      const createArgs = tx.visionEvent.create.mock.calls[0][0] as {
        data: {
          tenantId: string;
          quantity: number;
          candidates: { create: Record<string, unknown>[] };
        };
      };
      expect(createArgs.data.tenantId).toBe('tenant-a');
      expect(createArgs.data.quantity).toBe(2);
      expect(createArgs.data.candidates.create).toEqual([
        expect.objectContaining({
          tenantId: 'tenant-a',
          productId: 'prod-cola',
          rank: 1,
          sku: 'COLA-330',
          productName: 'Cola 330ml',
          label: 'red can',
        }),
        expect.objectContaining({
          productId: 'prod-chips',
          rank: 2,
          sku: 'CHIPS-50',
        }),
      ]);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'VisionEvent' }),
        tx,
      );
    });

    it('rejects candidates whose SKU is unknown in this tenant', async () => {
      tx.product.findMany.mockResolvedValue([
        { id: 'prod-cola', sku: 'COLA-330', name: 'Cola 330ml' },
      ]);
      await expect(
        repository.ingest('tenant-a', baseIngest, ingestBuilders),
      ).resolves.toEqual({ unknownSkus: ['CHIPS-50'] });
      expect(tx.visionEvent.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('replays an existing event for the same idempotency key without writing', async () => {
      const existing = { id: 'event-0' };
      tx.visionEvent.findFirst.mockResolvedValue(existing);
      await expect(
        repository.ingest(
          'tenant-a',
          { ...baseIngest, idempotencyKey: 'key-1' },
          ingestBuilders,
        ),
      ).resolves.toEqual({ event: existing, replayed: true });
      expect(tx.visionEvent.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('creates an inline lineage-only evidence bundle atomically and audits it', async () => {
      await repository.ingest(
        'tenant-a',
        {
          ...baseIngest,
          evidenceBundle: {
            sourceType: 'VISION',
            captureStartedAt: new Date('2026-07-19T09:59:00.000Z'),
          },
        },
        ingestBuilders,
      );
      expect(tx.evidenceBundle.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: 'tenant-a',
            sourceType: 'VISION',
          }),
        }),
      );
      // The system-created bundle carries NO payload fields: the removed
      // columns are never written (server-controlled null).
      const bundleData = (
        tx.evidenceBundle.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;
      for (const removed of [
        'sourceId',
        'modelName',
        'modelVersion',
        'artifacts',
        'metadata',
      ]) {
        expect(bundleData).not.toHaveProperty(removed);
      }
      const eventData = (
        tx.visionEvent.create.mock.calls[0][0] as {
          data: { evidenceBundleId: string };
        }
      ).data;
      expect(eventData.evidenceBundleId).toBe('bundle-new');
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'EvidenceBundle' }),
        tx,
      );
    });

    it('rejects a session bound to a different unit', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        unitId: 'unit-OTHER',
      });
      await expect(
        repository.ingest(
          'tenant-a',
          { ...baseIngest, sessionId: 'sess-1' },
          ingestBuilders,
        ),
      ).resolves.toBe('session-unit-mismatch');
    });

    it('rejects a session at the same unit but a different store', async () => {
      // A relocated unit: the session predates the unit's move to another
      // store — its basket must not accept events from the new store.
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        unitId: 'unit-a1',
        locationId: 'loc-OTHER',
      });
      await expect(
        repository.ingest(
          'tenant-a',
          { ...baseIngest, sessionId: 'sess-1' },
          ingestBuilders,
        ),
      ).resolves.toBe('session-location-mismatch');
    });

    it('rejects a unit that does not belong to the store', async () => {
      tx.retailUnit.findFirst.mockResolvedValue({
        id: 'unit-a1',
        locationId: 'loc-OTHER',
      });
      await expect(
        repository.ingest('tenant-a', baseIngest, ingestBuilders),
      ).resolves.toBe('unit-location-mismatch');
    });
  });

  describe('review — approval applies the basket effect', () => {
    beforeEach(() => {
      tx.visionEvent.findFirst.mockResolvedValue(pendingEvent);
    });

    it('APPROVE on a pickup adds a line with snapshot and evidence lineage', async () => {
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE, reviewedById: 'user-1' },
        reviewBuilders,
      );
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          sessionId: 'sess-1',
          productId: 'prod-cola',
          sku: 'COLA-330',
          productName: 'Cola 330ml',
          quantity: 2,
          sourceType: 'VISION',
          visionEventId: 'event-1',
          evidenceBundleId: 'bundle-1',
          evidenceScore: 0.92,
          reasonCodes: ['auto-detected'],
          createdById: 'user-1',
        }),
      });
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          decision: VisionReviewDecision.APPROVE,
          appliedProductId: 'prod-cola',
          appliedQuantity: 2,
          basketEffect: VisionBasketEffect.LINE_ADDED,
          sessionLineId: 'line-1',
        }),
      });
      expect(tx.visionEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: VisionEventStatus.APPROVED },
        }),
      );
      // Decision, review row, and line effect all audited inside the tx.
      expect(auditLog.record).toHaveBeenCalledTimes(3);
    });

    it('APPROVE increments an existing active line for the same product', async () => {
      tx.checkoutSessionLine.findFirst.mockResolvedValue({
        id: 'line-9',
        quantity: 3,
        status: CheckoutSessionLineStatus.ACTIVE,
      });
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE },
        reviewBuilders,
      );
      expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          // Tenant-scoped selector: the update can never mutate outside the
          // caller's tenant even if the id were guessable. ONLY the quantity
          // changes — the line keeps the provenance of the event that
          // created it; this event is traced via its review row instead.
          where: { id_tenantId: { id: 'line-9', tenantId: 'tenant-a' } },
          data: { quantity: 5 },
        }),
      );
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          basketEffect: VisionBasketEffect.LINE_INCREASED,
          sessionLineId: 'line-9',
        }),
      });
    });

    it('APPROVE on a return decrements the existing line', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        type: VisionEventType.PRODUCT_RETURN,
        quantity: 1,
      });
      tx.checkoutSessionLine.findFirst.mockResolvedValue({
        id: 'line-9',
        quantity: 3,
        status: CheckoutSessionLineStatus.ACTIVE,
      });
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE },
        reviewBuilders,
      );
      // ONLY the quantity: the surviving units keep the provenance of the
      // event that added them — the return is recorded via the review row
      // and audit, never by rewriting the line's lineage.
      expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { quantity: 2 } }),
      );
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          basketEffect: VisionBasketEffect.LINE_DECREASED,
        }),
      });
    });

    it('clamps a return that exceeds the line so the review records what was applied', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        type: VisionEventType.PRODUCT_RETURN,
        quantity: 5,
      });
      tx.checkoutSessionLine.findFirst.mockResolvedValue({
        id: 'line-9',
        quantity: 2,
        status: CheckoutSessionLineStatus.ACTIVE,
      });
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE },
        reviewBuilders,
      );
      // Only 2 units existed to remove; the immutable review must say 2,
      // never the claimed 5 — basket audit and review always agree.
      expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: CheckoutSessionLineStatus.REMOVED,
          }),
        }),
      );
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          appliedQuantity: 2,
          basketEffect: VisionBasketEffect.LINE_REMOVED,
        }),
      });
    });

    it('stamps the line with the event’s declared sourceType, not VISION', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        sourceType: 'DEVICE',
      });
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE },
        reviewBuilders,
      );
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sourceType: 'DEVICE' }),
      });
    });

    it('APPROVE on a return soft-removes the line when everything comes back', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        type: VisionEventType.PRODUCT_RETURN,
        quantity: 3,
      });
      tx.checkoutSessionLine.findFirst.mockResolvedValue({
        id: 'line-9',
        quantity: 3,
        status: CheckoutSessionLineStatus.ACTIVE,
      });
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE },
        reviewBuilders,
      );
      expect(tx.checkoutSessionLine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: CheckoutSessionLineStatus.REMOVED,
            removedAt: expect.any(Date),
          }),
        }),
      );
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          basketEffect: VisionBasketEffect.LINE_REMOVED,
        }),
      });
    });

    it('OVERRIDE applies the reviewer product/quantity and flags the correction', async () => {
      await repository.review(
        'tenant-a',
        'event-1',
        {
          decision: VisionReviewDecision.OVERRIDE,
          productId: 'prod-cola',
          quantity: 7,
          reviewedById: 'user-1',
        },
        reviewBuilders,
      );
      expect(tx.checkoutSessionLine.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          productId: 'prod-cola',
          quantity: 7,
          reasonCodes: ['auto-detected', 'manual-override'],
        }),
      });
      expect(tx.visionEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: VisionEventStatus.OVERRIDDEN },
        }),
      );
    });

    it('REJECT records the decision and never touches the basket', async () => {
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.REJECT, reason: 'wrong shelf' },
        reviewBuilders,
      );
      expect(tx.checkoutSessionLine.findFirst).not.toHaveBeenCalled();
      expect(tx.checkoutSessionLine.create).not.toHaveBeenCalled();
      expect(tx.checkoutSessionLine.update).not.toHaveBeenCalled();
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          decision: VisionReviewDecision.REJECT,
          reason: 'wrong shelf',
          basketEffect: VisionBasketEffect.NONE,
          appliedProductId: null,
          sessionLineId: null,
        }),
      });
      expect(tx.visionEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: VisionEventStatus.REJECTED },
        }),
      );
      // Decision + review row audited (no line effect).
      expect(auditLog.record).toHaveBeenCalledTimes(2);
    });

    it('APPROVE on a record-only type never touches the session or basket', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        type: VisionEventType.EXIT_RECONCILIATION,
        candidates: [],
      });
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.APPROVE },
        reviewBuilders,
      );
      expect(tx.checkoutSession.findFirst).not.toHaveBeenCalled();
      expect(tx.checkoutSessionLine.create).not.toHaveBeenCalled();
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          basketEffect: VisionBasketEffect.NONE,
        }),
      });
    });
  });

  describe('review — controlled rejections', () => {
    beforeEach(() => {
      tx.visionEvent.findFirst.mockResolvedValue(pendingEvent);
    });

    it('returns null when the event is missing in this tenant', async () => {
      tx.visionEvent.findFirst.mockResolvedValue(null);
      await expect(
        repository.review(
          'tenant-a',
          'missing',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBeNull();
    });

    it.each([
      VisionEventStatus.APPROVED,
      VisionEventStatus.REJECTED,
      VisionEventStatus.OVERRIDDEN,
    ])('blocks a second decision on a %s event', async (status) => {
      tx.visionEvent.findFirst.mockResolvedValue({ ...pendingEvent, status });
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.REJECT },
          reviewBuilders,
        ),
      ).resolves.toBe('already-decided');
      expect(tx.visionEventReview.create).not.toHaveBeenCalled();
    });

    it('blocks OVERRIDE on record-only event types', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        type: VisionEventType.EXIT_RECONCILIATION,
      });
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          {
            decision: VisionReviewDecision.OVERRIDE,
            productId: 'prod-cola',
            quantity: 1,
          },
          reviewBuilders,
        ),
      ).resolves.toBe('override-not-applicable');
    });

    it('blocks APPROVE when the event proposed no candidates', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        candidates: [],
      });
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBe('no-candidates');
    });

    it('blocks a basket-affecting approval without a bound session', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        sessionId: null,
      });
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBe('no-session');
    });

    it('blocks a basket-affecting decision when the checkout module is disabled', async () => {
      tx.tenantModule.findFirst.mockResolvedValue(null);
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBe('checkout-module-disabled');
      // Nothing written: with checkout disabled, the vision route must not
      // stay a back door that keeps session baskets mutable.
      expect(tx.checkoutSessionLine.create).not.toHaveBeenCalled();
      expect(tx.visionEventReview.create).not.toHaveBeenCalled();
      expect(tx.visionEvent.update).not.toHaveBeenCalled();
    });

    it('REJECT works with checkout disabled — it never touches the basket', async () => {
      tx.tenantModule.findFirst.mockResolvedValue(null);
      await repository.review(
        'tenant-a',
        'event-1',
        { decision: VisionReviewDecision.REJECT },
        reviewBuilders,
      );
      expect(tx.visionEventReview.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          decision: VisionReviewDecision.REJECT,
        }),
      });
    });

    it('blocks the basket effect when the session is terminal', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        status: CheckoutSessionStatus.COMPLETED,
      });
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBe('session-terminal');
      expect(tx.checkoutSessionLine.create).not.toHaveBeenCalled();
      expect(tx.visionEvent.update).not.toHaveBeenCalled();
    });

    it('blocks approving a pickup of a product that is no longer ACTIVE', async () => {
      tx.product.findFirst.mockResolvedValue({
        id: 'prod-cola',
        status: 'ARCHIVED',
      });
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBe('product-not-saleable');
    });

    it('blocks a return with no active line to decrement', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...pendingEvent,
        type: VisionEventType.PRODUCT_RETURN,
      });
      tx.checkoutSessionLine.findFirst.mockResolvedValue(null);
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBe('no-line-to-decrement');
    });

    it('blocks an increment that would overflow the line quantity column', async () => {
      tx.checkoutSessionLine.findFirst.mockResolvedValue({
        id: 'line-9',
        quantity: 2_147_483_647,
        status: CheckoutSessionLineStatus.ACTIVE,
      });
      await expect(
        repository.review(
          'tenant-a',
          'event-1',
          { decision: VisionReviewDecision.APPROVE },
          reviewBuilders,
        ),
      ).resolves.toBe('line-quantity-overflow');
      expect(tx.checkoutSessionLine.update).not.toHaveBeenCalled();
    });
  });

  describe('bindSession', () => {
    const unboundEvent = { ...pendingEvent, sessionId: null };
    const bindAudit = () => auditEntry('VisionEvent');

    beforeEach(() => {
      tx.visionEvent.findFirst.mockResolvedValue(unboundEvent);
    });

    it('throws on a blank tenantId instead of widening the query', () => {
      expect(() =>
        repository.bindSession('', 'event-1', 'sess-1', bindAudit),
      ).toThrow(TenantIdRequiredError);
    });

    it('binds an unbound pending event with a tenant-scoped compare-and-set and audits it', async () => {
      await repository.bindSession('tenant-a', 'event-1', 'sess-1', bindAudit);
      expect(tx.visionEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
      expect(tx.checkoutSession.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-a' }),
        }),
      );
      // Conditional write (sessionId IS NULL) so a concurrent checkout
      // lineage CLAIM can never be stomped.
      expect(tx.visionEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'event-1',
            tenantId: 'tenant-a',
            sessionId: null,
          },
          data: { sessionId: 'sess-1' },
        }),
      );
      expect(auditLog.record).toHaveBeenCalledTimes(1);
    });

    it('loses the race to a concurrent checkout claim as already-bound', async () => {
      tx.visionEvent.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        repository.bindSession('tenant-a', 'event-1', 'sess-1', bindAudit),
      ).resolves.toBe('already-bound');
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('returns null when the event is missing in this tenant', async () => {
      tx.visionEvent.findFirst.mockResolvedValue(null);
      await expect(
        repository.bindSession('tenant-a', 'missing', 'sess-1', bindAudit),
      ).resolves.toBeNull();
    });

    it('blocks binding a decided event', async () => {
      tx.visionEvent.findFirst.mockResolvedValue({
        ...unboundEvent,
        status: VisionEventStatus.APPROVED,
      });
      await expect(
        repository.bindSession('tenant-a', 'event-1', 'sess-1', bindAudit),
      ).resolves.toBe('already-decided');
      expect(tx.visionEvent.update).not.toHaveBeenCalled();
    });

    it('blocks rebinding an event that already has a session', async () => {
      tx.visionEvent.findFirst.mockResolvedValue(pendingEvent);
      await expect(
        repository.bindSession('tenant-a', 'event-1', 'sess-2', bindAudit),
      ).resolves.toBe('already-bound');
      expect(tx.visionEvent.update).not.toHaveBeenCalled();
    });

    it('rejects a session missing in this tenant', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue(null);
      await expect(
        repository.bindSession('tenant-a', 'event-1', 'sess-1', bindAudit),
      ).resolves.toBe('session-not-found');
    });

    it('rejects a session at a different unit', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        unitId: 'unit-OTHER',
      });
      await expect(
        repository.bindSession('tenant-a', 'event-1', 'sess-1', bindAudit),
      ).resolves.toBe('session-unit-mismatch');
      expect(tx.visionEvent.update).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects a session at the same unit but a different store', async () => {
      tx.checkoutSession.findFirst.mockResolvedValue({
        id: 'sess-1',
        unitId: 'unit-a1',
        locationId: 'loc-OTHER',
      });
      await expect(
        repository.bindSession('tenant-a', 'event-1', 'sess-1', bindAudit),
      ).resolves.toBe('session-location-mismatch');
      expect(tx.visionEvent.updateMany).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });
});
