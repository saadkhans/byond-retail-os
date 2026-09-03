import {
  SafeFusionSummary,
} from '../one-sku-bootstrap/one-sku-bootstrap.report';
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
  seededRandom,
} from './pretrained-vision.types';

/**
 * Phase 19 adapters. LOCAL-ONLY by construction: no adapter opens a
 * socket, spawns a process, or reads a file — the classical adapter
 * derives normalized evidence from the ALREADY-PERSISTED classical
 * fusion run, and the optional pretrained slots (Ultralytics-YOLO-class
 * detection, MediaPipe-class hand signals, DINOv2/CLIP-class embedding
 * retrieval) either report UNAVAILABLE until their local runtimes are
 * installed or, in lab STUB mode, emit deterministic SYNTHETIC evidence
 * so the evaluation flow can be exercised end to end. Every output
 * leaves through sanitizeProviderEvidence (allowlist rebuild).
 */

export interface AdapterAnalysisContext {
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
  status(): ProviderStatus;
  /** Returns SANITIZED evidence; unavailable adapters return an
   *  UNAVAILABLE/DISABLED envelope instead of throwing — a missing
   *  provider must never fail the pipeline. */
  analyze(ctx: AdapterAnalysisContext): ProviderEvidence;
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

  status(): ProviderStatus {
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
    };
  }

  analyze(ctx: AdapterAnalysisContext): ProviderEvidence {
    const status = this.status();
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

/** Ultralytics-YOLO-class object/product detection slot (ByteTrack /
 *  BoT-SORT tracking later). Lab stub emits deterministic synthetic
 *  boxes so comparison plumbing can be tested before the runtime lands. */
export class YoloVisionAdapter extends OptionalLocalAdapter {
  readonly provider = 'YOLO_LOCAL' as const;
  readonly kind = 'DETECTOR' as const;

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
