import {
  PickupDetectionService,
  pickupSourceId,
  scaleBoxToSource,
} from './pickup-detection.service';
import { MATCHER_MODEL_KEY, ReferenceImage } from './analysis/product-matcher';
import { AnalysisFrame } from './analysis/pickup-analyzer';

/**
 * Pipeline-logic tests with every seam mocked: the decoder yields a
 * deterministic synthetic pickup scene (the same shape as the analyzer
 * spec), so these tests prove the ORCHESTRATION — job lifecycle calls,
 * artifact idempotency keys, threshold behavior (UNKNOWN_PRODUCT), and
 * the failure codes — without any media tooling.
 */

const TENANT = 'tenant-1';
const ASSET = 'asset-1';
const GEOMETRY = { width: 40, height: 30 };
const PRODUCT_BOX = { x: 10, y: 8, width: 10, height: 10 };
const RED: [number, number, number] = [200, 30, 30];
const BLUE: [number, number, number] = [30, 60, 200];

function solid(gray: number): Buffer {
  return Buffer.alloc(GEOMETRY.width * GEOMETRY.height * 3, gray);
}

function paint(
  frame: Buffer,
  rect: { x: number; y: number; width: number; height: number },
  rgb: [number, number, number],
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * GEOMETRY.width + x) * 3;
      frame[offset] = rgb[0];
      frame[offset + 1] = rgb[1];
      frame[offset + 2] = rgb[2];
    }
  }
}

function scene(productPresent: boolean, handX: number | null): Buffer {
  const frame = solid(120);
  if (productPresent) {
    paint(frame, PRODUCT_BOX, RED);
  }
  if (handX !== null) {
    paint(frame, { x: handX, y: 6, width: 6, height: 14 }, [250, 240, 230]);
  }
  return frame;
}

function pickupFrames(): AnalysisFrame[] {
  const buffers: Buffer[] = [];
  for (let i = 0; i <= 5; i += 1) buffers.push(scene(true, null));
  buffers.push(scene(true, 30));
  buffers.push(scene(true, 18));
  buffers.push(scene(false, 12));
  buffers.push(scene(false, 28));
  for (let i = 10; i <= 15; i += 1) buffers.push(scene(false, null));
  return buffers.map((rgb, index) => ({ index, timestampMs: index * 500, rgb }));
}

function stillFrames(): AnalysisFrame[] {
  return Array.from({ length: 16 }, (_, index) => ({
    index,
    timestampMs: index * 500,
    rgb: scene(true, null),
  }));
}

function referenceImage(rgb: [number, number, number]): ReferenceImage['image'] {
  const edge = 48;
  const buffer = Buffer.alloc(edge * edge * 3);
  for (let i = 0; i < edge * edge; i += 1) {
    buffer[i * 3] = rgb[0];
    buffer[i * 3 + 1] = rgb[1];
    buffer[i * 3 + 2] = rgb[2];
  }
  return { width: edge, height: edge, rgb: buffer };
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET,
    tenantId: TENANT,
    status: 'VALIDATED',
    storageKey: `${TENANT}/uuid/original.mp4`,
    durationMs: 8000,
    width: 640,
    height: 480,
    fps: 15,
    locationId: 'loc-1',
    unitId: 'unit-1',
    deviceId: null,
    sessionId: null,
    deletedAt: null,
    mediaRemovedAt: null,
    createdAt: new Date('2026-08-03T10:00:00.000Z'),
    ...overrides,
  };
}

interface Harness {
  service: PickupDetectionService;
  inferenceJobs: Record<string, jest.Mock>;
  platformModules: Record<string, jest.Mock>;
  videoAssets: Record<string, jest.Mock>;
  referenceLibrary: Record<string, jest.Mock>;
  prisma: {
    visionEvent: { update: jest.Mock; findFirst: jest.Mock };
    inferenceJob: { findFirst: jest.Mock; count: jest.Mock };
    videoExtractionRequest: { findFirst: jest.Mock };
    videoArtifact: { findFirst: jest.Mock };
  };
}

