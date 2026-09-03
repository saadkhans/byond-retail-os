import type {
  LocalDetectorRuntimePort,
  LocalDetectorStatus,
} from '../local-vision-runtime/local-vision-runtime.port';
import {
  SafeFusionSummary,
} from '../one-sku-bootstrap/one-sku-bootstrap.report';
import { normalizeDetectorResult } from './pretrained-vision.detector-normalization';
import {
  DetectionLabel,
  EmbeddingCandidate,
  PretrainedProviderCode,
  ProviderAvailability,
  ProviderEvidence,
  ProviderKind,
  ProviderStatus,
  buildInteractionFeatures,
  sanitizeProviderEvidence,
  sanitizeProviderRuntime,
  seededRandom,
} from './pretrained-vision.types';

/**
 * Phase 19/20 adapters. LOCAL-ONLY by construction: no adapter in THIS
 * module opens a socket, spawns a process, or reads a file — the
 * classical adapter derives normalized evidence from the
 * ALREADY-PERSISTED classical fusion run, and the optional pretrained
 * slots (Ultralytics-YOLO-class detection, MediaPipe-class hand
 * signals, DINOv2/CLIP-class embedding retrieval) either report
 * UNAVAILABLE until their local runtimes are installed, run in lab STUB
 * mode (deterministic SYNTHETIC evidence), or — for the detector slot —
 * delegate to the LOCAL detector runtime PORT bound by the
 * local-vision-runtime module (the only thing that ever touches a model
 * file or a worker process, in its own guarded module). Every output
 * leaves through sanitizeProviderEvidence (allowlist rebuild).
 */

export interface AdapterAnalysisContext {
  tenantId: string;
  videoAssetId: string;
  /** Safe classical summary of the clip's latest fusion run (allowlist
   *  extraction — no raw OCR/barcode/paths by construction). */
  classical: SafeFusionSummary | null;
  analysisDims: { width: number; height: number } | null;
  /** Tenant reference library (products with reference images) — the
   *  ONLY candidate space the embedding stub may rank. */
  referenceSkus: { productId: string; sku: string }[];
}

export interface VisionProviderAdapter {
  readonly provider: PretrainedProviderCode;
  readonly kind: ProviderKind;
  /** Sync for pure adapters; a runtime-backed adapter probes its local
   *  runtime, so the service always awaits. */
  status(): Promise<ProviderStatus> | ProviderStatus;
  /** Returns SANITIZED evidence; unavailable adapters return an
   *  UNAVAILABLE/DISABLED envelope instead of throwing — a missing
   *  provider must never fail the pipeline. */
  analyze(ctx: AdapterAnalysisContext): Promise<ProviderEvidence> | ProviderEvidence;
}

function unavailableEvidence(
  provider: PretrainedProviderCode,
  availability: ProviderAvailability,
  reasonCode: string,
): ProviderEvidence {
  return sanitizeProviderEvidence({
    provider,
    availability,
    reasonCode,
    synthetic: false,
    notes: [reasonCode],
  });
}

/** Box in the FULL analysis frame → normalized 0..1. */
function normalizeBox(
  box: { x: number; y: number; width: number; height: number },
  dims: { width: number; height: number } | null,
) {
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return null;
  }
  return {
    x: box.x / dims.width,
    y: box.y / dims.height,
    width: box.width / dims.width,
    height: box.height / dims.height,
  };
}

// ------------------------------------------------------------ classical

/** The ALWAYS-READY fallback: normalizes the persisted classical fusion
 *  evidence into the provider schema so every comparison has a
 *  baseline. Never disabled, never unavailable. */
export class ClassicalVisionAdapter implements VisionProviderAdapter {
  readonly provider = 'CLASSICAL' as const;
  readonly kind = 'CLASSICAL' as const;

  status(): ProviderStatus {
    return {
      provider: this.provider,
      kind: this.kind,
      availability: 'READY',
      reasonCode: null,
      stubMode: false,
      runtime: null,
    };
  }

