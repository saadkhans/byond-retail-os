import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, InferenceJobStatus, Prisma } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import {
  containsSensitiveValue,
  findSensitiveKeyPath,
  isSensitiveKey,
} from '../common/sensitive-keys';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { IngestVisionEventDto } from '../vision/dto/ingest-vision-event.dto';
import { VisionEventDetail } from '../vision/vision-events.repository';
import { VisionEventsService } from '../vision/vision-events.service';
import {
  InferenceAdapter,
  InferenceAdapterInput,
  InferenceJobContext,
} from './adapters/inference-adapter';
import { InferenceAdapterRegistry } from './adapters/adapter.registry';
import { SIMULATED_ADAPTER_KEY } from './adapters/simulated.adapter';
import { CompleteInferenceJobDto } from './dto/complete-inference-job.dto';
import {
  CreateInferenceJobDto,
  DEFAULT_PRIORITY,
} from './dto/create-inference-job.dto';
import { FailInferenceJobDto } from './dto/fail-inference-job.dto';
import { QueryInferenceJobsDto } from './dto/query-inference-jobs.dto';
import { StartInferenceJobDto } from './dto/start-inference-job.dto';
import {
  InferenceJobDetail,
  InferenceJobsRepository,
  InferenceJobWithRefs,
} from './inference-jobs.repository';
import { findForbiddenMediaPath, percentDecodeStages } from './media-policy';
import { InferenceQueuePort } from './queue/inference-queue.port';

function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

/**
 * Free-form strings persisted verbatim to inference rows. Like the vision
 * and checkout evidence refs, they must be OPAQUE: persistence is BLOCKED
 * (controlled 400) when any of them carries credential- or payment-bearing
 * content. Secrets belong in a secret store; payment data must never be
 * stored (AGENTS.md payments invariant).
 */
// C0 control characters and DEL. PostgreSQL text/jsonb cannot store NUL at
// all — without this guard a NUL reaches Prisma and surfaces as an
// uncontrolled 500 (and a mid-lifecycle failure leaves the job RUNNING);
// the rest of the range has no business in opaque single-line ids either.
// eslint-disable-next-line no-control-regex -- matching control chars IS the guard
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/**
 * Control characters are screened at every percent-decode stage too: a
 * "%09"-joined digit string contains no raw control character but decodes
 * to a TAB-separated PAN that the contiguous/space/dash PAN detector cannot
 * see — the decoded-stage control check closes that channel (any encoded
 * separator that is not space/dash IS a control char or is caught by the
 * sensitive check on the same stage).
 */
function hasControlCharacters(value: string): boolean {
  return percentDecodeStages(value).some((stage) =>
    CONTROL_CHARACTERS.test(stage),
  );
}

function assertOpaque(field: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  if (hasControlCharacters(value)) {
    throw new BadRequestException(
      `${field} must not contain control characters`,
    );
  }
  // Screen every percent-decode stage, not just the raw string — the same
  // rule as the descriptor policy, so "4111%20..." cannot hide a PAN in an
  // opaque id field either.
  if (percentDecodeStages(value).some(containsSensitiveValue)) {
    throw new BadRequestException(
      `${field} must be an opaque value and must not contain credential- ` +
        `or payment-bearing content. Secrets belong in a dedicated secret ` +
        `store (reference them by name), and payment data must never be ` +
        `stored.`,
    );
  }
}

/**
 * Dotted path of the first key or string value carrying a control char at
 * ANY percent-decode stage ("%00"/"%09" decode to NUL/TAB).
 */
