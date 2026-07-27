import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  EvidenceBundle,
  VisionReviewDecision,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { containsSensitiveValue } from '../common/sensitive-keys';
import { BindVisionEventSessionDto } from './dto/bind-vision-event-session.dto';
import {
  MAX_REASON_CODE_LENGTH,
  REASON_CODE_REGEX,
} from './evidence-contract';
import {
  EvidenceBundleInputDto,
  IngestVisionEventDto,
  VisionEventCandidateDto,
} from './dto/ingest-vision-event.dto';
import { QueryVisionEventsDto } from './dto/query-vision-events.dto';
import { ReviewVisionEventDto } from './dto/review-vision-event.dto';
import {
  CandidateInput,
  EvidenceBundleInput,
  VisionEventDetail,
  VisionEventsRepository,
  VisionEventWithRefs,
} from './vision-events.repository';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

/**
 * Free-form strings persisted verbatim to vision rows. Like checkout
 * evidence refs, they must be OPAQUE: persistence is BLOCKED (controlled
 * 400) when any of them carries credential- or payment-bearing content —
 * raw PANs, credential URLs (rtsp://user:pass@camera.local), token/api_key
 * fragments. Secrets belong in a secret store; payment data must never be
 * stored (AGENTS.md payments invariant).
 */
function assertOpaque(field: string, value: string | undefined): void {
  if (value !== undefined && containsSensitiveValue(value)) {
    throw new BadRequestException(
      `${field} must be an opaque value and must not contain credential- ` +
        `or payment-bearing content. Secrets belong in a dedicated secret ` +
        `store (reference them by name), and payment data must never be ` +
        `stored.`,
    );
  }
}

/**
 * Phase 7 MVP evidence policy: the API accepts NO evidence payload
 * fields of any kind — no artifact descriptors, no metadata objects, no
 * user-supplied provenance strings, no inline media in any encoding. An
 * EvidenceBundle is a lightweight lineage record (sourceType enum +
 * capture window) that events, reviews, and basket lines reference by
 * id. Anything payload-shaped is a controlled 400 with a stable message
 * so adapters learn this is scope, not a bug — and because nothing
 * payload-shaped is accepted at all, there is no encoded-content
 * heuristic left to bypass.
 */
const EVIDENCE_PAYLOADS_OUT_OF_SCOPE =
  'Evidence artifacts are out of scope for Phase 7 MVP. Store external ' +
  'media references in the future evidence storage phase.';

/** The ONLY caller-suppliable evidence bundle fields in Phase 7. */
const BUNDLE_ALLOWED_KEYS = new Set([
  'sourceType',
  'captureStartedAt',
  'captureEndedAt',
]);

/**
 * Event-level fields removed by the Phase 7 evidence policy. They are
 * gone from the DTO (the global whitelist ValidationPipe already 400s
 * them at the HTTP layer); this guard keeps the contract for direct
 * service callers and makes the rejection reason explicit.
 */
const REMOVED_EVENT_FIELDS = [
  'artifacts',
  'metadata',
  'sourceId',
  'modelName',
  'modelVersion',
] as const;

function rejectEvidencePayload(path: string): never {
  throw new BadRequestException(
    `${path} is not accepted. ${EVIDENCE_PAYLOADS_OUT_OF_SCOPE}`,
  );
}

/**
 * Idempotency-key namespace reserved for the Phase 9 inference → vision
 * conversion (`inference:<jobId>`). Public ingest callers may not use it:
 * a caller who pre-ingested an arbitrary event under a job's derived key
 * would otherwise be REPLAYED to the converter, permanently linking the
 * wrong event to the job. Only the internal conversion path (which also
 * verifies the replayed event against the job's result) may pass keys in
 * this namespace.
 */
export const RESERVED_INFERENCE_IDEMPOTENCY_PREFIX = 'inference:';

/** Internal options for trusted service-to-service ingest callers. */
export interface IngestOptions {
  allowReservedIdempotencyKey?: boolean;
}

function assertNoEventEvidencePayload(dto: IngestVisionEventDto): void {
  const record = dto as unknown as Record<string, unknown>;
  for (const key of REMOVED_EVENT_FIELDS) {
    if (record[key] !== undefined) {
      rejectEvidencePayload(key);
    }
  }
}