  analyze(ctx: AdapterAnalysisContext): ProviderEvidence {
    const classical = ctx.classical;
    if (!classical) {
      return unavailableEvidence(
        this.provider,
        'READY',
        'NO_FUSION_RUN_FOR_CLIP',
      );
    }
    const crop = classical.selectedCrop;
    const normalized =
      crop !== null ? normalizeBox(crop.box, ctx.analysisDims) : null;
    const detections =
      crop !== null && normalized !== null
        ? [
            {
              label: 'PRODUCT' as const,
              timestampMs: crop.timestampMs,
              box: normalized,
              confidence: classical.topScore ?? 0,
              quality: {
                sharpness: crop.sharpness,
                occlusion: crop.occlusion,
                brightness: crop.brightness,
              },
            },
          ]
        : [];
    const embeddingCandidates: EmbeddingCandidate[] =
      classical.topSku !== null
        ? [
            {
              sku: classical.topSku,
              productId: null,
              similarity: classical.topScore ?? 0,
            },
          ]
        : [];
    const detectedKind = classical.detectedKind;
    const features = buildInteractionFeatures({
      detections,
      handSignal: null,
      cropQuality: {
        pre: null,
        peak: crop !== null && crop.qualityKnown ? 1 : null,
        post: null,
        occlusion: crop?.occlusion ?? null,
        sharpness: crop?.sharpness ?? null,
        brightness: crop?.brightness ?? null,
      },
      objectDisappeared: detectedKind === 'PICKUP' ? true : null,
      objectAppeared: detectedKind === 'RETURN' ? true : null,
      topSkuCandidates: embeddingCandidates,
    });
    // The classical detector decides the action directly from its event
    // window — mirror it instead of the hand heuristic.
    features.actionCandidate =
      detectedKind === 'PICKUP'
        ? 'PICKUP'
        : detectedKind === 'RETURN'
          ? 'RETURN'
          : 'UNKNOWN';
    return sanitizeProviderEvidence({
      provider: this.provider,
      availability: 'READY',
      reasonCode: null,
      synthetic: false,
      detections,
      handSignal: null,
      embeddingCandidates,
      features,
      notes: detections.length ? ['PRODUCT_DETECTED'] : ['NO_PRODUCT_FRAME'],
    });
  }
}

// ------------------------------------------------------- optional slots

abstract class OptionalLocalAdapter implements VisionProviderAdapter {
  abstract readonly provider: PretrainedProviderCode;
  abstract readonly kind: ProviderKind;

  constructor(
    protected readonly enabled: boolean,
    protected readonly stubMode: boolean,
  ) {}

  status(): Promise<ProviderStatus> | ProviderStatus {
    return this.slotStatus();
  }

  /** DISABLED / stub-READY / UNAVAILABLE — the pure slot status without
   *  any runtime involvement. */
  protected slotStatus(): ProviderStatus {
    return {
      provider: this.provider,
      kind: this.kind,
      availability: !this.enabled
        ? 'DISABLED'
        : this.stubMode
          ? 'READY'
          : 'UNAVAILABLE',
      reasonCode: !this.enabled
        ? 'PROVIDER_NOT_ENABLED'
        : this.stubMode
          ? null
          : 'LOCAL_RUNTIME_NOT_INSTALLED',
      stubMode: this.enabled && this.stubMode,
      runtime: null,
    };
  }

  analyze(ctx: AdapterAnalysisContext): Promise<ProviderEvidence> | ProviderEvidence {
    return this.analyzeSlot(ctx);
  }

  protected analyzeSlot(ctx: AdapterAnalysisContext): ProviderEvidence {
    const status = this.slotStatus();
    if (status.availability !== 'READY') {
      return unavailableEvidence(
        this.provider,
        status.availability,
        status.reasonCode ?? 'PROVIDER_NOT_ENABLED',
      );
    }
    return this.analyzeStub(ctx);
  }

  protected abstract analyzeStub(ctx: AdapterAnalysisContext): ProviderEvidence;
}

/**
 * Ultralytics-YOLO-class object/product detection slot.
 *
 * Precedence: DISABLED (not enabled) > lab STUB (deterministic
 * synthetic boxes) > REAL local runtime (the LOCAL_DETECTOR_RUNTIME
 * port, when bound and READY) > UNAVAILABLE (no runtime bound, or the
 * runtime reports a classified reason: model not configured/found,
 * runtime not installed, probe failed, ...). The real path is
 * NON-AUTHORITATIVE: its evidence is one more row in the comparison and
 * the service forces review on every real contribution.
 */
export class YoloVisionAdapter extends OptionalLocalAdapter {
  readonly provider = 'YOLO_LOCAL' as const;
  readonly kind = 'DETECTOR' as const;

