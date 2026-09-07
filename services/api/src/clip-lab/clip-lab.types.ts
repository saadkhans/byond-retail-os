/**
 * Phase 22 — Clip Lab: ONE consolidated, shadow-only report for a test
 * clip. Everything here is classified codes, SKUs, and normalized
 * numbers assembled from the existing stages (screening status, v1
 * detection, fusion v2, pretrained evaluation). No media, no paths, no
 * provider text. Nothing in Clip Lab mutates checkout, order, payment,
 * or inventory state — it orchestrates read-only/shadow stages.
 */

export type ClipLabStep = 'SCREENING' | 'VALIDATE' | 'DETECTION' | 'FUSION' | 'PRETRAINED';

export type ClipLabStepStatus = 'OK' | 'SKIPPED' | 'FAILED' | 'BLOCKED' | 'NOT_RUN';

export interface ClipLabStepResult {
  step: ClipLabStep;
  status: ClipLabStepStatus;
  /** Classified code only (UPPER_SNAKE) — never a message. */
  reasonCode: string | null;
  ms: number | null;
}

export interface ClipLabReport {
  asset: {
    id: string;
    name: string;
    status: string;
    store: { id: string; name: string; code: string } | null;
    rackCode: string | null;
    rackFrameRegion: { x: number; y: number; width: number; height: number } | null;
    groundTruth: {
      eventKind: string;
      sku: string | null;
      actualTimestampMs: number | null;
    } | null;
  };
  steps: ClipLabStepResult[];
  /** Advisory only — always review-required until gates are approved. */
  suggestion: {
    sku: string | null;
    action: string;
    reviewRequired: boolean;
    notes: string[];
  } | null;
  planogram: {
    configured: boolean;
    rackCode: string | null;
    bindingSource: string;
    cell: string | null;
    coordinateSource: string;
    matchStatus: string;
    expectedSkus: string[];
    flags: string[];
  } | null;
  candidates: {
    scoped: boolean;
    excludedProductCount: number;
    items: { sku: string; score: number }[];
  };
  providers: {
    provider: string;
    availability: string;
    reasonCode: string | null;
    modelId: string | null;
  }[];
  /** Codes explaining the outcome (labels live in the admin web). */
  why: string[];
  links: { videoAssetPage: string; pretrainedPage: string };
}
