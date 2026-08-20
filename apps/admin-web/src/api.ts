/**
 * Minimal fetch client for the BYOND API.
 *
 * - Base URL comes from VITE_API_BASE_URL (default: local API).
 * - The access token is a Bearer header, kept in localStorage. It is never
 *   embedded in URLs and never logged.
 */
const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'
).replace(/\/+$/, '');

const TOKEN_STORAGE_KEY = 'byond.admin.accessToken';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_BASE_URL}`);
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message)
          ? body.message.join('; ')
          : body.message;
      }
    } catch {
      // Non-JSON error body — keep the status line.
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Multipart upload variant of api(): the browser sets the Content-Type
 * (with boundary) itself, so no explicit header is sent. Same Bearer token
 * and error envelope handling as api().
 *
 * `extraHeaders` exists for gates the server must evaluate BEFORE it reads
 * the body — a multipart field cannot be one, because reaching it requires
 * parsing (and buffering) the whole upload first. Optional, so existing
 * call sites are unaffected.
 */
export async function apiUpload<T>(
  path: string,
  formData: FormData,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_BASE_URL}`);
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message)
          ? body.message.join('; ')
          : body.message;
      }
    } catch {
      // Non-JSON error body — keep the status line.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

/**
 * Fetch a protected binary endpoint (media/artifact images) into an object
 * URL. The <video>/<img> tags cannot send the Bearer header themselves, so
 * bytes travel through fetch and land in a blob URL the caller must revoke
 * (URL.revokeObjectURL) when done. Returns null on any controlled refusal
 * (403/404/409) — the caller hides the surface instead of erroring.
 */
export async function apiObjectUrl(path: string): Promise<string | null> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { headers });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  return URL.createObjectURL(await response.blob());
}

/** Standard paginated list envelope used by the search endpoints. */
export interface Paginated<T> {
  items: T[];
  total: number;
  skip: number;
  take: number;
}

export interface Store {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  timezone: string;
  address: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface Unit {
  id: string;
  locationId: string;
  code: string;
  name: string;
  type: string;
  status: string;
  placement: string | null;
  createdAt: string;
  updatedAt: string;
  location?: { id: string; name: string; code: string; status: string } | null;
}

export interface Device {
  id: string;
  unitId: string;
  name: string;
  type: string;
  status: string;
  serialNumber: string;
  metadata: Record<string, unknown> | null;
  firmwareVersion: string | null;
  softwareVersion: string | null;
  lastSeenAt: string | null;
  registeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  unit?: {
    id: string;
    code: string;
    name: string;
    status: string;
    locationId: string;
  } | null;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  status: string;
  unitOfMeasure: string;
  lowStockThreshold: number | null;
  category?: { name: string } | null;
  brand?: { name: string } | null;
  barcodes?: { value: string }[];
}

export interface StockLevel {
  id: string;
  quantity: number;
  isLowStock?: boolean;
  product: { id: string; sku: string; name: string };
  location: { id: string; name: string; code: string };
}

export interface SafeUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  userType: string;
  tenantId: string | null;
}

export type CheckoutSessionStatus =
  | 'OPEN'
  | 'ACTIVE'
  | 'PENDING_REVIEW'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export type OrderStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';

export type OrderPaymentStatus =
  | 'UNPAID'
  | 'AUTHORIZED'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'VOIDED'
  | 'REFUND_PENDING'
  | 'REFUNDED';

// Phase 6 — provider-neutral payment abstraction. NO live gateway: authorize
// and capture are SIMULATED. Provider references are opaque; only SAFE card
// metadata (brand, last4, expiry, wallet) is ever stored.
export type PaymentProvider = 'SIMULATED' | 'MANUAL';

export type PaymentStatus =
  | 'CREATED'
  | 'REQUIRES_AUTHORIZATION'
  | 'AUTHORIZED'
  | 'CAPTURE_PENDING'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELLED'
  | 'VOIDED'
  | 'EXPIRED';

export type PaymentCaptureStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type PaymentEventStatus = 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';

export type PaymentEventType =
  | 'AUTHORIZATION_SUCCEEDED'
  | 'AUTHORIZATION_FAILED'
  | 'CAPTURE_SUCCEEDED'
  | 'CAPTURE_FAILED'
  | 'PAYMENT_CANCELLED'
  | 'PAYMENT_VOIDED'
  | 'PAYMENT_EXPIRED'
  | 'UNKNOWN';

export type ReconciliationStatus =
  | 'PENDING'
  | 'MATCHED'
  | 'MISMATCH'
  | 'RECONCILED'
  | 'FAILED';

export interface PaymentAuthorization {
  id: string;
  intentId: string;
  status: string;
  amountMinor: number;
  providerRef: string | null;
  authorizedAt: string;
  expiresAt: string | null;
  voidedAt: string | null;
  createdAt: string;
}

export interface PaymentCapture {
  id: string;
  intentId: string;
  status: PaymentCaptureStatus;
  amountMinor: number;
  providerRef: string | null;
  capturedAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  intent?: { id: string; status: PaymentStatus; orderId: string | null } | null;
}

export interface PaymentEvent {
  id: string;
  intentId: string | null;
  provider: PaymentProvider;
  providerEventId: string;
  eventType: PaymentEventType;
  status: PaymentEventStatus;
  providerRef: string | null;
  receivedAt: string;
  processedAt: string | null;
  createdAt: string;
  intent?: { id: string; status: PaymentStatus } | null;
}