/**
 * The inline bundle may carry ONLY lineage fields. Everything else —
 * artifacts, metadata, uri/storageKey/hash/mimeType descriptors,
 * provenance strings, unknown keys of any name — is rejected wholesale
 * before anything reaches the append-only store.
 */
function assertBundleLineageOnly(
  bundle: EvidenceBundleInputDto | undefined,
): void {
  if (!bundle) {
    return;
  }
  for (const key of Object.keys(bundle)) {
    if (!BUNDLE_ALLOWED_KEYS.has(key)) {
      rejectEvidencePayload(`evidenceBundle.${key}`);
    }
  }
}

/**
 * Reason codes are the only caller-supplied free strings that survive on
 * the vision event: strict lowercase slugs (occlusion, low-confidence),
 * so there is no room for case-mixed encoded content.
 */
function assertReasonCode(field: string, value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_REASON_CODE_LENGTH ||
    !REASON_CODE_REGEX.test(value)
  ) {
    throw new BadRequestException(
      `${field} must be a lowercase slug reason code of at most ` +
        `${MAX_REASON_CODE_LENGTH} characters (letter/digit segments ` +
        `joined by ".", "_" or "-")`,
    );
  }
}

@Injectable()
export class VisionEventsService {
  constructor(private readonly eventsRepository: VisionEventsRepository) {}

