import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  InferenceJobStatus,
  InferenceJobType,
  VisionEventType,
} from '@prisma/client';
import { AuditEntry } from '../common/audit/audit-log.service';
import { InferenceAdapterRegistry } from './adapters/adapter.registry';
import { SimulatedInferenceAdapter } from './adapters/simulated.adapter';
import { CompleteInferenceJobDto } from './dto/complete-inference-job.dto';
import { InferenceJobDetail } from './inference-jobs.repository';
import { InferenceJobsService } from './inference-jobs.service';

describe('InferenceJobsService', () => {
  const actor = { id: 'user-1', email: 'jane@tenant-a.example' };

  const jobDetail = {
    id: 'job-1',
    tenantId: 'tenant-a',
    locationId: 'loc-a1',
    unitId: 'unit-a1',
    deviceId: null,
    sessionId: 'sess-1',
    jobType: InferenceJobType.PRODUCT_RECOGNITION,
    status: InferenceJobStatus.QUEUED,
    priority: 100,
    requestedAt: new Date('2026-07-26T10:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    sourceType: 'VISION',
    adapterKey: null,
    visionEventId: null,
    result: null,
  } as unknown as InferenceJobDetail;

  const succeededJob = {
    ...jobDetail,
    status: InferenceJobStatus.SUCCEEDED,
    adapterKey: 'simulated',
    startedAt: new Date('2026-07-26T10:01:00.000Z'),
    completedAt: new Date('2026-07-26T10:02:00.000Z'),
    result: {
      id: 'result-1',
      tenantId: 'tenant-a',
      jobId: 'job-1',
      eventType: VisionEventType.PRODUCT_PICKUP,
      quantityDelta: 2,
      evidenceScore: 0.92,
      evidenceQuality: 'HIGH',
      modelKey: 'sim-model',
      modelVersion: '1.0',
      candidates: [
        {
          id: 'cand-1',
          rank: 1,
          sku: 'COLA-330',
          score: 0.92,
          label: 'red can',
        },
        { id: 'cand-2', rank: 2, sku: 'CHIPS-50', score: 0.41, label: null },
      ],
    },
  } as unknown as InferenceJobDetail;

  const visionEvent = { id: 'event-1', tenantId: 'tenant-a' };

  let repository: {
    findById: jest.Mock;
    findByIdempotencyKey: jest.Mock;
    search: jest.Mock;
    linkVisionEvent: jest.Mock;
  };
  let queue: {
    enqueue: jest.Mock;
    claimNext: jest.Mock;
    markRunning: jest.Mock;
    complete: jest.Mock;
    fail: jest.Mock;
  };
  let visionEvents: { ingest: jest.Mock; findById: jest.Mock };
  let platformModules: { isEnabledForTenant: jest.Mock };
  let registry: InferenceAdapterRegistry;
  let service: InferenceJobsService;

  const baseCreate = {
    jobType: InferenceJobType.PRODUCT_RECOGNITION,
    locationId: 'loc-a1',
    unitId: 'unit-a1',
  };

  const baseComplete: CompleteInferenceJobDto = {
    eventType: VisionEventType.PRODUCT_PICKUP,
    quantityDelta: 2,
    detections: [
      { sku: 'cola-330', confidence: 0.92, label: 'red can' },
      { sku: 'chips-50', confidence: 0.41 },
    ],
  };

  beforeEach(() => {
    repository = {
      findById: jest.fn().mockResolvedValue(jobDetail),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      search: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      linkVisionEvent: jest.fn().mockResolvedValue({
        ...succeededJob,
        visionEventId: 'event-1',
      }),
    };
    queue = {
      enqueue: jest
        .fn()
        .mockResolvedValue({ job: jobDetail, replayed: false }),
      claimNext: jest.fn(),
      markRunning: jest.fn().mockResolvedValue({
        ...jobDetail,
        status: InferenceJobStatus.RUNNING,
        adapterKey: 'simulated',
      }),
      complete: jest.fn().mockResolvedValue(succeededJob),
      fail: jest.fn().mockResolvedValue({
        ...jobDetail,
        status: InferenceJobStatus.FAILED,
      }),
    };
    visionEvents = {
      ingest: jest.fn().mockResolvedValue(visionEvent),
      findById: jest.fn().mockResolvedValue(visionEvent),
    };
    platformModules = { isEnabledForTenant: jest.fn().mockResolvedValue(true) };
    registry = new InferenceAdapterRegistry(new SimulatedInferenceAdapter());
    service = new InferenceJobsService(
      repository as never,
      queue as never,
      registry,
      visionEvents as never,
      platformModules as never,
    );
  });

  describe('create', () => {
    it('enqueues with the default priority and builds a CREATE audit entry', async () => {
      await service.create('tenant-a', baseCreate, actor);
      const [tenantId, input, buildAudit] = queue.enqueue.mock.calls[0] as [
        string,
        { priority: number; jobType: InferenceJobType },
        (job: InferenceJobDetail) => AuditEntry,
      ];
      expect(tenantId).toBe('tenant-a');
      expect(input.priority).toBe(100);
      expect(input.jobType).toBe(InferenceJobType.PRODUCT_RECOGNITION);
      expect(buildAudit(jobDetail)).toEqual(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actorId: 'user-1',
          action: AuditAction.CREATE,
          entityType: 'InferenceJob',
          entityId: 'job-1',
        }),
      );
    });

    it('replays the winner on an idempotency-key unique race', async () => {
      queue.enqueue.mockRejectedValue({ code: 'P2002' });
      repository.findByIdempotencyKey.mockResolvedValue(jobDetail);
      await expect(
        service.create(
          'tenant-a',
          { ...baseCreate, idempotencyKey: 'key-1' },
          actor,
        ),
      ).resolves.toBe(jobDetail);
      expect(repository.findByIdempotencyKey).toHaveBeenCalledWith(
        'tenant-a',
        'key-1',
      );
    });

    it.each([
      'location-not-found',
      'unit-not-found',
      'unit-location-mismatch',
      'device-not-found',
      'device-unit-mismatch',
      'session-not-found',
      'session-unit-mismatch',
    ])('maps %s to a 400', async (rejection) => {
      queue.enqueue.mockResolvedValue(rejection);
      await expect(
        service.create('tenant-a', baseCreate, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['sourceId', { sourceId: 'rtsp://admin:hunter2@cam.local/1' }],
      ['idempotencyKey', { idempotencyKey: 'password=hunter2' }],
    ])(
      'rejects a credential-bearing %s before any write',
      async (_field, fields) => {
        await expect(
          service.create('tenant-a', { ...baseCreate, ...fields }, actor),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(queue.enqueue).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['a media URL key', { crop: { cropImageUrl: 's3://bucket/c.jpg' } }],
      ['a frame key', { frames: [1, 2, 3] }],
      ['a storage key', { storageKey: 'tenant-a/crops/1.jpg' }],
      ['a signed URL key', { signedUrl: 'https://cdn.example/x' }],
      ['an artifact descriptor', { artifacts: [{ kind: 'frame' }] }],
      ['inline base64', { payload: { base64: 'AAAA' } }],
      [
        'an inline data: URI value',
        { note: 'data:image/png;base64,iVBORw0KGgo' },
      ],
      ['a credential-shaped key', { config: { apiKey: 'x' } }],
      [
        'a credential-bearing value',
        { stream: 'rtsp://admin:hunter2@cam.local/1' },
      ],
    ])(
      'rejects an inputDescriptor carrying %s before any write',
      async (_label, inputDescriptor) => {
        await expect(
          service.create(
            'tenant-a',
            { ...baseCreate, inputDescriptor },
            actor,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(queue.enqueue).not.toHaveBeenCalled();
      },
    );

    it('accepts a safe typed inputDescriptor', async () => {
      await service.create(
        'tenant-a',
        {
          ...baseCreate,
          inputDescriptor: {
            trigger: 'hand-in-zone',
            zoneId: 'zone-3',
            cropId: 'crop-42',
            frameCount: 4,
          },
        },
        actor,
      );
      expect(queue.enqueue).toHaveBeenCalled();
    });
  });

  describe('search', () => {
    it('applies pagination defaults and returns the envelope', async () => {
      await expect(service.search('tenant-a', {})).resolves.toEqual({
        items: [],
        total: 0,
        skip: 0,
        take: 25,
      });
      expect(repository.search).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({ skip: 0, take: 25 }),
      );
    });
  });

  describe('findById', () => {
    it('404s when the job is not found in this tenant', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(
        service.findById('tenant-a', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('start', () => {
    it('starts with the default simulated adapter and audits the UPDATE', async () => {
      await service.start('tenant-a', 'job-1', {}, actor);
      const [tenantId, jobId, adapterKey, buildAudit] = queue.markRunning.mock
        .calls[0] as [
        string,
        string,
        string,
        (before: InferenceJobDetail, after: InferenceJobDetail) => AuditEntry,
      ];
      expect([tenantId, jobId, adapterKey]).toEqual([
        'tenant-a',
        'job-1',
        'simulated',
      ]);
      expect(buildAudit(jobDetail, jobDetail)).toEqual(
        expect.objectContaining({
          action: AuditAction.UPDATE,
          entityType: 'InferenceJob',
          actorId: 'user-1',
        }),
      );
    });

    it('rejects an unknown adapter key with a 400', async () => {
      await expect(
        service.start('tenant-a', 'job-1', { adapterKey: 'ghost' }, actor),
      ).rejects.toThrow(/Unknown inference adapter/);
      expect(queue.markRunning).not.toHaveBeenCalled();
    });

    it('rejects an adapter that does not support the job type', async () => {
      registry.register({
        adapterKey: 'ocr-only',
        supportedJobTypes: [InferenceJobType.OCR_REVIEW],
        validateInput: jest.fn(),
        run: jest.fn(),
        normalizeResult: jest.fn(),
      });
      await expect(
        service.start('tenant-a', 'job-1', { adapterKey: 'ocr-only' }, actor),
      ).rejects.toThrow(/does not support job type PRODUCT_RECOGNITION/);
      expect(queue.markRunning).not.toHaveBeenCalled();
    });

    it('maps terminal to a 409', async () => {
      queue.markRunning.mockResolvedValue('terminal');
      await expect(
        service.start('tenant-a', 'job-1', {}, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps not-claimable to a 409', async () => {
      queue.markRunning.mockResolvedValue('not-claimable');
      await expect(
        service.start('tenant-a', 'job-1', {}, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s when the job vanished', async () => {
      queue.markRunning.mockResolvedValue(null);
      await expect(
        service.start('tenant-a', 'job-1', {}, actor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('complete', () => {
    beforeEach(() => {
      repository.findById.mockResolvedValue({
        ...jobDetail,
        status: InferenceJobStatus.RUNNING,
        adapterKey: 'simulated',
      });
    });

    it('normalizes detections through the adapter and audits COMPLETE', async () => {
      await service.complete('tenant-a', 'job-1', baseComplete, actor);
      const [tenantId, jobId, normalized, buildAudit] = queue.complete.mock
        .calls[0] as [
        string,
        string,
        {
          eventType: VisionEventType;
          quantityDelta: number;
          candidates: unknown[];
          evidenceScore?: number;
        },
        (before: InferenceJobDetail, after: InferenceJobDetail) => AuditEntry,
      ];
      expect([tenantId, jobId]).toEqual(['tenant-a', 'job-1']);
      expect(normalized.eventType).toBe(VisionEventType.PRODUCT_PICKUP);
      expect(normalized.quantityDelta).toBe(2);
      expect(normalized.candidates).toEqual([
        { sku: 'COLA-330', rank: 1, score: 0.92, label: 'red can' },
        { sku: 'CHIPS-50', rank: 2, score: 0.41 },
      ]);
      expect(normalized.evidenceScore).toBe(0.92);
      expect(buildAudit(jobDetail, succeededJob)).toEqual(
        expect.objectContaining({ action: AuditAction.COMPLETE }),
      );
    });

    it('dedupes duplicate SKUs keeping the strongest detection', async () => {
      await service.complete(
        'tenant-a',
        'job-1',
        {
          ...baseComplete,
          detections: [
            { sku: 'cola-330', confidence: 0.4 },
            { sku: 'COLA-330', confidence: 0.9 },
          ],
        },
        actor,
      );
      const normalized = queue.complete.mock.calls[0][2] as {
        candidates: { sku: string; rank: number; score: number }[];
      };
      expect(normalized.candidates).toEqual([
        { sku: 'COLA-330', rank: 1, score: 0.9 },
      ]);
    });

    it('rejects a negative quantityDelta for a non-return event before any write', async () => {
      await expect(
        service.complete(
          'tenant-a',
          'job-1',
          { ...baseComplete, quantityDelta: -1 },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.complete).not.toHaveBeenCalled();
    });

    it('rejects a positive quantityDelta for PRODUCT_RETURN before any write', async () => {
      await expect(
        service.complete(
          'tenant-a',
          'job-1',
          {
            ...baseComplete,
            eventType: VisionEventType.PRODUCT_RETURN,
            quantityDelta: 1,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.complete).not.toHaveBeenCalled();
    });

    it.each([
      ['sku', { sku: 'sk_live_0a1b2c3d4e5f6g7h', confidence: 0.5 }],
      [
        'label',
        {
          sku: 'COLA-330',
          confidence: 0.5,
          label: 'see rtsp://admin:hunter2@cam.local/1',
        },
      ],
    ])(
      'rejects a credential-bearing detection %s before any write',
      async (_field, detection) => {
        await expect(
          service.complete(
            'tenant-a',
            'job-1',
            { ...baseComplete, detections: [detection] },
            actor,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(queue.complete).not.toHaveBeenCalled();
      },
    );

    it('rejects a credential-bearing modelKey before any write', async () => {
      await expect(
        service.complete(
          'tenant-a',
          'job-1',
          { ...baseComplete, modelKey: 'api_key=abc123' },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.complete).not.toHaveBeenCalled();
    });

    it('409s a QUEUED job (complete requires RUNNING)', async () => {
      repository.findById.mockResolvedValue(jobDetail);
      await expect(
        service.complete('tenant-a', 'job-1', baseComplete, actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queue.complete).not.toHaveBeenCalled();
    });

    it.each([
      InferenceJobStatus.SUCCEEDED,
      InferenceJobStatus.FAILED,
      InferenceJobStatus.CANCELLED,
    ])('409s an already-terminal %s job', async (status) => {
      repository.findById.mockResolvedValue({ ...jobDetail, status });
      await expect(
        service.complete('tenant-a', 'job-1', baseComplete, actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(queue.complete).not.toHaveBeenCalled();
    });

    it('maps a terminal compare-and-set race to a 409', async () => {
      queue.complete.mockResolvedValue('terminal');
      await expect(
        service.complete('tenant-a', 'job-1', baseComplete, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('fail', () => {
    it('fails with an audit FAIL entry', async () => {
      await service.fail(
        'tenant-a',
        'job-1',
        { errorCode: 'ADAPTER_TIMEOUT', errorMessage: 'took too long' },
        actor,
      );
      const buildAudit = queue.fail.mock.calls[0][3] as (
        before: InferenceJobDetail,
        after: InferenceJobDetail,
      ) => AuditEntry;
      expect(buildAudit(jobDetail, jobDetail)).toEqual(
        expect.objectContaining({
          action: AuditAction.FAIL,
          entityType: 'InferenceJob',
          reason: expect.stringContaining('ADAPTER_TIMEOUT'),
        }),
      );
    });

    it('rejects a credential-bearing errorMessage before any write', async () => {
      await expect(
        service.fail(
          'tenant-a',
          'job-1',
          {
            errorCode: 'ADAPTER_ERROR',
            errorMessage: 'auth failed: password=hunter2',
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.fail).not.toHaveBeenCalled();
    });

    it('maps terminal to a 409', async () => {
      queue.fail.mockResolvedValue('terminal');
      await expect(
        service.fail('tenant-a', 'job-1', { errorCode: 'X_Y' }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s a missing job', async () => {
      queue.fail.mockResolvedValue(null);
      await expect(
        service.fail('tenant-a', 'job-1', { errorCode: 'X_Y' }, actor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('toVisionEvent', () => {
    beforeEach(() => {
      repository.findById.mockResolvedValue(succeededJob);
    });

    it('builds an exact Phase 7-compatible ingest payload', async () => {
      const outcome = await service.toVisionEvent('tenant-a', 'job-1', actor);
      expect(visionEvents.ingest).toHaveBeenCalledWith(
        'tenant-a',
        {
          locationId: 'loc-a1',
          unitId: 'unit-a1',
          deviceId: undefined,
          sessionId: 'sess-1',
          type: VisionEventType.PRODUCT_PICKUP,
          occurredAt: '2026-07-26T10:02:00.000Z',
          quantity: 2,
          candidates: [
            { sku: 'COLA-330', rank: 1, score: 0.92, label: 'red can' },
            { sku: 'CHIPS-50', rank: 2, score: 0.41, label: undefined },
          ],
          sourceType: 'VISION',
          evidenceScore: 0.92,
          evidenceQuality: 'HIGH',
          idempotencyKey: 'inference:job-1',
        },
        actor,
      );
      // Phase 7 rejects provenance strings: modelKey/modelVersion stay
      // internal to the inference result and must NEVER reach the payload.
      const payload = visionEvents.ingest.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      for (const removed of [
        'sourceId',
        'modelName',
        'modelVersion',
        'modelKey',
        'metadata',
        'artifacts',
      ]) {
        expect(payload).not.toHaveProperty(removed);
      }
      expect(outcome.replayed).toBe(false);
      expect(outcome.visionEvent).toBe(visionEvent);
    });

    it('emits the magnitude for a PRODUCT_RETURN delta', async () => {
      repository.findById.mockResolvedValue({
        ...succeededJob,
        result: {
          ...(succeededJob.result as object),
          eventType: VisionEventType.PRODUCT_RETURN,
          quantityDelta: -3,
        },
      });
      await service.toVisionEvent('tenant-a', 'job-1', actor);
      const payload = visionEvents.ingest.mock.calls[0][1] as {
        type: VisionEventType;
        quantity: number;
      };
      expect(payload.type).toBe(VisionEventType.PRODUCT_RETURN);
      expect(payload.quantity).toBe(3);
    });

    it('links the job to the created event with an UPDATE audit entry', async () => {
      await service.toVisionEvent('tenant-a', 'job-1', actor);
      const [tenantId, jobId, eventId, buildAudit] = repository
        .linkVisionEvent.mock.calls[0] as [
        string,
        string,
        string,
        (before: InferenceJobDetail, after: InferenceJobDetail) => AuditEntry,
      ];
      expect([tenantId, jobId, eventId]).toEqual([
        'tenant-a',
        'job-1',
        'event-1',
      ]);
      expect(buildAudit(succeededJob, succeededJob)).toEqual(
        expect.objectContaining({
          action: AuditAction.UPDATE,
          entityType: 'InferenceJob',
          reason: expect.stringContaining('event-1'),
        }),
      );
    });

    it('replays without ingesting when the job is already linked', async () => {
      repository.findById.mockResolvedValue({
        ...succeededJob,
        visionEventId: 'event-1',
      });
      const outcome = await service.toVisionEvent('tenant-a', 'job-1', actor);
      expect(outcome.replayed).toBe(true);
      expect(visionEvents.ingest).not.toHaveBeenCalled();
      expect(visionEvents.findById).toHaveBeenCalledWith(
        'tenant-a',
        'event-1',
      );
    });

    it('replays when losing the link race to a concurrent conversion', async () => {
      repository.linkVisionEvent.mockResolvedValue('already-linked');
      repository.findById
        .mockResolvedValueOnce(succeededJob)
        .mockResolvedValueOnce({
          ...succeededJob,
          visionEventId: 'event-1',
        });
      const outcome = await service.toVisionEvent('tenant-a', 'job-1', actor);
      expect(outcome.replayed).toBe(true);
    });

    it.each([
      InferenceJobStatus.QUEUED,
      InferenceJobStatus.RUNNING,
      InferenceJobStatus.FAILED,
      InferenceJobStatus.CANCELLED,
    ])('409s a %s job', async (status) => {
      repository.findById.mockResolvedValue({
        ...succeededJob,
        status,
        result: null,
        visionEventId: null,
      });
      await expect(
        service.toVisionEvent('tenant-a', 'job-1', actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(visionEvents.ingest).not.toHaveBeenCalled();
    });

    it('409s a job without store/unit binding', async () => {
      repository.findById.mockResolvedValue({
        ...succeededJob,
        locationId: null,
        unitId: null,
      });
      await expect(
        service.toVisionEvent('tenant-a', 'job-1', actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(visionEvents.ingest).not.toHaveBeenCalled();
    });

    it('403s when the cv module is disabled for the tenant', async () => {
      platformModules.isEnabledForTenant.mockResolvedValue(false);
      await expect(
        service.toVisionEvent('tenant-a', 'job-1', actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(platformModules.isEnabledForTenant).toHaveBeenCalledWith(
        'tenant-a',
        'cv',
      );
      expect(visionEvents.ingest).not.toHaveBeenCalled();
    });
  });
});