  constructor(
    enabled: boolean,
    stubMode: boolean,
    private readonly runtime: LocalDetectorRuntimePort | null = null,
  ) {
    super(enabled, stubMode);
  }

  private realRuntime(): LocalDetectorRuntimePort | null {
    return this.enabled && !this.stubMode ? this.runtime : null;
  }

  private runtimeStatusToProvider(status: LocalDetectorStatus): ProviderStatus {
    const ready = status.availability === 'READY';
    return {
      provider: this.provider,
      kind: this.kind,
      availability: status.availability,
      reasonCode: ready
        ? null
        : (status.reasonCode ?? 'LOCAL_RUNTIME_NOT_INSTALLED'),
      stubMode: false,
      runtime:
        ready && status.model
          ? sanitizeProviderRuntime({
              modelId: status.model.modelId,
              runtimeKind: status.model.runtime,
              format: status.model.format,
              version: status.model.version,
              device: status.device,
            })
          : null,
    };
  }

  override status(): Promise<ProviderStatus> | ProviderStatus {
    const runtime = this.realRuntime();
    if (runtime === null) {
      return this.slotStatus();
    }
    return runtime.status().then(
      (status) => this.runtimeStatusToProvider(status),
      // A probe that throws is a probe that failed — classified, never
      // its message.
      (): ProviderStatus => ({
        provider: this.provider,
        kind: this.kind,
        availability: 'UNAVAILABLE',
        reasonCode: 'LOCAL_RUNTIME_PROBE_FAILED',
        stubMode: false,
        runtime: null,
      }),
    );
  }

  override analyze(
    ctx: AdapterAnalysisContext,
  ): Promise<ProviderEvidence> | ProviderEvidence {
    const runtime = this.realRuntime();
    if (runtime === null) {
      return this.analyzeSlot(ctx);
    }
    return this.analyzeWithRuntime(ctx, runtime);
  }

  private async analyzeWithRuntime(
    ctx: AdapterAnalysisContext,
    runtime: LocalDetectorRuntimePort,
  ): Promise<ProviderEvidence> {
    const result = await runtime.detect({
      tenantId: ctx.tenantId,
      videoAssetId: ctx.videoAssetId,
    });
    if (result.status !== 'OK') {
      // UNAVAILABLE and FAILED both degrade to a classified envelope —
      // the classical fallback carries the evaluation.
      const reasonCode =
        result.reasonCode ??
        (result.status === 'FAILED'
          ? 'INFERENCE_FAILED'
          : 'LOCAL_RUNTIME_NOT_INSTALLED');
      return sanitizeProviderEvidence({
        provider: this.provider,
        availability: 'UNAVAILABLE',
        reasonCode,
        synthetic: false,
        notes: [
          reasonCode,
          result.status === 'FAILED' ? 'RUNTIME_RUN_FAILED' : 'RUNTIME_UNAVAILABLE',
        ],
      });
    }
    const crop = ctx.classical?.selectedCrop ?? null;
    const cropQuality = {
      sharpness: crop?.sharpness ?? null,
      occlusion: crop?.occlusion ?? null,
      brightness: crop?.brightness ?? null,
    };
    const normalized = normalizeDetectorResult(result, cropQuality);
    const features = buildInteractionFeatures({
      detections: normalized.detections,
      handSignal: normalized.handSignal,
      cropQuality: {
        pre: null,
        peak: crop !== null && crop.qualityKnown ? 1 : null,
        post: null,
        occlusion: cropQuality.occlusion,
        sharpness: cropQuality.sharpness,
        brightness: cropQuality.brightness,
      },
      objectDisappeared: normalized.objectDisappeared,
      objectAppeared: normalized.objectAppeared,
      // Embedding retrieval is the next local provider — the detector
      // never names a SKU.
      topSkuCandidates: [],
    });
    return sanitizeProviderEvidence({
      provider: this.provider,
      availability: 'READY',
      reasonCode: null,
      synthetic: false,
      detections: normalized.detections,
      handSignal: normalized.handSignal,
      embeddingCandidates: [],
      features,
      notes: normalized.notes,
    });
  }