function buildService(overrides: {
  frames?: AnalysisFrame[];
  references?: ReferenceImage[];
  asset?: Record<string, unknown>;
  threshold?: number;
  existingJob?: Record<string, unknown> | null;
  libraryLoad?: { references: ReferenceImage[]; productsWithImages: number; readyProducts: number };
  readyProductIds?: string[];
} = {}): Harness {
  const frames = overrides.frames ?? pickupFrames();
  const references =
    overrides.references ??
    ([
      { productId: 'p-red', sku: 'SKU-RED', image: referenceImage(RED) },
      { productId: 'p-blue', sku: 'SKU-BLUE', image: referenceImage(BLUE) },
    ] as ReferenceImage[]);
  const prisma = {
    visionEvent: {
      update: jest.fn(async () => ({})),
      findFirst: jest.fn(async () => null),
    },
    inferenceJob: {
      findFirst: jest.fn(async () => overrides.existingJob ?? null),
      count: jest.fn(async () => 0),
    },
    videoExtractionRequest: {
      findFirst: jest.fn(async () => null),
    },
    videoArtifact: {
      findFirst: jest.fn(async () => null),
    },
  };
  const config = {
    enabled: true,
    analysisFps: 2,
    analysisWidth: GEOMETRY.width,
    confidenceThreshold: overrides.threshold ?? 0.62,
    referenceDir: '/unused',
  };
  const decoder = {
    decodeAnalysisFrames: jest.fn(async () => frames),
    decodeReferenceImage: jest.fn(),
  };
  const referenceLibrary = {
    load: jest.fn(async () =>
      overrides.libraryLoad ?? {
        references,
        productsWithImages: references.length > 0 ? 2 : 0,
        readyProducts: references.length > 0 ? 2 : 0,
      },
    ),
    readyProductIds: jest.fn(async () =>
      overrides.readyProductIds ??
      [...new Set(references.map((reference) => reference.productId))],
    ),
  };
  const inferenceJobs = {
    create: jest.fn(async () => ({ id: 'job-1', attempts: 0 })),
    start: jest.fn(async () => ({ id: 'job-1', attempts: 1 })),
    complete: jest.fn(async () => ({ id: 'job-1' })),
    fail: jest.fn(async () => ({ id: 'job-1' })),
    reclaimExpired: jest.fn(async () => ({ reclaimed: [] })),
    toVisionEvent: jest.fn(async () => ({
      job: { id: 'job-1' },
      visionEvent: { id: 'event-1' },
      replayed: false,
    })),
  };
  const platformModules = {
    isEnabledForTenant: jest.fn(async () => true),
  };
  const videoAssets = {
    extractFrames: jest.fn(async () => ({
      artifacts: [{ id: 'frame-artifact-1' }],
      replayed: false,
    })),
    createCrop: jest.fn(async () => ({
      artifact: { id: 'crop-artifact-1' },
      replayed: false,
    })),
  };
  const repository = {
    findByIdInternal: jest.fn(async () => assetRow(overrides.asset)),
  };
  const storage = { internalPathFor: jest.fn(() => '/root/x') };
  const service = new PickupDetectionService(
    prisma as never,
    config as never,
    decoder as never,
    referenceLibrary as never,
    inferenceJobs as never,
    platformModules as never,
    videoAssets as never,
    repository as never,
    storage as never,
  );
  return {
    service,
    inferenceJobs: inferenceJobs as never,
    platformModules: platformModules as never,
    videoAssets: videoAssets as never,
    referenceLibrary: referenceLibrary as never,
    prisma,
  };
}