  async ingest(
    tenantId: string,
    dto: IngestVisionEventDto,
    actor?: AuditActor,
    options: IngestOptions = {},
  ): Promise<VisionEventDetail> {
    // Phase 7 evidence policy: reject every removed payload-capable
    // field with the stable out-of-scope message before any other work.
    assertNoEventEvidencePayload(dto);
    assertOpaque('evidenceBundleId', dto.evidenceBundleId);
    assertOpaque('idempotencyKey', dto.idempotencyKey);
    if (
      !options.allowReservedIdempotencyKey &&
      dto.idempotencyKey?.startsWith(RESERVED_INFERENCE_IDEMPOTENCY_PREFIX)
    ) {
      throw new BadRequestException(
        `idempotencyKey namespace "${RESERVED_INFERENCE_IDEMPOTENCY_PREFIX}" ` +
          'is reserved for the inference conversion path; choose a key ' +
          'outside it',
      );
    }
    for (const [index, code] of (dto.reasonCodes ?? []).entries()) {
      assertReasonCode(`reasonCodes[${index}]`, code);
    }
    if (dto.evidenceBundleId && dto.evidenceBundle) {
      throw new BadRequestException(
        'Provide either evidenceBundleId (attach an existing bundle) or ' +
          'evidenceBundle (create one inline), not both',
      );
    }
    const bundle = this.normalizeBundle(dto.evidenceBundle);
    const candidates = this.normalizeCandidates(dto.candidates ?? []);

    let result: Awaited<ReturnType<VisionEventsRepository['ingest']>>;
    try {
      result = await this.eventsRepository.ingest(
        tenantId,
        {
          locationId: dto.locationId,
          unitId: dto.unitId,
          deviceId: dto.deviceId,
          sessionId: dto.sessionId,
          type: dto.type,
          occurredAt: new Date(dto.occurredAt),
          quantity: dto.quantity ?? 1,
          candidates,
          sourceType: dto.sourceType,
          evidenceBundleId: dto.evidenceBundleId,
          evidenceBundle: bundle,
          evidenceScore: dto.evidenceScore,
          evidenceQuality: dto.evidenceQuality,
          reasonCodes: dto.reasonCodes,
          idempotencyKey: dto.idempotencyKey,
          createdById: actor?.id,
        },
        {
          eventCreated: (event) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'VisionEvent',
              entityId: event.id,
              after: event,
              reason: `Vision event ingested (${event.type})`,
            }),
          bundleCreated: (created) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'EvidenceBundle',
              entityId: created.id,
              after: created,
              reason: 'Evidence bundle recorded with vision event',
            }),
        },
      );
    } catch (error) {
      // Two firsts racing the same idempotency key: the loser's insert hits
      // the (tenantId, idempotencyKey) unique — replay the winner's event.
      if (prismaErrorCode(error) === 'P2002' && dto.idempotencyKey) {
        const existing = await this.eventsRepository.findByIdempotencyKey(
          tenantId,
          dto.idempotencyKey,
        );
        if (existing) {
          return existing;
        }
      }
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'A referenced store, unit, device, session, or product no longer exists',
        );
      }
      throw error;
    }
    if (result === 'location-not-found') {
      throw new BadRequestException(`Store "${dto.locationId}" not found`);
    }
    if (result === 'unit-not-found') {
      throw new BadRequestException(`Unit "${dto.unitId}" not found`);
    }
    if (result === 'unit-location-mismatch') {
      throw new BadRequestException(
        `Unit "${dto.unitId}" does not belong to store "${dto.locationId}"`,
      );
    }
    if (result === 'device-not-found') {
      throw new BadRequestException(`Device "${dto.deviceId}" not found`);
    }
    if (result === 'device-unit-mismatch') {
      throw new BadRequestException(
        `Device "${dto.deviceId}" is not attached to unit "${dto.unitId}"`,
      );
    }
    if (result === 'session-not-found') {
      throw new BadRequestException(
        `Checkout session "${dto.sessionId}" not found`,
      );
    }
    if (result === 'session-unit-mismatch') {
      throw new BadRequestException(
        `Checkout session "${dto.sessionId}" is not at unit "${dto.unitId}"`,
      );
    }
    if (result === 'session-location-mismatch') {
      throw new BadRequestException(
        `Checkout session "${dto.sessionId}" is not at store ` +
          `"${dto.locationId}" (the unit may have been reassigned since ` +
          'the session opened)',
      );
    }
    if (result === 'bundle-not-found') {
      throw new BadRequestException(
        `Evidence bundle "${dto.evidenceBundleId}" not found`,
      );
    }
    if (typeof result === 'object' && 'unknownSkus' in result) {
      throw new BadRequestException(
        `Unknown candidate SKU(s) in this tenant's catalog: ` +
          `${result.unknownSkus.join(', ')}. Adapters must normalize ` +
          `detections to catalog SKUs before ingesting`,
      );
    }
    return result.event;
  }

  async findById(tenantId: string, id: string): Promise<VisionEventDetail> {
    const event = await this.eventsRepository.findById(tenantId, id);
    if (!event) {
      throw new NotFoundException(`Vision event "${id}" not found`);
    }
    return event;
  }

  async findBundleById(
    tenantId: string,
    id: string,
  ): Promise<EvidenceBundle> {
    const bundle = await this.eventsRepository.findBundleById(tenantId, id);
    if (!bundle) {
      throw new NotFoundException(`Evidence bundle "${id}" not found`);
    }
    return bundle;
  }

  async search(
    tenantId: string,
    query: QueryVisionEventsDto,
  ): Promise<{
    items: VisionEventWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.eventsRepository.search(tenantId, {
      status: query.status,
      type: query.type,
      sessionId: query.sessionId,
      locationId: query.locationId,
      unitId: query.unitId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async review(
    tenantId: string,
    eventId: string,
    dto: ReviewVisionEventDto,
    actor?: AuditActor,
  ): Promise<VisionEventDetail> {
    assertOpaque('reason', dto.reason);
    if (dto.decision === VisionReviewDecision.OVERRIDE) {
      if (!dto.productId || dto.quantity === undefined) {
        throw new BadRequestException(
          'OVERRIDE requires productId and quantity (the manual correction to apply)',
        );
      }
    } else if (dto.productId !== undefined || dto.quantity !== undefined) {
      // Reject instead of silently ignoring: an APPROVE carrying a product/
      // quantity is almost certainly a caller who meant OVERRIDE.
      throw new BadRequestException(
        `productId/quantity are only valid for OVERRIDE decisions (got ${dto.decision})`,
      );
    }
    const auditAction =
      dto.decision === VisionReviewDecision.APPROVE
        ? AuditAction.APPROVE
        : dto.decision === VisionReviewDecision.REJECT
          ? AuditAction.REJECT
          : AuditAction.OVERRIDE;
    const decidedWord =
      dto.decision === VisionReviewDecision.APPROVE
        ? 'approved'
        : dto.decision === VisionReviewDecision.REJECT
          ? 'rejected'
          : 'overridden';
    let result: Awaited<ReturnType<VisionEventsRepository['review']>>;
    try {
      result = await this.eventsRepository.review(
        tenantId,
        eventId,
        {
          decision: dto.decision,
          productId: dto.productId,
          quantity: dto.quantity,
          reason: dto.reason,
          reviewedById: actor?.id,
        },
        {
          decided: (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: auditAction,
              entityType: 'VisionEvent',
              entityId: after.id,
              before,
              after,
              reason: dto.reason ?? `Vision event ${decidedWord}`,
            }),
          reviewCreated: (review) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'VisionEventReview',
              entityId: review.id,
              after: review,
              reason: `Review decision recorded (${review.decision}, ${review.basketEffect})`,
            }),
          lineAdded: (line) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.CREATE,
              entityType: 'CheckoutSessionLine',
              entityId: line.id,
              after: line,
              reason: `Basket line added by approved vision event ${eventId}`,
            }),
          lineChanged: (before, after) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.UPDATE,
              entityType: 'CheckoutSessionLine',
              entityId: after.id,
              before,
              after,
              reason: `Basket line adjusted by approved vision event ${eventId}`,
            }),
          lineRemoved: (before) =>
            this.auditEntry(tenantId, actor, {
              action: AuditAction.DELETE,
              entityType: 'CheckoutSessionLine',
              entityId: before.id,
              before,
              reason: `Basket line removed by approved vision event ${eventId}`,
            }),
        },
      );
    } catch (error) {
      // Unique-violation backstop for two decisions racing past the
      // advisory lock: the loser's review insert hits the (tenantId,
      // eventId) unique — a controlled 409, never an uncaught 500.
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException(
          'This event has already been decided (approved, rejected, or overridden)',
        );
      }
      throw error;
    }
    if (result === null) {
      throw new NotFoundException(`Vision event "${eventId}" not found`);
    }
    if (result === 'already-decided') {
      throw new ConflictException(
        'This event has already been decided (approved, rejected, or ' +
          'overridden); decisions are terminal',
      );
    }
    if (result === 'override-not-applicable') {
      throw new ConflictException(
        'Only basket-affecting events (PRODUCT_PICKUP, CART_INSERTION, ' +
          'PRODUCT_RETURN) can be overridden',
      );
    }
    if (result === 'no-candidates') {
      throw new ConflictException(
        'The event has no SKU candidates to approve; use OVERRIDE to apply ' +
          'a manual correction or REJECT it',
      );
    }
    if (result === 'no-session') {
      throw new ConflictException(
        'The event is not bound to a checkout session, so its approval ' +
          'cannot affect a basket; bind it first (POST ' +
          '/vision-events/:id/session) or REJECT it',
      );
    }
    if (result === 'session-terminal') {
      throw new ConflictException(
        'The linked checkout session is completed, cancelled, or expired; ' +
          'its basket can no longer change',
      );
    }
    if (result === 'checkout-module-disabled') {
      throw new ForbiddenException(
        'The checkout module is not enabled for this tenant, so a basket-' +
          'affecting decision cannot be applied; REJECT the event or ' +
          'enable checkout',
      );
    }
    if (result === 'product-not-found') {
      throw new NotFoundException('The product to apply was not found');
    }
    if (result === 'product-not-saleable') {
      throw new ConflictException(
        'The product to apply is not ACTIVE and cannot enter a basket',
      );
    }
    if (result === 'no-line-to-decrement') {
      throw new ConflictException(
        'The session has no active basket line for this product; there is ' +
          'nothing for the return to decrease',
      );
    }
    if (result === 'line-quantity-overflow') {
      throw new ConflictException(
        'Applying this event would push the basket line quantity past the ' +
          'maximum a line can hold',
      );
    }
    return result;
  }

  async bindSession(
    tenantId: string,
    eventId: string,
    dto: BindVisionEventSessionDto,
    actor?: AuditActor,
  ): Promise<VisionEventDetail> {
    const result = await this.eventsRepository.bindSession(
      tenantId,
      eventId,
      dto.sessionId,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'VisionEvent',
          entityId: after.id,
          before,
          after,
          reason: `Vision event bound to checkout session ${dto.sessionId}`,
        }),
    );
    if (result === null) {
      throw new NotFoundException(`Vision event "${eventId}" not found`);
    }
    if (result === 'already-decided') {
      throw new ConflictException(
        'This event has already been decided (approved, rejected, or ' +
          'overridden); decisions are terminal and cannot be rebound',
      );
    }
    if (result === 'already-bound') {
      throw new ConflictException(
        'This event is already bound to a checkout session; bindings are ' +
          'one-shot. To correct a wrong binding, REJECT the event and ' +
          're-ingest it against the right session',
      );
    }
    if (result === 'session-not-found') {
      throw new BadRequestException(
        `Checkout session "${dto.sessionId}" not found`,
      );
    }
    if (result === 'session-unit-mismatch') {
      throw new BadRequestException(
        `Checkout session "${dto.sessionId}" is not at the event's unit`,
      );
    }
    if (result === 'session-location-mismatch') {
      throw new BadRequestException(
        `Checkout session "${dto.sessionId}" is not at the event's store ` +
          '(the unit may have been reassigned since the session opened)',
      );
    }
    return result;
  }

  /**
   * Screens the inline bundle down to the Phase 7 lineage record
   * (sourceType + capture window) and converts it to repository input.
   * There are no payload fields left to persist.
   */
  private normalizeBundle(
    dto: EvidenceBundleInputDto | undefined,
  ): EvidenceBundleInput | undefined {
    if (!dto) {
      return undefined;
    }
    assertBundleLineageOnly(dto);
    const captureStartedAt = dto.captureStartedAt
      ? new Date(dto.captureStartedAt)
      : undefined;
    const captureEndedAt = dto.captureEndedAt
      ? new Date(dto.captureEndedAt)
      : undefined;
    if (
      captureStartedAt &&
      captureEndedAt &&
      captureEndedAt.getTime() < captureStartedAt.getTime()
    ) {
      throw new BadRequestException(
        'evidenceBundle.captureEndedAt must not be before captureStartedAt',
      );
    }
    return {
      sourceType: dto.sourceType,
      captureStartedAt,
      captureEndedAt,
    };
  }

  /**
   * Normalizes candidate SKUs (uppercase, like the catalog), assigns ranks
   * (explicit, or 1-based array order when none are given), and rejects
   * ambiguous rankings: mixed explicit/implicit ranks, duplicate ranks, or
   * duplicate SKUs.
   */
  private normalizeCandidates(
    dtos: VisionEventCandidateDto[],
  ): CandidateInput[] {
    const explicit = dtos.filter((c) => c.rank !== undefined).length;
    if (explicit !== 0 && explicit !== dtos.length) {
      throw new BadRequestException(
        'Candidate ranks must be either all explicit or all omitted (ranked by array order)',
      );
    }
    const seenSkus = new Set<string>();
    const seenRanks = new Set<number>();
    return dtos.map((candidate, index) => {
      assertOpaque(`candidates[${index}].label`, candidate.label);
      assertOpaque(`candidates[${index}].sku`, candidate.sku);
      const sku = candidate.sku.trim().toUpperCase();
      if (sku.length === 0) {
        throw new BadRequestException(
          `candidates[${index}].sku must not be blank`,
        );
      }
      if (seenSkus.has(sku)) {
        throw new BadRequestException(
          `Duplicate candidate SKU "${sku}" — each product may appear once`,
        );
      }
      seenSkus.add(sku);
      const rank = candidate.rank ?? index + 1;
      if (seenRanks.has(rank)) {
        throw new BadRequestException(
          `Duplicate candidate rank ${rank} — ranks must be unique`,
        );
      }
      seenRanks.add(rank);
      return { sku, rank, score: candidate.score, label: candidate.label };
    });
  }

  private auditEntry(
    tenantId: string,
    actor: AuditActor | undefined,
    partial: Pick<
      AuditEntry,
      'action' | 'entityType' | 'entityId' | 'before' | 'after' | 'reason'
    >,
  ): AuditEntry {
    return {
      tenantId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }
}