export interface ReconciliationRecord {
  id: string;
  intentId: string | null;
  captureId: string | null;
  provider: PaymentProvider;
  status: ReconciliationStatus;
  providerRef: string | null;
  expectedAmountMinor: number | null;
  reportedAmountMinor: number | null;
  currencyCode: string | null;
  notes: string | null;
  reconciledAt: string | null;
  createdAt: string;
  intent?: {
    id: string;
    status: PaymentStatus;
    provider: PaymentProvider;
    orderId: string | null;
  } | null;
}

export interface PaymentIntent {
  id: string;
  orderId: string | null;
  checkoutSessionId: string | null;
  provider: PaymentProvider;
  status: PaymentStatus;
  amountMinor: number;
  currencyCode: string;
  capturedAmountMinor: number;
  providerRef: string | null;
  providerCustomerRef: string | null;
  // SAFE card metadata only — never a raw PAN/CVV/PIN/token.
  instrumentBrand: string | null;
  instrumentLast4: string | null;
  instrumentExpiryMonth: number | null;
  instrumentExpiryYear: number | null;
  instrumentWallet: string | null;
  description: string | null;
  failureReason: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  cancelledAt: string | null;
  failedAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  order?: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    paymentStatus: OrderPaymentStatus;
  } | null;
  session?: { id: string; status: CheckoutSessionStatus } | null;
  authorizations?: PaymentAuthorization[];
  captures?: PaymentCapture[];
  events?: PaymentEvent[];
  // Reconciliation records are NOT embedded here — they require the separate
  // reconciliation:read permission (GET /reconciliation/records?intentId=…).
}

/**
 * Vendor-neutral evidence/source lineage placeholders. Future CV/VLM adapters
 * populate these; the admin UI only displays the raw identifiers.
 */
export interface EvidenceRefs {
  sourceType: string;
  sourceId: string | null;
  evidenceBundleId: string | null;
  visionEventId: string | null;
  vlmReviewId: string | null;
  evidenceScore: number | null;
  evidenceQuality: string | null;
  reasonCodes: string[];
}

