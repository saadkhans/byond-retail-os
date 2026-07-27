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