function findControlCharacterPath(value: unknown, path = ''): string | null {
  if (typeof value === 'string') {
    return hasControlCharacters(value) ? path || '(value)' : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findControlCharacterPath(value[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const keyPath = path ? `${path}.${key}` : key;
      if (hasControlCharacters(key)) {
        return keyPath;
      }
      const found = findControlCharacterPath(nested, keyPath);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Percent-encoding must not hide credential- or payment-bearing content
 * either: "4111%201111%20..." decodes to a spaced Luhn-valid PAN that the
 * raw-string check cannot see. Every decode stage (same bounded discipline
 * as the media policy) runs through containsSensitiveValue.
 */
function findEncodedSensitivePath(value: unknown, path = ''): string | null {
  if (typeof value === 'string') {
    return percentDecodeStages(value).some(containsSensitiveValue)
      ? path || '(value)'
      : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findEncodedSensitivePath(value[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const keyPath = path ? `${path}.${key}` : key;
      // KEY strings are attacker-controlled text too: a PAN or credential
      // used AS a key ({"4111 ...": "x"}) must be rejected like a value,
      // and a credential-CHANNEL key hidden by encoding ("c%76v" → "cvv",
      // "pass%77ord" → "password") must be classified as a sensitive KEY
      // at every decode stage — its VALUE is the secret and matches no
      // value-shape check.
      if (
        percentDecodeStages(key).some(
          (stage) => containsSensitiveValue(stage) || isSensitiveKey(stage),
        )
      ) {
        return keyPath;
      }
      const found = findEncodedSensitivePath(nested, keyPath);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The offending path is attacker-controlled text and can ITSELF be the
 * sensitive material (a PAN or credential used as a key): reflecting it
 * verbatim into the HTTP error would move card data into error records and
 * telemetry. Each path segment whose decode stages carry sensitive
 * content, a sensitive key name, or control characters is replaced with
 * '[REDACTED]'; benign segments ("trigger.cropImageUrl") stay readable.
 */
function redactDescriptorPath(path: string): string {
  const redacted = path
    .split('.')
    .map((segment) =>
      percentDecodeStages(segment).some(
        (stage) =>
          containsSensitiveValue(stage) ||
          isSensitiveKey(stage) ||
          CONTROL_CHARACTERS.test(stage),
      )
        ? '[REDACTED]'
        : segment,
    )
    .join('.');
  // Belt and braces: sensitive content split ACROSS segments (a dotted key)
  // must not survive re-joining.
  return containsSensitiveValue(redacted) ? '[REDACTED]' : redacted;
}

/**
 * Phase 9 input-descriptor policy: SAFE, TYPED references only. Raw media,
 * media/storage URLs, signed URLs, artifact descriptors, inline base64,
 * and credential-/payment-bearing content are all controlled 400s — the
 * app database never carries media or secrets; external media references
 * arrive in the future evidence storage phase.
 */
function assertSafeInputDescriptor(
  descriptor: Record<string, unknown> | undefined,
): void {
  if (descriptor === undefined) {
    return;
  }
  const controlPath = findControlCharacterPath(descriptor);
  if (controlPath) {
    throw new BadRequestException(
      `inputDescriptor.${redactDescriptorPath(controlPath)} must not ` +
        `contain control characters`,
    );
  }
  const mediaPath = findForbiddenMediaPath(descriptor);
  if (mediaPath) {
    throw new BadRequestException(
      `inputDescriptor.${redactDescriptorPath(mediaPath)} is not accepted: ` +
        `raw media, media/storage URLs, signed URLs, and artifact ` +
        `descriptors are out of scope for Phase 9 MVP — reference ` +
        `crops/zones/frames by id only.`,
    );
  }
  const sensitivePath =
    findSensitiveKeyPath(descriptor) ?? findEncodedSensitivePath(descriptor);
  if (sensitivePath) {
    throw new BadRequestException(
      `inputDescriptor.${redactDescriptorPath(sensitivePath)} must not ` +
        `carry credential- or payment-bearing content. Secrets belong in a ` +
        `dedicated secret store, and payment data must never be stored.`,
    );
  }
}

@Injectable()
export class InferenceJobsService {
  constructor(
    private readonly jobsRepository: InferenceJobsRepository,
    private readonly queue: InferenceQueuePort<InferenceJobDetail>,
    private readonly adapterRegistry: InferenceAdapterRegistry,
    private readonly visionEventsService: VisionEventsService,
    private readonly platformModulesService: PlatformModulesService,
  ) {}

  /**
   * Creates (or idempotently replays) an inference job.
   *
   * `options.createPendingLink` is an INTERNAL, service-only opt-in — it is
   * deliberately NOT part of CreateInferenceJobDto, so no HTTP client can
   * mint non-claimable jobs. Callers that must commit a downstream link
   * before the work may be delivered (video-ingest's crop artifact → job
   * link) create the job PENDING_LINK, commit their link, and then call
   * publishPendingLinkJob(). A crash between the two leaves a job NO worker
   * can claim, still discoverable by its idempotency key
   * (findByIdempotencyKey) and cancellable (cancelOrphanedJob). Absent or
   * false, creation is byte-identical to Phase 9: a directly QUEUED job.
   */
  async create(
    tenantId: string,
    dto: CreateInferenceJobDto,
    actor?: AuditActor,
    options?: { createPendingLink?: boolean },
  ): Promise<InferenceJobDetail> {
    assertOpaque('sourceId', dto.sourceId);
    assertOpaque('idempotencyKey', dto.idempotencyKey);
    assertSafeInputDescriptor(dto.inputDescriptor);

    let result: Awaited<ReturnType<InferenceQueuePort<InferenceJobDetail>['enqueue']>>;
    try {
      result = await this.queue.enqueue(
        tenantId,
        {
          locationId: dto.locationId,
          unitId: dto.unitId,
          deviceId: dto.deviceId,
          sessionId: dto.sessionId,
          jobType: dto.jobType,
          priority: dto.priority ?? DEFAULT_PRIORITY,
          sourceType: dto.sourceType,
          sourceId: dto.sourceId,
          inputDescriptor: dto.inputDescriptor as
            | Prisma.InputJsonValue
            | undefined,
          idempotencyKey: dto.idempotencyKey,
          createdById: actor?.id,
          pendingLink: options?.createPendingLink === true,
        },
        (job) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'InferenceJob',
            entityId: job.id,
            after: job,
            reason:
              options?.createPendingLink === true
                ? `Inference job created pending link (${job.jobType}); it ` +
                  'is not claimable until published'
                : `Inference job queued (${job.jobType})`,
          }),
      );
    } catch (error) {
      // Two firsts racing the same idempotency key: the loser's insert hits
      // the (tenantId, idempotencyKey) unique — replay the winner's job.
      if (prismaErrorCode(error) === 'P2002' && dto.idempotencyKey) {
        const existing = await this.jobsRepository.findByIdempotencyKey(
          tenantId,
          dto.idempotencyKey,
        );
        if (existing) {
          return existing;
        }
      }
      if (prismaErrorCode(error) === 'P2003') {
        throw new BadRequestException(
          'A referenced store, unit, device, or session no longer exists',
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
        `Checkout session "${dto.sessionId}" is not in the job's store`,
      );
    }
    if (result === 'creator-not-found') {
      throw new BadRequestException(
        'The acting user does not belong to this tenant',
      );
    }
    return result.job;
  }

  /**
   * INTERNAL service-only seam (no controller route): the SECOND phase of
   * two-phase creation. Publishes a job created with
   * `{ createPendingLink: true }` once the caller's downstream link has
   * COMMITTED — PENDING_LINK → QUEUED as an audited compare-and-set, which
   * is the moment the work becomes claimable. Routed through the QUEUE
   * PORT (never the repository): publication is a queue-lifecycle mutation,
   * and a broker-backed implementation enqueues its message here.
   *
   * Returns the published job, or the controlled rejection 'not-pending'
   * when the row is not PENDING_LINK — already published (a replayed
   * publish), cancelled by a concurrent asset delete, or missing in this
   * tenant. Like cancelOrphanedJob this NEVER throws HTTP errors: the
   * caller decides whether a lost publish is a retry, a 409, or a no-op.
   */
  async publishPendingLinkJob(
    tenantId: string,
    jobId: string,
    actor?: AuditActor,
  ): Promise<InferenceJobDetail | 'not-pending'> {
    const result = await this.queue.publishPendingLink(
      tenantId,
      jobId,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'InferenceJob',
          entityId: after.id,
          before,
          after,
          reason:
            'Inference job published to the queue: its downstream link ' +
            'committed, so the job is now claimable',
        }),
    );
    return result === null || result === 'not-pending' ? 'not-pending' : result;
  }

  /**
   * INTERNAL service-only seam (no controller route): tenant-scoped
   * discovery by the caller's DETERMINISTIC idempotency key — how a
   * crash-window job is found when the link that would have made it
   * reachable never committed (video-ingest's key is
   * `video-crop:<artifactId>`). Returns the job WITH its status (so the
   * caller can decide between publishing and cancelling it) or null when
   * this tenant has no job under that key. Never throws NotFound: absence
   * is the normal answer.
   */
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<InferenceJobDetail | null> {
    return this.jobsRepository.findByIdempotencyKey(tenantId, idempotencyKey);
  }

  /**
   * INTERNAL service-only seam (no controller route): compensation for a
   * caller whose downstream linkage to a just-created job failed
   * permanently — e.g. video-ingest's crop → job link losing the race with
   * the source asset's deletion — leaving the job as orphan work nothing
   * will ever consume. Transitions PENDING_LINK/QUEUED → CANCELLED, as an
   * audited (CANCEL) compare-and-set: a job whose link never committed
   * (still PENDING_LINK after a crash) retires exactly like a published
   * one, which is what lets a later DELETE clean the crash window. A job
   * already claimed (RUNNING) or finished
   * returns 'not-cancellable' so the caller records the orphan condition
   * instead — this path never throws HTTP errors, because it runs while a
   * different controlled error is already being surfaced. `reason` is
   * composed by the internal caller (never end-user input) and lands in
   * the audit trail verbatim. The cancellation goes through the QUEUE
   * PORT (never the repository directly): withdrawing queued work is a
   * queue-lifecycle mutation, and a broker-backed port implementation
   * must learn about it to drop the message.
   */
  async cancelOrphanedJob(
    tenantId: string,
    jobId: string,
    reason: string,
    actor?: AuditActor,
  ): Promise<InferenceJobDetail | 'not-cancellable'> {
    const result = await this.queue.cancelQueued(
      tenantId,
      jobId,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.CANCEL,
          entityType: 'InferenceJob',
          entityId: after.id,
          before,
          after,
          reason,
        }),
    );
    return result === null || result === 'not-queued'
      ? 'not-cancellable'
      : result;
  }

  async search(
    tenantId: string,
    query: QueryInferenceJobsDto,
  ): Promise<{
    items: InferenceJobWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.jobsRepository.search(tenantId, {
      status: query.status,
      jobType: query.jobType,
      sessionId: query.sessionId,
      locationId: query.locationId,
      unitId: query.unitId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async findById(tenantId: string, id: string): Promise<InferenceJobDetail> {
    const job = await this.jobsRepository.findById(tenantId, id);
    if (!job) {
      throw new NotFoundException(`Inference job "${id}" not found`);
    }
    return job;
  }

  async start(
    tenantId: string,
    jobId: string,
    dto: StartInferenceJobDto,
    actor?: AuditActor,
  ): Promise<InferenceJobDetail> {
    const adapterKey = dto.adapterKey ?? SIMULATED_ADAPTER_KEY;
    assertOpaque('adapterKey', adapterKey);
    // Stranded work first: /start is the only production path into RUNNING,
    // so it is also where expired leases must be reclaimed — otherwise a
    // crashed worker's RUNNING job would never re-enter the queue.
    await this.queue.reclaimExpired(tenantId);
    const job = await this.findById(tenantId, jobId);
    const adapter = this.requireAdapter(adapterKey);
    if (!adapter.supportedJobTypes.includes(job.jobType)) {
      throw new BadRequestException(
        `Adapter "${adapterKey}" does not support job type ${job.jobType}`,
      );
    }
    const result = await this.queue.markRunning(
      tenantId,
      jobId,
      adapterKey,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'InferenceJob',
          entityId: after.id,
          before,
          after,
          reason: `Inference job started with adapter "${adapterKey}"`,
        }),
    );
    if (result === null) {
      throw new NotFoundException(`Inference job "${jobId}" not found`);
    }
    if (result === 'terminal') {
      throw new ConflictException(
        'This job has already finished (succeeded, failed, or cancelled); ' +
          'terminal jobs never transition again',
      );
    }
    if (
      result === 'not-claimable' ||
      result === 'not-running' ||
      result === 'lease-superseded'
    ) {
      throw new ConflictException(
        'Only a QUEUED job can be started; this job is already running, or ' +
          'is still pending its downstream link and has not been published ' +
          'to the queue yet',
      );
    }
    return result;
  }

  /**
   * Operator-triggered recovery: reclaim every RUNNING job in the tenant
   * whose lease expired (crashed/hung worker) — back to QUEUED while
   * attempts remain, FAILED with LEASE_EXPIRED once the budget is spent.
   * The same sweep already runs before every claim/start; this method
   * backs the explicit admin endpoint so the FIRST (or only) stranded job
   * can be recovered without waiting for an unrelated start.
   */
  async reclaimExpired(
    tenantId: string,
  ): Promise<{ reclaimed: InferenceJobDetail[] }> {
    const reclaimed = await this.queue.reclaimExpired(tenantId);
    return { reclaimed };
  }

  async complete(
    tenantId: string,
    jobId: string,
    dto: CompleteInferenceJobDto,
    actor?: AuditActor,
  ): Promise<InferenceJobDetail> {
    assertOpaque('modelKey', dto.modelKey);
    assertOpaque('modelVersion', dto.modelVersion);
    for (const [index, detection] of dto.detections.entries()) {
      // Screen the RAW sku (before uppercasing, which would defeat the
      // case-sensitive secret-token patterns), like the vision service.
      assertOpaque(`detections[${index}].sku`, detection.sku);
      assertOpaque(`detections[${index}].label`, detection.label);
    }
    const job = await this.findById(tenantId, jobId);
    if (job.status !== InferenceJobStatus.RUNNING) {
      throw new ConflictException(
        // PENDING_LINK is non-terminal too (it has not even been published
        // to the queue yet), so it must not be reported as "finished".
        job.status === InferenceJobStatus.QUEUED ||
        job.status === InferenceJobStatus.PENDING_LINK
          ? 'Only a RUNNING job can be completed; start it first'
          : 'This job has already finished (succeeded, failed, or ' +
            'cancelled); terminal jobs never transition again',
      );
    }
    const adapter = this.requireAdapter(
      job.adapterKey ?? SIMULATED_ADAPTER_KEY,
    );
    // The adapter receives the CLAIMED JOB's context (id, tenant, screened
    // trigger descriptor) alongside the model output: a real provider runs
    // from exactly this contract, never from an out-of-band lookup.
    const context: InferenceJobContext = {
      jobId: job.id,
      tenantId: job.tenantId,
      jobType: job.jobType,
      locationId: job.locationId ?? undefined,
      unitId: job.unitId ?? undefined,
      deviceId: job.deviceId ?? undefined,
      sessionId: job.sessionId ?? undefined,
      sourceType: job.sourceType,
      sourceId: job.sourceId ?? undefined,
      inputDescriptor: job.inputDescriptor ?? undefined,
    };
    const input: InferenceAdapterInput = {
      eventType: dto.eventType,
      quantityDelta: dto.quantityDelta,
      occurredAt: dto.occurredAt,
      detections: dto.detections.map((detection) => ({
        sku: detection.sku,
        confidence: detection.confidence,
        label: detection.label,
      })),
      evidenceQuality: dto.evidenceQuality,
      modelKey: dto.modelKey,
      modelVersion: dto.modelVersion,
    };
    adapter.validateInput(context, input);
    const normalized = adapter.normalizeResult(
      await adapter.run(context, input),
    );
    // Fence to the CALLER-observed claim (dto.attempt), never a fresh row
    // read: a stale worker whose lease was reclaimed and re-claimed would
    // otherwise read the NEW attempt here and overwrite the live claim.
    const result = await this.queue.complete(
      tenantId,
      jobId,
      dto.attempt,
      normalized,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.COMPLETE,
          entityType: 'InferenceJob',
          entityId: after.id,
          before,
          after,
          reason: `Inference job completed (${normalized.eventType}, ${normalized.candidates.length} candidate(s))`,
        }),
    );
    if (result === null) {
      throw new NotFoundException(`Inference job "${jobId}" not found`);
    }
    if (result === 'terminal') {
      throw new ConflictException(
        'This job has already finished (succeeded, failed, or cancelled); ' +
          'terminal jobs never transition again',
      );
    }
    if (result === 'lease-superseded') {
      throw new ConflictException(
        'Another attempt has claimed this job since this result was ' +
          'produced; the stale result was not applied',
      );
    }
    if (result === 'not-running' || result === 'not-claimable') {
      throw new ConflictException(
        'Only a RUNNING job can be completed; start it first',
      );
    }
    return result;
  }

  async fail(
    tenantId: string,
    jobId: string,
    dto: FailInferenceJobDto,
    actor?: AuditActor,
  ): Promise<InferenceJobDetail> {
    assertOpaque('errorMessage', dto.errorMessage);
    // 404-before-CAS: the read also keeps NotFound semantics identical to
    // the other transitions. The fence itself uses the CALLER-observed
    // dto.attempt (never this fresh read) — a stale worker whose lease was
    // reclaimed and re-claimed must not fail the attempt that superseded
    // its own.
    const existing = await this.findById(tenantId, jobId);
    // A job still awaiting its downstream link was never published to the
    // queue, so no worker can have run (or failed) it: reporting a failure
    // against it is a controlled 409, not a silent 'terminal' rejection
    // from the CAS. Retiring such a job is cancelOrphanedJob's business.
    if (existing.status === InferenceJobStatus.PENDING_LINK) {
      throw new ConflictException(
        'This job is still pending its downstream link and was never ' +
          'published to the queue, so it cannot be failed; cancel it instead',
      );
    }
    const result = await this.queue.fail(
      tenantId,
      jobId,
      dto.attempt,
      { errorCode: dto.errorCode, errorMessage: dto.errorMessage },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.FAIL,
          entityType: 'InferenceJob',
          entityId: after.id,
          before,
          after,
          reason: `Inference job failed (${dto.errorCode})`,
        }),
    );
    if (result === null) {
      throw new NotFoundException(`Inference job "${jobId}" not found`);
    }
    if (result === 'lease-superseded') {
      throw new ConflictException(
        'Another attempt has claimed this job since this failure was ' +
          'reported; the stale failure was not applied',
      );
    }
    if (typeof result === 'string') {
      throw new ConflictException(
        'This job has already finished (succeeded, failed, or cancelled); ' +
          'terminal jobs never transition again',
      );
    }
    return result;
  }

  /**
   * Converts a SUCCEEDED job's result into a Phase 7 vision event through
   * the EXISTING ingest contract (no duplicated Phase 7 logic): the event
   * lands in PENDING_REVIEW and NEVER touches the basket — only a
   * subsequent approved review decision does. Conversion is one-shot and
   * idempotent: the vision idempotency key is derived from the job id, so
   * re-converting (or racing) replays the original event, and the job
   * stores the link.
   */
  async toVisionEvent(
    tenantId: string,
    jobId: string,
    actor?: AuditActor,
  ): Promise<{
    job: InferenceJobDetail;
    visionEvent: VisionEventDetail;
    replayed: boolean;
  }> {
    const job = await this.findById(tenantId, jobId);
    // The vision route is gated by the `cv` module for its own callers;
    // this endpoint is gated by `inference` — so re-check `cv` FIRST (before
    // the already-linked replay as well as creation), or a tenant with cv
    // disabled could keep creating vision events — or keep READING linked
    // ones — through the inference back door. Fails closed, same semantics
    // as ModuleEnabledGuard.
    const cvEnabled = await this.platformModulesService.isEnabledForTenant(
      tenantId,
      'cv',
    );
    if (!cvEnabled) {
      throw new ForbiddenException(
        'The cv module is not enabled for this tenant, so an inference ' +
          'result cannot become (or replay) a vision event; enable cv first',
      );
    }
    if (job.visionEventId) {
      return {
        job,
        visionEvent: await this.visionEventsService.findById(
          tenantId,
          job.visionEventId,
        ),
        replayed: true,
      };
    }
    if (job.status !== InferenceJobStatus.SUCCEEDED) {
      throw new ConflictException(
        'Only a SUCCEEDED job can convert into a vision event',
      );
    }
    const result = job.result;
    if (!result) {
      throw new ConflictException(
        'The job has no inference result to convert',
      );
    }
    if (!job.locationId || !job.unitId) {
      throw new ConflictException(
        'Conversion requires the job to carry a store and retail unit ' +
          '(locationId and unitId) — the vision ingest contract requires ' +
          'both',
      );
    }
    // Phase 7-compatible ingest payload. occurredAt is the SOURCE-reported
    // interaction time carried on the result — never the completion time,
    // so delayed/queued jobs keep correct event chronology. modelKey/
    // modelVersion stay INTERNAL to the inference result (the Phase 7
    // ingest contract deliberately accepts no provenance strings — same as
    // the Phase 8 mapper, which never emits them); the deterministic
    // idempotency key plus the job's visionEventId link carry the lineage
    // instead.
    const ingestDto = {
      locationId: job.locationId,
      unitId: job.unitId,
      deviceId: job.deviceId ?? undefined,
      sessionId: job.sessionId ?? undefined,
      type: result.eventType,
      occurredAt: result.occurredAt.toISOString(),
      quantity: Math.abs(result.quantityDelta),
      candidates: result.candidates.map((candidate) => ({
        sku: candidate.sku,
        rank: candidate.rank,
        score: candidate.score,
        label: candidate.label ?? undefined,
      })),
      sourceType: job.sourceType,
      evidenceScore: result.evidenceScore ?? undefined,
      evidenceQuality: result.evidenceQuality ?? undefined,
      idempotencyKey: `inference:${job.id}`,
    } as IngestVisionEventDto;
    // The reserved-namespace flag is the trusted-caller channel: the PUBLIC
    // ingest path rejects `inference:` keys wholesale, so a same-tenant
    // client cannot squat a job's derived key ahead of conversion.
    const visionEvent = await this.visionEventsService.ingest(
      tenantId,
      ingestDto,
      actor,
      { allowReservedIdempotencyKey: true },
    );
    // Belt and braces for the idempotent-replay path: if the key already
    // existed (pre-fix data, direct service callers), ingest returned that
    // EXISTING event without comparing payloads. Never link an event that
    // does not match this job's result.
    this.assertReplayedEventMatches(job, result, visionEvent);
    const linked = await this.jobsRepository.linkVisionEvent(
      tenantId,
      job.id,
      visionEvent.id,
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'InferenceJob',
          entityId: after.id,
          before,
          after,
          reason: `Inference result converted to vision event ${visionEvent.id}`,
        }),
    );
    if (linked === null) {
      throw new NotFoundException(`Inference job "${jobId}" not found`);
    }
    if (linked === 'already-linked') {
      // A concurrent conversion won the link race; its ingest and ours
      // resolved to the same event via the derived idempotency key — replay
      // the winner's linkage.
      const current = await this.findById(tenantId, jobId);
      return {
        job: current,
        visionEvent: current.visionEventId
          ? await this.visionEventsService.findById(
              tenantId,
              current.visionEventId,
            )
          : visionEvent,
        replayed: true,
      };
    }
    return { job: linked, visionEvent, replayed: false };
  }

  /**
   * A replayed ingest under the job's derived idempotency key must BE this
   * job's event: same type, magnitude, binding, source, occurrence time,
   * evidence, and ranked candidate list. On any mismatch the conversion
   * aborts (409) without linking — only the foreign event's id is
   * disclosed, never its contents. (Labels are NOT compared: they are
   * display-only snapshots, not decision inputs — rank/sku/score are what
   * a review would apply.)
   */
  private assertReplayedEventMatches(
    job: InferenceJobDetail,
    result: NonNullable<InferenceJobDetail['result']>,
    event: VisionEventDetail,
  ): void {
    const eventCandidates = [...event.candidates].sort(
      (a, b) => a.rank - b.rank,
    );
    const resultCandidates = [...result.candidates].sort(
      (a, b) => a.rank - b.rank,
    );
    const candidatesMatch =
      eventCandidates.length === resultCandidates.length &&
      eventCandidates.every((candidate, index) => {
        const expected = resultCandidates[index];
        return (
          candidate.rank === expected.rank &&
          candidate.sku === expected.sku &&
          (candidate.score ?? null) === expected.score
        );
      });
    const matches =
      candidatesMatch &&
      event.type === result.eventType &&
      event.quantity === Math.abs(result.quantityDelta) &&
      event.occurredAt.getTime() === result.occurredAt.getTime() &&
      (event.evidenceScore ?? null) === (result.evidenceScore ?? null) &&
      (event.evidenceQuality ?? null) === (result.evidenceQuality ?? null) &&
      event.locationId === job.locationId &&
      event.unitId === job.unitId &&
      (event.deviceId ?? null) === (job.deviceId ?? null) &&
      // Strict: an UNBOUND job only matches an UNBOUND event — a session-
      // bound squatted event must never link to (and later apply against)
      // a session the job never referenced.
      (event.sessionId ?? null) === (job.sessionId ?? null) &&
      event.sourceType === job.sourceType;
    if (!matches) {
      throw new ConflictException(
        `Vision event "${event.id}" already exists under this job's ` +
          'reserved idempotency key but does not match the inference ' +
          'result; conversion aborted and the job remains unlinked',
      );
    }
  }

  private requireAdapter(adapterKey: string): InferenceAdapter {
    const adapter = this.adapterRegistry.get(adapterKey);
    if (!adapter) {
      throw new BadRequestException(
        `Unknown inference adapter "${adapterKey}"; registered adapters: ` +
          this.adapterRegistry.keys().join(', '),
      );
    }
    return adapter;
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