export interface CheckoutSessionLine extends EvidenceRefs {
  id: string;
  sessionId: string;
  productId: string;
  sku: string;
  productName: string;
  unitOfMeasure: string;
  quantity: number;
  // Pricing placeholders — always null until a later pricing/payment phase.
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  currencyCode: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckoutSession extends EvidenceRefs {
  id: string;
  locationId: string;
  unitId: string;
  deviceId: string | null;
  status: CheckoutSessionStatus;
  startedAt: string;
  endedAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: CheckoutSessionLine[];
  order?: { id: string; orderNumber: string; status: OrderStatus } | null;
}

export interface OrderLine extends EvidenceRefs {
  id: string;
  orderId: string;
  productId: string;
  sessionLineId: string | null;
  sku: string;
  productName: string;
  unitOfMeasure: string;
  quantity: number;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  currencyCode: string | null;
  createdAt: string;
}

export type VisionEventType =
  | 'PRODUCT_PICKUP'
  | 'PRODUCT_RETURN'
  | 'PRODUCT_TRANSFER'
  | 'CART_INSERTION'
  | 'EXIT_RECONCILIATION';

export type VisionEventStatus =
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'OVERRIDDEN';

export interface VisionEventCandidate {
  id: string;
  eventId: string;
  productId: string;
  rank: number;
  score: number | null;
  label: string | null;
  sku: string;
  productName: string;
  createdAt: string;
}

export interface VisionEventReview {
  id: string;
  eventId: string;
  decision: 'APPROVE' | 'REJECT' | 'OVERRIDE';
  reason: string | null;
  appliedProductId: string | null;
  appliedQuantity: number | null;
  basketEffect:
    | 'LINE_ADDED'
    | 'LINE_INCREASED'
    | 'LINE_DECREASED'
    | 'LINE_REMOVED'
    | 'NONE';
  sessionLineId: string | null;
  reviewedById: string | null;
  createdAt: string;
}

/** Evidence METADATA only — artifact descriptors, never binary media. */
export interface EvidenceBundle {
  id: string;
  sourceType: string;
  sourceId: string | null;
  modelName: string | null;
  modelVersion: string | null;
  captureStartedAt: string | null;
  captureEndedAt: string | null;
  artifacts: Record<string, unknown>[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface VisionEvent {
  id: string;
  locationId: string;
  unitId: string;
  deviceId: string | null;
  sessionId: string | null;
  type: VisionEventType;
  status: VisionEventStatus;
  quantity: number;
  occurredAt: string;
  ingestedAt: string;
  sourceType: string;
  sourceId: string | null;
  modelName: string | null;
  modelVersion: string | null;
  evidenceBundleId: string | null;
  evidenceScore: number | null;
  evidenceQuality: string | null;
  reasonCodes: string[];
  // Detail-only: list rows exclude the free-form metadata to keep pages light.
  metadata?: Record<string, unknown> | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  location?: { id: string; name: string; code: string } | null;
  unit?: { id: string; name: string; code: string } | null;
  device?: { id: string; name: string; serialNumber: string } | null;
  session?: { id: string; status: CheckoutSessionStatus } | null;
  candidates?: VisionEventCandidate[];
  review?: VisionEventReview | null;
  evidenceBundle?: EvidenceBundle | null;
}

// Phase 9 — provider-neutral CV inference jobs. No real ML runs here: jobs
// are simulated via the admin UI, and successful results convert into
// Phase 7 vision events. Only safe descriptors — never raw media.
export type InferenceJobType =
  | 'TRACKING_EVENT'
  | 'SHELF_AUDIT'
  | 'PRODUCT_RECOGNITION'
  | 'OCR_REVIEW'
  | 'VLM_REVIEW'
  | 'EXIT_RECONCILIATION';

export type InferenceJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export interface InferenceCandidate {
  id: string;
  rank: number;
  sku: string;
  label: string | null;
  score: number;
}

export interface InferenceResult {
  id: string;
  eventType: VisionEventType;
  quantityDelta: number;
  occurredAt: string;
  evidenceScore: number | null;
  evidenceQuality: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  modelKey: string | null;
  modelVersion: string | null;
  candidates: InferenceCandidate[];
  createdAt: string;
}

export interface InferenceJob {
  id: string;
  jobType: InferenceJobType;
  status: InferenceJobStatus;
  priority: number;
  requestedAt: string;
  attempts: number;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  locationId: string | null;
  unitId: string | null;
  deviceId: string | null;
  sessionId: string | null;
  sourceType: string;
  sourceId: string | null;
  adapterKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  visionEventId: string | null;
  createdAt: string;
  updatedAt: string;
  result?: InferenceResult | null;
}

export interface Order extends EvidenceRefs {
  id: string;
  orderNumber: string;
  checkoutSessionId: string;
  locationId: string;
  unitId: string;
  status: OrderStatus;
  // Phase 6 — payment projection. UNPAID until a linked payment intent is
  // CAPTURED; paidAt is set exactly when paymentStatus becomes PAID.
  paymentStatus: OrderPaymentStatus;
  paidAt: string | null;
  placedAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  totalQuantity: number;
  // Pricing placeholders — always null in this phase; nothing here implies payment.
  subtotalMinor: number | null;
  totalMinor: number | null;
  currencyCode: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: OrderLine[];
}

// Phase 10 — controlled test-video ingestion & crop extraction. Rows are
// METADATA + internal references only: there is deliberately NO storageKey,
// download URL, or media byte field anywhere in these shapes — the API
// never exposes storage locations, and crops feed Phase 9 inference jobs
// by opaque id.
export type VideoAssetStatus =
  | 'PENDING_MEDIA'
  | 'QUARANTINED'
  | 'UPLOADED'
  | 'VALIDATED'
  | 'REJECTED'
  | 'PROCESSING'
  | 'READY'
  | 'FAILED';

export type VideoArtifactType = 'FRAME' | 'CROP';

export type VideoCropReason =
  | 'PRODUCT_PICKUP'
  | 'PRODUCT_RETURN'
  | 'SHELF_AUDIT'
  | 'CART_INSERTION'
  | 'OCR_REVIEW'
  | 'VLM_REVIEW';

export interface VideoAsset {
  id: string;
  tenantId: string;
  locationId: string | null;
  unitId: string | null;
  deviceId: string | null;
  sessionId: string | null;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  status: VideoAssetStatus;
  checksumSha256: string;
  errorCode: string | null;
  errorMessage: string | null;
  uploadedById: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  location?: { id: string; name: string; code: string } | null;
  unit?: { id: string; name: string; code: string } | null;
  session?: { id: string; status: CheckoutSessionStatus } | null;
}

// Quarantine screening preview — the ONE deliberate exception to the
// "no media byte field" note above: sample frames of a QUARANTINED upload,
// extracted in memory and served base64 to `video-asset:screen` holders so
// the screening decision is an informed inspection. Frames are never
// persisted server-side, every serve is audited, and the video container /
// original bytes remain non-downloadable.
export interface ScreeningPreviewFrame {
  timestampMs: number;
  width: number;
  height: number;
  mimeType: string;
  imageBase64: string;
}

export interface ScreeningPreview {
  assetId: string;
  status: VideoAssetStatus;
  durationMs: number;
  frames: ScreeningPreviewFrame[];
  skippedOverBudget: number;
}

export interface VideoArtifact {
  id: string;
  tenantId: string;
  videoAssetId: string;
  artifactType: VideoArtifactType;
  reason: VideoCropReason | null;
  timestampMs: number;
  cropX: number | null;
  cropY: number | null;
  cropWidth: number | null;
  cropHeight: number | null;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  inferenceJobId: string | null;
  createdById: string | null;
  createdAt: string;
}

// Phase 10 validation — API-managed reference library + ground truth.
export interface ReferenceImageView {
  id: string;
  productId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: string;
}

export interface ReferenceLibraryStatus {
  productId: string;
  sku: string;
  name: string;
  barcodes: string[];
  referenceCount: number;
  minRequired: number;
  inferenceReady: boolean;
  embeddingCount: number;
  embeddingModelKey: string;
  embeddingModelVersion: string;
  images: ReferenceImageView[];
}

export interface ReferenceOverviewRow {
  productId: string;
  sku: string;
  name: string;
  referenceCount: number;
  embeddingCount: number;
  inferenceReady: boolean;
}

export interface ImportPreviewProduct {
  sku: string;
  productId: string;
  name: string;
  existingImages: number;
  newImages: number;
  duplicatesInZip: number;
  alreadyStored: number;
  projectedImages: number;
  projectedInferenceReady: boolean;
  belowMinimumAfterImport: boolean;
  fileCount: number;
}

export interface ImportPreview {
  matched: ImportPreviewProduct[];
  unknownSkus: { sku: string; fileCount: number }[];
  rejected: { path: string; reason: string }[];
  totals: { files: number; importable: number; rejected: number };
  minRequired: number;
}

export interface ImportReport {
  productsImported: number;
  imagesAccepted: number;
  imagesRejected: number;
  rejections: { path: string; reason: string }[];
  productsNowInferenceReady: { sku: string; productId: string; images: number }[];
  perProduct: {
    sku: string;
    productId: string;
    accepted: number;
    rejected: number;
    totalImages: number;
    inferenceReady: boolean;
  }[];
}

export type GroundTruthEventKind = 'PICKUP' | 'RETURN' | 'NONE';

// Phase 11 — which controlled test scenario a ground-truthed clip
// exercises (the evaluation dashboard breaks accuracy down per scenario).
export type CvTestScenario =
  | 'PICKUP_SINGLE'
  | 'RETURN_SINGLE'
  | 'FALSE_TOUCH'
  | 'TWO_SIMILAR_PICK_ONE'
  | 'TWO_VISIBLE_PICK_ONE'
  | 'VLM_UNAVAILABLE'
  | 'VLM_INVALID_SKU';

export interface GroundTruthView {
  videoAssetId: string;
  eventKind: GroundTruthEventKind;
  testType: CvTestScenario | null;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  actualTimestampMs: number | null;
  quantity: number;
  note: string | null;
  updatedAt: string;
}

export type ValidationOutcome =
  | 'correct'
  | 'incorrect'
  | 'quantity_mismatch'
  | 'missed'
  | 'false_pickup'
  | 'true_negative'
  | 'not_detected'
  | 'unscored';

export interface ValidationRow {
  videoAssetId: string;
  originalFilename: string;
  reviewedAt: string;
  actualSku: string | null;
  actualEventKind: GroundTruthEventKind;
  actualTimestampMs: number | null;
  predictedSku: string | null;
  groundTruthQuantity: number;
  predictedQuantity: number | null;
  matchScore: number | null;
  timestampErrorMs: number | null;
  outcome: ValidationOutcome;
  topCandidates: { sku: string; score: number | null }[];
  processingMs: number | null;
  jobStatus: InferenceJobStatus | null;
  jobErrorCode: string | null;
  fusionTopSku: string | null;
  fusionTopScore: number | null;
  fusionPolicy: string | null;
  fusionVerdict:
    | 'correct'
    | 'incorrect'
    | 'missed'
    | 'false_pickup'
    | 'true_negative'
    | 'unscored'
    | null;
}

export interface ValidationSummary {
  rows: ValidationRow[];
  totals: {
    reviewed: number;
    correct: number;
    incorrect: number;
    missed: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    notDetected: number;
    unscored: number;
  };
  confusionMatrix: {
    minReviewed: number;
    reviewedCount: number;
    unlocked: boolean;
    skus: string[];
    matrix: number[][] | null;
  };
}

// Phase 10 MVP — automatic product-pickup detection. Server-computed safe
// descriptors only: numbers, enum strings, and opaque artifact ids.
export interface PickupDetectionRecord {
  version: 1;
  kind: 'PRODUCT_PICKUP_DETECTION';
  result: 'PRODUCT_MATCHED' | 'UNKNOWN_PRODUCT';
  confidence: number;
  eventStartMs: number;
  eventPeakMs: number;
  eventEndMs: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  sourceFrameArtifactId: string | null;
  cropArtifactId: string | null;
  productId: string | null;
  sku: string | null;
  analysisFps: number;
  modelKey: string;
  modelVersion: string;
  processingMs?: number;
}

export interface PickupDetectionState {
  enabled: boolean;
  job: {
    id: string;
    status: InferenceJobStatus;
    attempts: number;
    adapterKey: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
  detection:
    | (PickupDetectionRecord & {
        visionEventId: string;
        visionEventStatus: VisionEventStatus;
        productName: string | null;
        candidates: {
          productId: string;
          sku: string;
          productName: string;
          score: number | null;
          rank: number;
        }[];
        review: {
          decision: string;
          appliedProductId: string | null;
          reason: string | null;
          createdAt: string;
        } | null;
      })
    | null;
}

// Local VLM readiness (pickup-fusion ops).
export interface VlmReadiness {
  enabled: boolean;
  provider: string;
  mode: string;
  timeoutMs: number;
  model: string | null;
  baseUrl: string | null;
  serverReachable: boolean;
  modelAvailable: boolean;
  availableModels: string[];
  /** READY = model installed; PROVIDER_UNREACHABLE / MODEL_NOT_FOUND
   *  name the exact readiness failure. Installed ≠ warm: first inference
   *  may still be slow. */
  classification: 'READY' | 'MODEL_NOT_FOUND' | 'PROVIDER_UNREACHABLE';
  /** Outcome of the most recent verify() this API process ran — the
   *  honest warm-up signal (null until a generation was attempted). */
  lastInference: { status: string; latencyMs: number | null; at: string } | null;
  ready: boolean;
}

// Customer journey skeleton (shadow mode).
export type JourneyEventType =
  | 'ENTRY'
  | 'EXIT'
  | 'SHELF_INTERACTION'
  | 'PRODUCT_PICKUP'
  | 'PRODUCT_RETURN'
  | 'REVIEW_REQUIRED';

// Phase 11 — final SHADOW decision of an exited journey (recorded
// conclusion only; never triggers checkout/order/payment writes).
export type JourneyDecision =
  | 'READY_TO_SETTLE_SHADOW'
  | 'NEEDS_EVENT_REVIEW'
  | 'NEEDS_JOURNEY_REVIEW'
  | 'FAILED';

export type JourneyReviewDecision = 'APPROVE' | 'REJECT' | 'CORRECT';

/** One append-only reviewer decision over one journey observation. */
export interface JourneyEventReview {
  id: string;
  decision: JourneyReviewDecision;
  correctedEventType: JourneyEventType | null;
  correctedProductId: string | null;
  correctedSku: string | null;
  correctedProductName: string | null;
  correctedQuantity: number | null;
  reason: string | null;
  reviewedById: string | null;
  createdAt: string;
}

/** Safe summary of an imported fusion run (descriptor fields only). */
export interface JourneyFusionRunSummary {
  runId: string;
  videoAssetId: string;
  pipelineVersion: string;
  policy: string;
  fusedTopSku: string | null;
  /** Uncalibrated ranking score, not a probability. */
  fusedTopScore: number | null;
  createdAt: string;
  vlm: {
    invoked: boolean;
    status: string | null;
    verdict: string | null;
    selectedSku: string | null;
    requiresHumanReview: boolean;
    reasonCodes: string[];
    contradictions: string[];
  } | null;
}

export interface JourneySummary {
  id: string;
  locationId: string;
  unitId: string | null;
  status: string;
  decision: JourneyDecision | null;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
}

export interface JourneyDetail {
  id: string;
  locationId: string;
  unitId: string | null;
  status: string;
  decision: JourneyDecision | null;
  decisionReason: string | null;
  decidedAt: string | null;
  startedAt: string;
  endedAt: string | null;
  events: {
    id: string;
    eventType: JourneyEventType;
    occurredAt: string;
    productId: string | null;
    sku: string | null;
    productName: string | null;
    quantity: number;
    matchScore: number | null;
    sourceType: string;
    videoAssetId: string | null;
    fusionRunId: string | null;
    note: string | null;
    reviews: JourneyEventReview[];
  }[];
  basket: { productId: string | null; sku: string | null; productName: string | null; quantity: number }[];
  issues: { kind: string; detail: string; eventId?: string }[];
  fusionRuns: JourneyFusionRunSummary[];
}

// Phase 11 — CV evaluation dashboard (read-only; only ground-truthed
// clips are scored, and fused scores are uncalibrated ranking scores).
export interface RateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface EvaluationSummary {
  totals: {
    groundTruthedClips: number;
    clipsWithRun: number;
    clipsWithoutRun: number;
  };
  pickupAccuracy: RateMetric;
  returnAccuracy: RateMetric;
  falseTouchRejection: RateMetric;
  skuTop1Accuracy: RateMetric;
  skuTop3Accuracy: RateMetric;
  vlmAgreement: {
    agree: number;
    disagree: number;
    /** Answered MATCH verdicts only (agree + disagree); abstentions
     *  (AMBIGUOUS/UNKNOWN/INVALID_INPUT) are reported separately and never
     *  dilute the agreement denominator. */
    vlmAnsweredCount: number;
    vlmAbstentionCount: number;
    vlmAgreementRate: number | null;
    vlmAbstentionRate: number | null;
  };
  humanReviewRate: RateMetric;
  basketExactMatchRate: RateMetric;
  latency: { stage: string; medianMs: number; samples: number }[];
  perSku: {
    sku: string;
    clips: number;
    top1Correct: number;
    top1Rate: number | null;
  }[];
  perTestType: {
    testType: CvTestScenario | 'UNLABELED';
    clips: number;
    passed: number;
    passRate: number | null;
  }[];
  /** Phase 12 — per-SKU confusion over ground-truthed clips with runs.
   *  Rows = actual (GT sku or NONE), columns = predicted (top-1 fused sku
   *  when a product event was detected, else NONE). */
  confusion: {
    labels: string[];
    matrix: number[][];
    samples: number;
  };
  scoreNote: string;
}

export interface EvaluationTestRunRow {
  videoAssetId: string;
  originalFilename: string;
  testType: CvTestScenario | null;
  groundTruth: {
    eventKind: GroundTruthEventKind;
    sku: string | null;
    quantity: number;
  };
  run: {
    runId: string;
    createdAt: string;
    policy: string;
    predictedKind: 'PICKUP' | 'RETURN' | null;
    predictedSku: string | null;
    fusedTopScore: number | null;
    vlmStatus: string | null;
    requiresHumanReview: boolean | null;
  } | null;
  evaluation: {
    /** null = unlabeled clip (excluded from pass rates). */
    pass: boolean | null;
    expected: string;
    actual: string;
  };
}

export interface EvaluationTestRuns {
  rows: EvaluationTestRunRow[];
  scoreNote: string;
}

// Phase 12/13 — camera runtime (SHADOW). FILE_REPLAY and RTSP_SHADOW are
// functional; RTSP_PLACEHOLDER/webcam remain registered placeholders.
// Camera-source responses NEVER carry a URL or a credential — only
// whether a secret slot NAME is configured; RTSP stream URLs live in
// server-side runtime configuration only.
export type CameraSourceType =
  | 'FILE_REPLAY'
  | 'RTSP_PLACEHOLDER'
  | 'LOCAL_WEBCAM_PLACEHOLDER'
  | 'RTSP_SHADOW';

export type CameraSourceStatus = 'ACTIVE' | 'DISABLED' | 'ERROR';

export interface CameraSourceView {
  id: string;
  locationId: string;
  unitId: string | null;
  name: string;
  shelfZone: string | null;
  sourceType: CameraSourceType;
  status: CameraSourceStatus;
  connectionNote: string | null;
  /** The secret itself is never stored or returned. */
  hasCredentialRef: boolean;
  replayVideoAssetId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PilotRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface PilotRunView {
  runId: string;
  cameraSourceId: string;
  cameraSourceName: string;
  sourceType: CameraSourceType;
  videoAssetId: string;
  journeyId: string | null;
  status: PilotRunStatus;
  frameIntervalMs: number;
  framesProcessed: number;
  /** Windows the heuristics detected vs windows the pipeline processed —
   *  a failed window leaves the gap visible. */
  eventWindowsDetected: number;
  eventWindowsProcessed: number;
  /** Crop FRAMES (pre/peak/post evidence) — not clips. Phase 12 generates
   *  no clip artifacts, so that counter stays 0 honestly. */
  cropFramesGenerated: number;
  clipArtifactsGenerated: number;
  fusionRunsCompleted: number;
  vlmInvoked: number;
  vlmSkipped: number;
  vlmFailed: number;
  journeyEventsCreated: number;
  reviewNeeded: number;
  decision: JourneyDecision | null;
  errorCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface PilotRunDetail extends PilotRunView {
  /** Window confidence is an uncalibrated heuristic score. */
  eventWindows: {
    startMs: number;
    peakMs: number;
    endMs: number;
    confidence: number;
  }[];
  stageTimings: { stage: string; ms: number }[];
  /** Controlled error codes only — never provider/exception text. */
  errors: { stage: string; code: string }[];
}

// Phase 13 — live RTSP shadow sessions. One row per live camera start;
// the session owns one shadow journey and its LIVE_WINDOW fusion runs.
// Responses never carry a URL, credential, or slot value.
export type LiveSessionStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'
  | 'ERROR';

export interface LiveSessionView {
  sessionId: string;
  cameraSourceId: string;
  cameraSourceName: string;
  sourceType: CameraSourceType;
  journeyId: string | null;
  status: LiveSessionStatus;
  frameIntervalMs: number;
  startedAt: string;
  stoppedAt: string | null;
  heartbeatAt: string | null;
  lastFrameAt: string | null;
  framesSampled: number;
  eventWindowsDetected: number;
  eventWindowsProcessed: number;
  fusionRunsCompleted: number;
  journeyEventsCreated: number;
  vlmInvoked: number;
  vlmSkipped: number;
  vlmFailed: number;
  reviewNeeded: number;
  decision: JourneyDecision | null;
  /** Controlled error code only — never raw exception text. */
  errorCode: string | null;
}

export interface LiveSessionDetail extends LiveSessionView {
  /** Window confidence is an uncalibrated heuristic score. */
  eventWindows: {
    startMs: number;
    peakMs: number;
    endMs: number;
    confidence: number;
  }[];
  performance: LivePerformanceSnapshot | null;
}

/** Phase 14 — per-stage timing statistics (controlled numeric
 *  aggregates only; no URLs, credentials, or free text). */
export interface LiveStageStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface LivePerformanceSnapshot {
  fastMode: boolean;
  stages: Record<string, LiveStageStats>;
}

/** Phase 14 — GET /live-sessions/:id/performance report. */
export interface LiveSessionPerformance {
  sessionId: string;
  status: LiveSessionStatus;
  decision: JourneyDecision | null;
  /** Stamped at session creation; null = legacy session recorded before
   *  the stamp existed (never inferred from current config). */
  fastMode: boolean | null;
  vlmInvoked: boolean;
  frameIntervalMs: number;
  framesSampled: number;
  eventWindowsDetected: number;
  eventWindowsProcessed: number;
  reviewNeeded: number;
  timings: Record<string, LiveStageStats>;
  slowestStage: { stage: string; p95Ms: number; maxMs: number } | null;
  safety: {
    orders: number;
    checkoutSessions: number;
    paymentIntents: number;
    paymentEvents: number;
    inventoryMovements: number;
    /** Zeros are STRUCTURAL: the camera module has no access to these
     *  tables at all — CI-enforced by the shadow-mode static guard. */
    basis: string;
  };
}

/** One journey observation awaiting human review (shadow pilot queue). */
export interface ReviewQueueItem {
  journeyId: string;
  journeyStatus: string;
  journeyDecision: JourneyDecision | null;
  eventId: string;
  eventType: JourneyEventType;
  occurredAt: string;
  sourceType: string;
  videoAssetId: string | null;
  fusionRunId: string | null;
  candidateSku: string | null;
  /** Uncalibrated ranking score, not a probability. */
  fusedTopScore: number | null;
  vlm: {
    status: string | null;
    verdict: string | null;
    selectedSku: string | null;
    requiresHumanReview: boolean;
  } | null;
  /** Controlled vocabulary — never event free text. */
  reason:
    | 'REVIEW_REQUIRED observation'
    | 'unknown product'
    | 'RETURN_WITHOUT_PICKUP'
    | 'NEGATIVE_QUANTITY';
  /** Always null in queue responses (only zero-review events are
   *  returned); kept for shape stability. */
  latestReview: { decision: JourneyReviewDecision; createdAt: string } | null;
}

/** Phase 15 — pilot evaluation loop (shadow only). */
export type PilotEvaluationStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';
export type PilotVerdict =
  | 'CORRECT'
  | 'INCORRECT'
  | 'UNCERTAIN'
  | 'FALSE_TOUCH'
  | 'WRONG_SKU'
  | 'WRONG_ACTION'
  | 'MISSED_EVENT';
export type PilotExpectedAction = 'PICKUP' | 'RETURN' | 'NO_OP' | 'UNKNOWN';

export interface PilotEvaluationRunView {
  evaluationRunId: string;
  name: string;
  description: string | null;
  locationId: string | null;
  locationName: string | null;
  status: PilotEvaluationStatus;
  sessionCount: number;
  reviewCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface PilotEvaluationDetail {
  evaluationRunId: string;
  name: string;
  description: string | null;
  locationId: string | null;
  locationName: string | null;
  status: PilotEvaluationStatus;
  createdAt: string;
  completedAt: string | null;
  reviewCount: number;
  sessions: {
    liveSessionId: string;
    attachedAt: string;
    status: LiveSessionStatus;
    decision: JourneyDecision | null;
    startedAt: string;
    stoppedAt: string | null;
    framesSampled: number;
    eventWindowsDetected: number;
    eventWindowsProcessed: number;
    reviewNeeded: number;
    errorCode: string | null;
  }[];
}

export interface PilotObservationRow {
  journeyEventId: string;
  liveSessionId: string | null;
  eventType: string;
  occurredAt: string;
  predictedProductId: string | null;
  predictedSku: string | null;
  predictedProductName: string | null;
  matchScore: number | null;
  latestReview: {
    reviewId: string;
    verdict: PilotVerdict;
    expectedAction: PilotExpectedAction;
    expectedProductId: string | null;
    expectedSku: string | null;
    notes: string | null;
    reviewedById: string | null;
    reviewedAt: string;
  } | null;
}

export interface PilotObservationsResponse {
  evaluationRunId: string;
  observations: PilotObservationRow[];
  missedEvents: {
    reviewId: string;
    liveSessionId: string | null;
    expectedAction: PilotExpectedAction;
    expectedSku: string | null;
    notes: string | null;
    reviewedAt: string;
  }[];
}

export interface PilotEvaluationSummary {
  evaluationRunId: string;
  status: PilotEvaluationStatus;
  totals: {
    observations: number;
    reviewed: number;
    unreviewed: number;
    correct: number;
    incorrect: number;
    uncertain: number;
    falseTouch: number;
    wrongSku: number;
    wrongAction: number;
    missedEvents: number;
  };
  accuracy: {
    action: number | null;
    sku: number | null;
    combined: number | null;
  };
  confusion: {
    action: { predicted: string; expected: string; count: number }[];
    sku: { predicted: string; expected: string; count: number }[];
  };
  latency: {
    sessions: {
      liveSessionId: string;
      eventToReview: LiveStageStats | null;
      fusion: LiveStageStats | null;
      journeyImport: LiveStageStats | null;
      slowestStage: { stage: string; p95Ms: number } | null;
    }[];
    combined: {
      liveSessionId: string;
      eventToReview: LiveStageStats | null;
      fusion: LiveStageStats | null;
      journeyImport: LiveStageStats | null;
      slowestStage: { stage: string; p95Ms: number } | null;
    } | null;
  };
  safety: {
    orders: number;
    checkoutSessions: number;
    paymentIntents: number;
    paymentEvents: number;
    inventoryMovements: number;
    basis: string;
  };
}

export interface PilotDatasetExport {
  evaluationRunId: string;
  rowCount: number;
  format: string;
  manifest: string;
}

/** Phase 16 — CV test protocols (shadow only). */
export type CvTestProtocolStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type CvTestScenarioResult = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type CvTestScenarioType =
  | 'SINGLE_PICKUP'
  | 'SINGLE_RETURN'
  | 'FALSE_TOUCH_NO_PRODUCT_MOVED'
  | 'MISSED_PICKUP'
  | 'MISSED_RETURN'
  | 'TWO_PRODUCTS_VISIBLE_ONE_PICKED'
  | 'SIMILAR_SKU_CONFUSION'
  | 'MULTI_QUANTITY_PICKUP'
  | 'HAND_OCCLUSION'
  | 'FAST_PICKUP'
  | 'SLOW_PICKUP'
  | 'LOW_LIGHT'
  | 'BAD_ANGLE'
  | 'EMPTY_SHELF'
  | 'UNKNOWN_PRODUCT';

export interface CvTestProtocolView {
  protocolId: string;
  name: string;
  description: string | null;
  status: CvTestProtocolStatus;
  locationName: string | null;
  cameraSourceName: string | null;
  evaluationRunId: string | null;
  fastModeExpected: boolean | null;
  scenarioCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface CvTestScenarioView {
  scenarioId: string;
  scenarioType: CvTestScenarioType;
  expectedAction: PilotExpectedAction;
  expectedProductId: string | null;
  expectedSku: string | null;
  expectedProductName: string | null;
  expectedQuantity: number | null;
  notes: string | null;
  liveSessionId: string | null;
  result: CvTestScenarioResult | null;
  resultNotes: string | null;
  resultAt: string | null;
  createdAt: string;
}

export interface CvTestProtocolDetail {
  protocolId: string;
  name: string;
  description: string | null;
  status: CvTestProtocolStatus;
  locationId: string | null;
  locationName: string | null;
  cameraSourceId: string | null;
  cameraSourceName: string | null;
  evaluationRunId: string | null;
  fastModeExpected: boolean | null;
  createdAt: string;
  completedAt: string | null;
  scenarios: CvTestScenarioView[];
}

export interface CvTestProtocolReport {
  protocolId: string;
  name: string;
  status: CvTestProtocolStatus;
  evaluationRunId: string | null;
  fastModeExpected: boolean | null;
  fastModeObserved: boolean | null;
  scenarios: {
    total: number;
    completed: number;
    pending: number;
    pass: number;
    fail: number;
    inconclusive: number;
  };
  detectionRecall: number | null;
  evaluation: PilotEvaluationSummary | null;
  datasetExport: { available: boolean; rowCount: number } | null;
  safety: {
    orders: number;
    checkoutSessions: number;
    paymentIntents: number;
    paymentEvents: number;
    inventoryMovements: number;
    basis: string;
  };
}

/** Phase 16 — GET /camera-sources/:id/live-test-preflight. */
export interface LiveTestPreflight {
  apiReachable: boolean;
  cameraSourceId: string;
  sourceExists: boolean;
  sourceActive: boolean;
  sourceTypeSupported: boolean;
  sourceConfigured: boolean;
  ffmpegAvailable: boolean;
  noActiveLiveSession: boolean;
  pilotRunnerEnabled: boolean;
  fastModeActive: boolean;
  /** The protocol's expectation (null = none) and whether it matches. */
  fastModeExpected: boolean | null;
  fastModeMatches: boolean | null;
  performanceEndpointAvailable: boolean;
  evaluationRunExists: boolean | null;
  /** Phase 17 — present only for RTSP_SHADOW, where calibration gates
   *  readiness. */
  calibrationReady?: boolean;
  /** Null when the camera source does not exist; readiness is
   *  NOT_APPLICABLE for FILE_REPLAY sources. */
  calibration: {
    readiness: CalibrationReadinessLevel;
    warnings: string[];
    activeProfileId: string | null;
  } | null;
  ready: boolean;
  safety: {
    orders: number;
    checkoutSessions: number;
    paymentIntents: number;
    paymentEvents: number;
    inventoryMovements: number;
    basis: string;
  };
}

/** Phase 17 — camera calibration & pilot hardening (shadow only). */
export type CameraCalibrationProfileStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type CameraCalibrationOrientation = 'LANDSCAPE' | 'PORTRAIT' | 'UNKNOWN';
export type CameraCalibrationMount =
  | 'OVERHEAD'
  | 'FRONT_SHELF'
  | 'ANGLED_SHELF'
  | 'UNKNOWN';
export type CameraCalibrationZoneType =
  | 'SHELF_ZONE'
  | 'INTERACTION_ZONE'
  | 'IGNORE_ZONE'
  | 'ENTRY_EXIT_ZONE';
export type CalibrationReadinessLevel =
  | 'READY'
  | 'WARNING'
  | 'NOT_READY'
  | 'NOT_APPLICABLE';

export interface CalibrationPolygonPoint {
  x: number;
  y: number;
}

export interface CameraCalibrationProfileView {
  id: string;
  cameraSourceId: string;
  locationId: string | null;
  name: string;
  status: CameraCalibrationProfileStatus;
  calibrationVersion: number;
  frameWidth: number | null;
  frameHeight: number | null;
  orientation: CameraCalibrationOrientation;
  cameraMount: CameraCalibrationMount;
  notes: string | null;
  zoneCount: number;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
}

export interface CameraCalibrationZoneView {
  id: string;
  calibrationProfileId: string;
  cameraSourceId: string;
  zoneType: CameraCalibrationZoneType;
  label: string;
  polygon: CalibrationPolygonPoint[];
  qualityScore: number | null;
  isActive: boolean;
  sortOrder: number;
  expectedProducts: { productId: string; sku: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface CameraCalibrationProfileDetail
  extends CameraCalibrationProfileView {
  zones: CameraCalibrationZoneView[];
}

/** GET /camera-sources/:id/calibration-readiness. Warnings are controlled
 *  enum strings only — never free text, URLs, or paths. */
export interface CalibrationReadiness {
  cameraSourceId: string;
  /** False for FILE_REPLAY sources — calibration is not required there and
   *  readiness reads NOT_APPLICABLE. */
  applicable: boolean;
  hasActiveCalibrationProfile: boolean;
  activeProfileId: string | null;
  profileStatus: 'ACTIVE' | null;
  hasShelfZone: boolean;
  hasInteractionZone: boolean;
  hasIgnoreZone: boolean;
  hasExpectedProducts: boolean;
  frameDimensionsKnown: boolean;
  orientationKnown: boolean;
  cameraMountKnown: boolean;
  zoneCount: number;
  expectedProductCount: number;
  readiness: CalibrationReadinessLevel;
  warnings: string[];
}

/** GET /camera-sources/:id/pilot-hardening-report. */
export interface PilotHardeningReport {
  cameraSourceId: string;
  sourceStatus: CameraSourceStatus;
  sourceType: CameraSourceType;
  calibrationReadiness: CalibrationReadiness;
  activeCalibrationProfile: CameraCalibrationProfileView | null;
  zoneSummary: {
    total: number;
    shelfZones: number;
    interactionZones: number;
    ignoreZones: number;
    entryExitZones: number;
  };
  expectedProductsSummary: {
    shelfZonesWithProducts: number;
    productCount: number;
  };
  latestLiveSessionSummary: {
    id: string;
    status: string;
    startedAt: string | null;
    stoppedAt: string | null;
    framesSampled: number;
    eventWindowsDetected: number;
    reviewNeeded: number;
    decision: string | null;
  } | null;
  latestPerformanceSummary: {
    fastMode: boolean | null;
    slowestStage: { stage: string; p95Ms: number; maxMs: number } | null;
  } | null;
  recommendedNextActions: string[];
  safety: {
    orders: number;
    checkoutSessions: number;
    paymentIntents: number;
    paymentEvents: number;
    inventoryMovements: number;
    basis: string;
  };
}