describe('scaleBoxToSource', () => {
  it('scales analysis coordinates to source pixels and clamps to bounds', () => {
    const box = scaleBoxToSource(
      { x: 10, y: 8, width: 10, height: 10 },
      { width: 40, height: 30 },
      { width: 640, height: 480 },
    );
    expect(box).toEqual({ x: 160, y: 128, width: 160, height: 160 });
    const clamped = scaleBoxToSource(
      { x: 39, y: 29, width: 10, height: 10 },
      { width: 40, height: 30 },
      { width: 640, height: 480 },
    );
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(640);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(480);
  });
});

describe('PickupDetectionService.detectForAsset', () => {
  it('completes the job with pixel-derived candidates and records PRODUCT_MATCHED', async () => {
    const { service, inferenceJobs, prisma } = buildService();
    await service.detectForAsset(TENANT, ASSET);

    expect(inferenceJobs.start).toHaveBeenCalledWith(TENANT, 'job-1', {
      adapterKey: 'pickup-classical-v1',
    });
    const completion = inferenceJobs.complete.mock.calls[0][2];
    expect(completion.eventType).toBe('PRODUCT_PICKUP');
    expect(completion.quantityDelta).toBe(1);
    expect(completion.modelKey).toBe(MATCHER_MODEL_KEY);
    expect(completion.detections[0].sku).toBe('SKU-RED');
    expect(completion.detections[0].confidence).toBeGreaterThan(0.62);
    // occurredAt = asset.createdAt + peak offset, timezone-aware.
    expect(completion.occurredAt).toMatch(/Z$/);

    expect(inferenceJobs.toVisionEvent).toHaveBeenCalledWith(TENANT, 'job-1');
    // The metadata write is tenant-scoped via the composite unique key —
    // id alone must never address another tenant's event.
    expect(prisma.visionEvent.update.mock.calls[0][0].where).toEqual({
      id_tenantId: { id: 'event-1', tenantId: TENANT },
    });
    const metadata = prisma.visionEvent.update.mock.calls[0][0].data
      .metadata as Record<string, unknown>;
    expect(metadata.kind).toBe('PRODUCT_PICKUP_DETECTION');
    expect(metadata.result).toBe('PRODUCT_MATCHED');
    expect(metadata.productId).toBe('p-red');
    expect(metadata.sku).toBe('SKU-RED');
    expect(metadata.sourceFrameArtifactId).toBe('frame-artifact-1');
    expect(metadata.cropArtifactId).toBe('crop-artifact-1');
    expect(metadata.eventStartMs).toBeLessThanOrEqual(
      metadata.eventPeakMs as number,
    );
    expect(metadata.eventPeakMs).toBeLessThanOrEqual(
      metadata.eventEndMs as number,
    );
    expect(inferenceJobs.fail).not.toHaveBeenCalled();
  });

  it('records UNKNOWN_PRODUCT with productId null below the threshold', async () => {
    // Threshold above any achievable score for this scene.
    const { service, inferenceJobs, prisma } = buildService({ threshold: 0.999 });
    await service.detectForAsset(TENANT, ASSET);

    // Candidates are still recorded (they are suggestions, not claims)...
    expect(inferenceJobs.complete).toHaveBeenCalled();
    // ...but the persisted verdict claims nothing.
    const metadata = prisma.visionEvent.update.mock.calls[0][0].data
      .metadata as Record<string, unknown>;
    expect(metadata.result).toBe('UNKNOWN_PRODUCT');
    expect(metadata.productId).toBeNull();
    expect(metadata.sku).toBeNull();
  });

  it('fails the job with NO_MOTION_EVENT on a motionless clip', async () => {
    const { service, inferenceJobs } = buildService({ frames: stillFrames() });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.fail).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.objectContaining({ errorCode: 'NO_MOTION_EVENT' }),
    );
    expect(inferenceJobs.complete).not.toHaveBeenCalled();
  });

  it('fails the job with MISSING_LOCATION_CONTEXT when the asset has no store/unit', async () => {
    const { service, inferenceJobs } = buildService({
      asset: { locationId: null, unitId: null },
    });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.fail).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.objectContaining({ errorCode: 'MISSING_LOCATION_CONTEXT' }),
    );
  });

  it('fails the job with REFERENCE_LIBRARY_EMPTY when no references exist', async () => {
    const { service, inferenceJobs } = buildService({ references: [] });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.fail).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.objectContaining({ errorCode: 'REFERENCE_LIBRARY_EMPTY' }),
    );
  });

  it('fails with NO_INFERENCE_READY_SKUS when images exist but no product reaches the 5-image floor', async () => {
    const { service, inferenceJobs } = buildService({
      libraryLoad: { references: [], productsWithImages: 3, readyProducts: 0 },
    });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.fail).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.objectContaining({ errorCode: 'NO_INFERENCE_READY_SKUS' }),
    );
    expect(inferenceJobs.complete).not.toHaveBeenCalled();
  });

  it('fails with NO_INFERENCE_READY_SKUS when the store stocks no ready SKUs', async () => {
    const { service, inferenceJobs } = buildService({ readyProductIds: [] });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.fail).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.objectContaining({
        errorCode: 'NO_INFERENCE_READY_SKUS',
        errorMessage: expect.stringContaining('store'),
      }),
    );
  });

  it('records processingMs and up to 10 ranked candidates', async () => {
    const { service, inferenceJobs, prisma } = buildService();
    await service.detectForAsset(TENANT, ASSET);
    const completion = inferenceJobs.complete.mock.calls[0][2];
    expect(completion.detections.length).toBeLessThanOrEqual(10);
    const metadata = prisma.visionEvent.update.mock.calls[0][0].data
      .metadata as Record<string, unknown>;
    expect(typeof metadata.processingMs).toBe('number');
    expect(metadata.processingMs as number).toBeGreaterThanOrEqual(0);
  });

  it('persists artifacts under job-scoped idempotency keys', async () => {
    const { service, videoAssets } = buildService();
    await service.detectForAsset(TENANT, ASSET);
    expect(videoAssets.extractFrames).toHaveBeenCalledWith(
      TENANT,
      ASSET,
      expect.objectContaining({ idempotencyKey: 'pickup:job-1:frame' }),
    );
    expect(videoAssets.createCrop).toHaveBeenCalledWith(
      TENANT,
      ASSET,
      expect.objectContaining({
        idempotencyKey: 'pickup:job-1:crop',
        reason: 'PRODUCT_PICKUP',
      }),
    );
  });

  it('never re-runs a SUCCEEDED attempt with a recorded detection without force', async () => {
    const { service, inferenceJobs, prisma } = buildService({
      existingJob: {
        id: 'job-0',
        status: 'SUCCEEDED',
        visionEventId: 'event-0',
      },
    });
    prisma.visionEvent.findFirst.mockResolvedValue({
      id: 'event-0',
      status: 'PENDING_REVIEW',
      metadata: { kind: 'PRODUCT_PICKUP_DETECTION', productId: null },
      candidates: [],
      review: null,
    });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.create).not.toHaveBeenCalled();
  });

  it('re-runs a SUCCEEDED attempt only when it has no replayable result at all', async () => {
    // Invariant: SUCCEEDED implies a usable detection. A stranded success
    // with NO InferenceResult has nothing replayable behind it (conversion
    // requires the result, so no event can exist either) — only then does
    // a retry run a fresh attempt instead of replaying the empty success
    // forever.
    const { service, inferenceJobs } = buildService({
      existingJob: {
        id: 'job-0',
        status: 'SUCCEEDED',
        visionEventId: null,
        result: null,
      },
    });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.create).toHaveBeenCalled();
    expect(inferenceJobs.complete).toHaveBeenCalled();
  });

  it('repairs a SUCCEEDED attempt whose metadata write was lost instead of minting a second event', async () => {
    // Finding: complete → toVisionEvent → metadata write is non-atomic. A
    // transient failure on the LAST step used to make the retry fork a
    // fresh job, which converted under a NEW reserved key and produced a
    // second PENDING_REVIEW pickup event for the same physical pickup.
    // With the job's InferenceResult intact the attempt must be repaired
    // in place: idempotent conversion replay plus a metadata rewrite
    // rebuilt from the attempt's own PERSISTED output (immutable result,
    // the converted event's candidates, and the recorded artifacts) —
    // never from a rerun against the mutable reference library.
    const { service, inferenceJobs, prisma, videoAssets, referenceLibrary } =
      buildService({
        existingJob: {
          id: 'job-0',
          status: 'SUCCEEDED',
          visionEventId: 'event-0',
          inputDescriptor: {
            artifactType: 'VIDEO_ASSET',
            videoAssetId: ASSET,
            analysisFps: 4,
          },
          result: {
            id: 'result-0',
            // asset.createdAt + 3000 ms peak offset.
            occurredAt: new Date('2026-08-03T10:00:03.000Z'),
            evidenceQuality: 'HIGH',
            modelKey: 'model-k',
            modelVersion: 'model-v',
            candidates: [
              { rank: 2, sku: 'SKU-BLUE', score: 0.4, label: null },
              { rank: 1, sku: 'SKU-RED', score: 0.91, label: null },
            ],
          },
        },
      });
    // The linked event exists but its metadata record never landed; its
    // candidates carry the catalog productId resolved at conversion.
    prisma.visionEvent.findFirst.mockResolvedValue({
      id: 'event-0',
      status: 'PENDING_REVIEW',
      metadata: null,
      candidates: [
        {
          productId: 'p-red',
          sku: 'SKU-RED',
          productName: 'Red',
          score: 0.91,
          rank: 1,
        },
      ],
      review: null,
    });
    // The original attempt's artifacts, recorded under the job-derived
    // idempotency keys.
    prisma.videoExtractionRequest.findFirst.mockImplementation(
      async (args: { where: { idempotencyKey: string } }) =>
        args.where.idempotencyKey === 'pickup:job-0:crop'
          ? { artifactIds: ['crop-artifact-0'] }
          : { artifactIds: ['frame-artifact-0'] },
    );
    prisma.videoArtifact.findFirst.mockResolvedValue({
      id: 'crop-artifact-0',
      cropX: 160,
      cropY: 128,
      cropWidth: 160,
      cropHeight: 160,
    });
    inferenceJobs.toVisionEvent.mockResolvedValue({
      job: { id: 'job-0' },
      visionEvent: { id: 'event-0' },
      replayed: true,
    });
    await service.detectForAsset(TENANT, ASSET);
    // Never forked: conversion replays idempotently on the SAME job...
    expect(inferenceJobs.create).not.toHaveBeenCalled();
    expect(inferenceJobs.toVisionEvent).toHaveBeenCalledWith(TENANT, 'job-0');
    // ...detection is never recomputed (no library read, no re-extract)...
    expect(referenceLibrary.load).not.toHaveBeenCalled();
    expect(videoAssets.extractFrames).not.toHaveBeenCalled();
    expect(videoAssets.createCrop).not.toHaveBeenCalled();
    // ...and the record restored on the ORIGINAL event replays the
    // persisted attempt exactly, under a tenant-scoped where-clause.
    const update = prisma.visionEvent.update.mock.calls[0][0];
    expect(update.where).toEqual({
      id_tenantId: { id: 'event-0', tenantId: TENANT },
    });
    const metadata = update.data.metadata as Record<string, unknown>;
    expect(metadata.kind).toBe('PRODUCT_PICKUP_DETECTION');
    expect(metadata.result).toBe('PRODUCT_MATCHED');
    expect(metadata.sku).toBe('SKU-RED'); // rank-1 of the immutable result
    expect(metadata.productId).toBe('p-red'); // via the event's candidates
    expect(metadata.confidence).toBe(0.91);
    expect(metadata.eventPeakMs).toBe(3000); // occurredAt − asset.createdAt
    // Window bounds were never persisted: they collapse to the peak.
    expect(metadata.eventStartMs).toBe(3000);
    expect(metadata.eventEndMs).toBe(3000);
    expect(metadata.boundingBox).toEqual({
      x: 160,
      y: 128,
      width: 160,
      height: 160,
    });
    expect(metadata.sourceFrameArtifactId).toBe('frame-artifact-0');
    expect(metadata.cropArtifactId).toBe('crop-artifact-0');
    expect(metadata.analysisFps).toBe(4); // from the job's input descriptor
    expect(metadata.modelKey).toBe('model-k');
    expect(metadata.modelVersion).toBe('model-v');
    expect(metadata.processingMs).toBe(0);
  });

  it('repairs from the persisted result even when the reference library has since been emptied', async () => {
    // The reference library is mutable; the InferenceResult is not. With
    // every reference image deleted since the original attempt, the old
    // recompute-based repair failed with REFERENCE_LIBRARY_EMPTY and
    // stranded the converted event without its record forever — the
    // repair must not depend on the library at all.
    const { service, inferenceJobs, prisma } = buildService({
      references: [],
      existingJob: {
        id: 'job-0',
        status: 'SUCCEEDED',
        visionEventId: 'event-0',
        result: {
          id: 'result-0',
          occurredAt: new Date('2026-08-03T10:00:03.000Z'),
          evidenceQuality: 'LOW',
          modelKey: null,
          modelVersion: null,
          candidates: [
            { rank: 1, sku: 'SKU-RED', score: 0.31, label: null },
          ],
        },
      },
    });
    prisma.visionEvent.findFirst.mockResolvedValue({
      id: 'event-0',
      status: 'PENDING_REVIEW',
      metadata: null,
      candidates: [],
      review: null,
    });
    inferenceJobs.toVisionEvent.mockResolvedValue({
      job: { id: 'job-0' },
      visionEvent: { id: 'event-0' },
      replayed: true,
    });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.create).not.toHaveBeenCalled();
    expect(inferenceJobs.fail).not.toHaveBeenCalled();
    const metadata = prisma.visionEvent.update.mock.calls[0][0].data
      .metadata as Record<string, unknown>;
    // LOW evidence quality replays the original UNKNOWN_PRODUCT verdict.
    expect(metadata.result).toBe('UNKNOWN_PRODUCT');
    expect(metadata.productId).toBeNull();
    expect(metadata.sku).toBeNull();
    // No artifacts were recorded for the attempt: ids stay null and the
    // box falls back to the full probed frame.
    expect(metadata.sourceFrameArtifactId).toBeNull();
    expect(metadata.cropArtifactId).toBeNull();
    expect(metadata.boundingBox).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
    // Provenance falls back to the matcher constants when the result
    // carried none.
    expect(metadata.modelKey).toBe(MATCHER_MODEL_KEY);
  });

  it('never forks a fresh attempt while a replayable result exists, even when repair fails', async () => {
    // A transiently failing repair (here: conversion rejected) must leave
    // the state alone for the next retry — forking would mint a second
    // event because job-0's result may already back an ingested event.
    const { service, inferenceJobs } = buildService({
      existingJob: {
        id: 'job-0',
        status: 'SUCCEEDED',
        visionEventId: null,
        result: { id: 'result-0' },
      },
    });
    inferenceJobs.toVisionEvent.mockRejectedValue(new Error('transient'));
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.create).not.toHaveBeenCalled();
    expect(inferenceJobs.complete).not.toHaveBeenCalled();
  });

  it('fails the job with CV_MODULE_DISABLED before it can become terminal', async () => {
    const { service, inferenceJobs, platformModules } = buildService();
    platformModules.isEnabledForTenant.mockResolvedValue(false);
    await service.detectForAsset(TENANT, ASSET);
    expect(platformModules.isEnabledForTenant).toHaveBeenCalledWith(
      TENANT,
      'cv',
    );
    expect(inferenceJobs.fail).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.objectContaining({ errorCode: 'CV_MODULE_DISABLED' }),
    );
    // The dependency gate runs BEFORE the terminal transition: the job
    // must never reach SUCCEEDED with conversion doomed to fail.
    expect(inferenceJobs.complete).not.toHaveBeenCalled();
    expect(inferenceJobs.toVisionEvent).not.toHaveBeenCalled();
  });

  it('fails the still-RUNNING job when completion itself is rejected', async () => {
    const { service, inferenceJobs } = buildService();
    inferenceJobs.complete.mockRejectedValue(new Error('db down'));
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.fail).toHaveBeenCalledWith(
      TENANT,
      'job-1',
      expect.objectContaining({ errorCode: 'RESULT_RECORDING_FAILED' }),
    );
    expect(inferenceJobs.toVisionEvent).not.toHaveBeenCalled();
  });

  it('leaves a post-completion conversion failure retryable, never failing the terminal job', async () => {
    const { service, inferenceJobs, prisma } = buildService();
    inferenceJobs.toVisionEvent.mockRejectedValue(new Error('transient'));
    await service.detectForAsset(TENANT, ASSET);
    // The job is terminal — failJob would be a guaranteed conflict, so it
    // is never attempted; no metadata lands either. Recovery is the
    // in-place repair path proven above (SUCCEEDED with a surviving
    // result), never a fresh attempt.
    expect(inferenceJobs.fail).not.toHaveBeenCalled();
    expect(prisma.visionEvent.update).not.toHaveBeenCalled();
  });

  it('sweeps expired leases and resumes a reclaimed QUEUED attempt in-process', async () => {
    // Finding: a crash mid-run leaves the job RUNNING with an expired
    // lease, and nothing on the pickup path ever reclaimed or resumed it —
    // the asset was undetectable forever. The non-terminal branch must
    // sweep (same call start() makes) and RESUME the reclaimed attempt.
    const { service, inferenceJobs, prisma } = buildService();
    prisma.inferenceJob.findFirst
      .mockResolvedValueOnce({
        id: 'job-0',
        status: 'RUNNING',
        visionEventId: null,
      })
      .mockResolvedValue({
        id: 'job-0',
        status: 'QUEUED',
        visionEventId: null,
      });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.reclaimExpired).toHaveBeenCalledWith(TENANT);
    // The SAME job is resumed (start()'s CAS makes this race-safe) —
    // never forked into a fresh attempt.
    expect(inferenceJobs.create).not.toHaveBeenCalled();
    expect(inferenceJobs.start).toHaveBeenCalledWith(TENANT, 'job-0', {
      adapterKey: 'pickup-classical-v1',
    });
    expect(inferenceJobs.complete).toHaveBeenCalledWith(
      TENANT,
      'job-0',
      expect.anything(),
    );
  });

  it('reports a live RUNNING attempt after the sweep without resuming or forking it', async () => {
    // A lease still within budget means the attempt is genuinely in
    // flight: the sweep leaves it RUNNING, and the state is reported
    // untouched.
    const { service, inferenceJobs } = buildService({
      existingJob: { id: 'job-0', status: 'RUNNING', visionEventId: null },
    });
    await service.detectForAsset(TENANT, ASSET);
    expect(inferenceJobs.reclaimExpired).toHaveBeenCalledWith(TENANT);
    expect(inferenceJobs.start).not.toHaveBeenCalled();
    expect(inferenceJobs.create).not.toHaveBeenCalled();
  });

  it('derives the shared source id from the asset id', () => {
    expect(pickupSourceId('abc')).toBe('pickup:abc');
  });
});
