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
} from '../common/sensitive-keys';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { IngestVisionEventDto } from '../vision/dto/ingest-vision-event.dto';
import { VisionEventDetail } from '../vision/vision-events.repository';
import { VisionEventsService } from '../vision/vision-events.service';
import {
  InferenceAdapter,
  InferenceAdapterInput,
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
import { findForbiddenMediaPath } from './media-policy';
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
  const mediaPath = findForbiddenMediaPath(descriptor);
  if (mediaPath) {
    throw new BadRequestException(
      `inputDescriptor.${mediaPath} is not accepted: raw media, media/` +
        `storage URLs, signed URLs, and artifact descriptors are out of ` +
        `scope for Phase 9 MVP — reference crops/zones/frames by id only.`,
    );
  }
  const sensitivePath = findSensitiveKeyPath(descriptor);
  if (sensitivePath) {
    throw new BadRequestException(
      `inputDescriptor.${sensitivePath} must not carry credential- or ` +
        `payment-bearing content. Secrets belong in a dedicated secret ` +
        `store, and payment data must never be stored.`,
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

  async create(
    tenantId: string,
    dto: CreateInferenceJobDto,
    actor?: AuditActor,
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
        },
        (job) =>
          this.auditEntry(tenantId, actor, {
            action: AuditAction.CREATE,
            entityType: 'InferenceJob',
            entityId: job.id,
            after: job,
            reason: `Inference job queued (${job.jobType})`,
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
    return result.job;
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
    if (result === 'not-claimable' || result === 'not-running') {
      throw new ConflictException(
        'Only a QUEUED job can be started; this job is already running',
      );
    }
    return result;
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
        job.status === InferenceJobStatus.QUEUED
          ? 'Only a RUNNING job can be completed; start it first'
          : 'This job has already finished (succeeded, failed, or ' +
            'cancelled); terminal jobs never transition again',
      );
    }
    const adapter = this.requireAdapter(
      job.adapterKey ?? SIMULATED_ADAPTER_KEY,
    );
    const input: InferenceAdapterInput = {
      jobType: job.jobType,
      eventType: dto.eventType,
      quantityDelta: dto.quantityDelta,
      detections: dto.detections.map((detection) => ({
        sku: detection.sku,
        confidence: detection.confidence,
        label: detection.label,
      })),
      evidenceQuality: dto.evidenceQuality,
      modelKey: dto.modelKey,
      modelVersion: dto.modelVersion,
    };
    adapter.validateInput(input);
    const normalized = adapter.normalizeResult(await adapter.run(input));
    const result = await this.queue.complete(
      tenantId,
      jobId,
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
    const result = await this.queue.fail(
      tenantId,
      jobId,
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
    // The vision route is gated by the `cv` module for its own callers;
    // this endpoint is gated by `inference` — so re-check `cv` here, or a
    // tenant with cv disabled could keep creating vision events through
    // the inference back door. Fails closed, same semantics as
    // ModuleEnabledGuard.
    const cvEnabled = await this.platformModulesService.isEnabledForTenant(
      tenantId,
      'cv',
    );
    if (!cvEnabled) {
      throw new ForbiddenException(
        'The cv module is not enabled for this tenant, so an inference ' +
          'result cannot become a vision event; enable cv first',
      );
    }
    // Phase 7-compatible ingest payload. modelKey/modelVersion stay
    // INTERNAL to the inference result (the Phase 7 ingest contract
    // deliberately accepts no provenance strings — same as the Phase 8
    // mapper, which never emits them); the deterministic idempotency key
    // plus the job's visionEventId link carry the lineage instead.
    const ingestDto = {
      locationId: job.locationId,
      unitId: job.unitId,
      deviceId: job.deviceId ?? undefined,
      sessionId: job.sessionId ?? undefined,
      type: result.eventType,
      occurredAt: (job.completedAt ?? job.requestedAt).toISOString(),
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
    const visionEvent = await this.visionEventsService.ingest(
      tenantId,
      ingestDto,
      actor,
    );
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