  protected analyzeStub(ctx: AdapterAnalysisContext): ProviderEvidence {
    const rand = seededRandom(`yolo:${ctx.videoAssetId}`);
    const baseX = 0.2 + rand() * 0.4;
    const baseY = 0.2 + rand() * 0.4;
    const drift = 0.05 + rand() * 0.15;
    const detections = [800, 1500, 2200].map((timestampMs, index) => ({
      label: (index === 1
        ? 'PRODUCT_IN_HAND'
        : 'PRODUCT') as DetectionLabel,
      timestampMs,
      box: {
        x: Math.min(0.8, baseX + drift * index),
        y: Math.min(0.8, baseY + drift * index * 0.5),
        width: 0.15 + rand() * 0.1,
        height: 0.2 + rand() * 0.1,
      },
      confidence: 0.55 + rand() * 0.4,
      quality: {
        sharpness: 10 + rand() * 20,
        occlusion: rand() * 0.4,
        brightness: 90 + rand() * 60,
      },
    }));
    const objectDisappeared = rand() > 0.5;
    const features = buildInteractionFeatures({
      detections,
      handSignal: null,
      cropQuality: {
        pre: 0.4,
        peak: 0.8,
        post: 0.5,
        occlusion: detections[1].quality.occlusion,
        sharpness: detections[1].quality.sharpness,
        brightness: detections[1].quality.brightness,
      },
      objectDisappeared,
      objectAppeared: !objectDisappeared,
      topSkuCandidates: [],
    });
    return sanitizeProviderEvidence({
      provider: this.provider,
      availability: 'READY',
      reasonCode: null,
      synthetic: true,
      detections,
      features,
      notes: ['STUB_SYNTHETIC_OUTPUT', 'PRODUCT_DETECTED'],
    });
  }
}

/** MediaPipe-Hands-class hand presence/proximity slot. */
export class HandSignalAdapter extends OptionalLocalAdapter {
  readonly provider = 'HAND_SIGNAL_LOCAL' as const;
  readonly kind = 'HAND' as const;

  protected analyzeStub(ctx: AdapterAnalysisContext): ProviderEvidence {
    const rand = seededRandom(`hand:${ctx.videoAssetId}`);
    const entered = Math.round(400 + rand() * 400);
    const contactStart = entered + Math.round(200 + rand() * 300);
    const contactEnd = contactStart + Math.round(400 + rand() * 800);
    const left = contactEnd + Math.round(200 + rand() * 400);
    return sanitizeProviderEvidence({
      provider: this.provider,
      availability: 'READY',
      reasonCode: null,
      synthetic: true,
      detections: [
        {
          label: 'HAND',
          timestampMs: contactStart,
          box: {
            x: 0.3 + rand() * 0.2,
            y: 0.3 + rand() * 0.2,
            width: 0.12,
            height: 0.12,
          },
          confidence: 0.6 + rand() * 0.35,
          quality: null,
        },
      ],
      handSignal: {
        handPresent: true,
        nearShelfZone: true,
        enteredZoneAtMs: entered,
        contactStartMs: contactStart,
        contactEndMs: contactEnd,
        leftZoneAtMs: left,
        contactDurationMs: contactEnd - contactStart,
      },
      notes: ['STUB_SYNTHETIC_OUTPUT', 'HAND_NEAR_SHELF_ZONE'],
    });
  }
}

/** DINOv2/CLIP/SigLIP-class SKU crop-embedding retrieval slot (FAISS or
 *  a simple local NN index later). The stub ranks ONLY the tenant's own
 *  reference library — candidates can never leave that scope. */
export class EmbeddingRetrievalAdapter extends OptionalLocalAdapter {
  readonly provider = 'EMBEDDING_LOCAL' as const;
  readonly kind = 'EMBEDDING' as const;

  protected analyzeStub(ctx: AdapterAnalysisContext): ProviderEvidence {
    if (ctx.referenceSkus.length === 0) {
      return unavailableEvidence(
        this.provider,
        'READY',
        'NO_REFERENCE_LIBRARY',
      );
    }
    const candidates = ctx.referenceSkus
      .map((row) => {
        const rand = seededRandom(
          `embed:${ctx.videoAssetId}:${row.productId}`,
        );
        return {
          sku: row.sku,
          productId: row.productId,
          similarity: 0.35 + rand() * 0.6,
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
    return sanitizeProviderEvidence({
      provider: this.provider,
      availability: 'READY',
      reasonCode: null,
      synthetic: true,
      embeddingCandidates: candidates,
      notes: ['STUB_SYNTHETIC_OUTPUT'],
    });
  }
}
