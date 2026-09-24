import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  AuditAction,
  EslGateway,
  EslGatewayStatus,
  EslLabel,
  EslLabelStatus,
  EslUpdateErrorCode,
  EslUpdateJob,
  EslUpdateTrigger,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { findSensitiveKeyPath } from '../common/sensitive-keys';
import {
  PriceActivationEvent,
  PriceActivationHub,
  PriceActivationListener,
} from '../pricing/price-activation.hub';
import { PriceResolutionService } from '../pricing/price-resolution.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  CreateGatewayDto,
  QueryGatewaysDto,
  QueryJobsDto,
  QueryLabelsDto,
  RegisterLabelDto,
  UpdateGatewayDto,
  UpdateLabelDto,
} from './dto/esl.dto';
import {
  ESL_DEFAULT_TAKE,
  ESL_PROCESS_MAX_BATCH,
} from './esl.constants';
import {
  activationIdempotencyKey,
  alreadyRendered,
  clampPercent,
  contentHash,
  manualIdempotencyKey,
  normalizeGatewayCode,
  normalizeVendorCode,
  reconciliationIdempotencyKey,
} from './esl.logic';
import {
  EnqueueJobInput,
  EslGatewayDetail,
  EslLabelDetail,
  EslRepository,
  EslUpdateJobDetail,
  GatewayRejection,
  LabelRejection,
} from './esl.repository';
import {
  ESL_VENDOR_REGISTRY,
  EslGatewayContext,
  EslLabelContent,
  EslPushOutcome,
  EslPushRequest,
  EslVendorRegistryPort,
} from './ports';

/** Outcome of one processing pass, returned to the operator. */
export interface EslProcessSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  requeued: number;
  leaseReclaimed: number;
  leaseFailed: number;
}

/**
 * A vendor's own error text is written to the job row and shown to operators.
 * It could echo an endpoint or a token, so it is screened with the same
 * strict free-text predicate the camera and pricing modules use, and dropped
 * (not redacted in place) when it fails.
 */
function safeVendorMessage(message: string | undefined): string | null {
  if (!message) {
    return null;
  }
  const trimmed = message.trim().slice(0, 300);
  return containsSensitiveFreeText(trimmed) ? null : trimmed;
}

@Injectable()
export class EslService implements OnModuleInit, PriceActivationListener {
  private readonly logger = new Logger(EslService.name);

  constructor(
    private readonly repository: EslRepository,
    private readonly prices: PriceResolutionService,
    private readonly activationHub: PriceActivationHub,
    @Inject(ESL_VENDOR_REGISTRY)
    private readonly vendors: EslVendorRegistryPort,
  ) {}

  /**
   * Subscribing at bootstrap — rather than pricing injecting this service —
   * is what keeps the dependency one-way and the module graph acyclic.
   */
  onModuleInit(): void {
    this.activationHub.register(this);
  }

  // ------------------------------------------------------------- gateways

  vendorCodes(): string[] {
    return this.vendors.vendorCodes();
  }

  async createGateway(
    tenantId: string,
    dto: CreateGatewayDto,
    actor: AuditActor,
  ): Promise<EslGatewayDetail> {
    const vendorCode = normalizeVendorCode(dto.vendorCode);
    if (!this.vendors.resolve(vendorCode)) {
      throw new BadRequestException(
        `No ESL adapter is registered for vendor "${vendorCode}"`,
      );
    }
    this.assertSafeCredentialRef(dto.credentialRef);
    const metadata = this.assertSafeMetadata(dto.metadata);
    const result = await this.repository.createGateway(
      tenantId,
      {
        code: normalizeGatewayCode(dto.code),
        name: dto.name.trim(),
        vendorCode,
        locationId: dto.locationId,
        credentialRef: dto.credentialRef?.trim() ?? null,
        ...(metadata === undefined ? {} : { metadata }),
        createdById: actor.id,
      },
      (gateway) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'EslGateway',
          entityId: gateway.id,
          after: this.gatewaySnapshot(gateway),
          reason: `ESL gateway ${gateway.code} registered (${gateway.vendorCode})`,
        }),
    );
    return this.unwrapGateway(result);
  }

  async findGateways(
    tenantId: string,
    query: QueryGatewaysDto,
  ): Promise<{ items: EslGatewayDetail[]; total: number }> {
    return this.repository.findGateways(
      tenantId,
      {
        ...(query.status ? { status: query.status as EslGatewayStatus } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      { skip: query.skip ?? 0, take: query.take ?? ESL_DEFAULT_TAKE },
    );
  }

  async findGatewayById(
    tenantId: string,
    id: string,
  ): Promise<EslGatewayDetail> {
    const gateway = await this.repository.findGatewayById(tenantId, id);
    if (!gateway) {
      throw new NotFoundException('ESL gateway not found');
    }
    return gateway;
  }

  async updateGateway(
    tenantId: string,
    id: string,
    dto: UpdateGatewayDto,
    actor: AuditActor,
  ): Promise<EslGatewayDetail> {
    this.assertSafeCredentialRef(dto.credentialRef);
    const metadata = this.assertSafeMetadata(dto.metadata);
    const result = await this.repository.updateGateway(
      tenantId,
      id,
      {
        ...(dto.name === undefined ? {} : { name: dto.name.trim() }),
        ...(dto.status === undefined
          ? {}
          : { status: dto.status as EslGatewayStatus }),
        ...(dto.credentialRef === undefined
          ? {}
          : { credentialRef: dto.credentialRef.trim() }),
        ...(metadata === undefined ? {} : { metadata }),
      },
      (before, after) =>
        this.audit(tenantId, actor, {
          action:
            dto.status === undefined
              ? AuditAction.UPDATE
              : dto.status === 'DISABLED'
                ? AuditAction.DISABLE
                : AuditAction.ENABLE,
          entityType: 'EslGateway',
          entityId: after.id,
          before: this.gatewaySnapshot(before),
          after: this.gatewaySnapshot(after),
          reason: `ESL gateway ${after.code} updated`,
        }),
    );
    return this.unwrapGateway(result);
  }

  /**
   * Asks the vendor which labels it can see and registers them. Re-running is
   * safe: a known label has its health refreshed and its binding untouched.
   */
  async discoverLabels(
    tenantId: string,
    gatewayId: string,
    actor: AuditActor,
  ): Promise<{ registered: number; labels: EslLabelDetail[] }> {
    const gateway = await this.findGatewayById(tenantId, gatewayId);
    const adapter = this.vendors.resolve(gateway.vendorCode);
    if (!adapter) {
      throw new BadRequestException(
        `No ESL adapter is registered for vendor "${gateway.vendorCode}"`,
      );
    }
    let discovered;
    try {
      discovered = await adapter.discoverLabels(this.contextFor(gateway));
    } catch (error) {
      await this.repository.touchGatewaySeen(
        tenantId,
        gatewayId,
        EslGatewayStatus.UNREACHABLE,
      );
      this.logger.warn(
        `ESL discovery failed for gateway ${gateway.code}: ` +
          `${error instanceof Error ? error.name : 'UnknownError'}`,
      );
      throw new ConflictException('The ESL gateway could not be reached');
    }
    const labels: EslLabelDetail[] = [];
    for (const found of discovered) {
      const result = await this.repository.upsertLabel(
        tenantId,
        gatewayId,
        {
          vendorLabelId: found.vendorLabelId,
          batteryPercent: clampPercent(found.batteryPercent),
          signalPercent: clampPercent(found.signalPercent),
          createdById: actor.id,
        },
        (label, created) =>
          this.audit(tenantId, actor, {
            action: created ? AuditAction.REGISTER : AuditAction.UPDATE,
            entityType: 'EslLabel',
            entityId: label.id,
            after: this.labelSnapshot(label),
            reason: created
              ? `ESL label ${label.vendorLabelId} discovered on ${gateway.code}`
              : `ESL label ${label.vendorLabelId} health refreshed`,
          }),
      );
      labels.push(this.unwrapLabel(result));
    }
    await this.repository.touchGatewaySeen(
      tenantId,
      gatewayId,
      EslGatewayStatus.ACTIVE,
    );
    return { registered: labels.length, labels };
  }

  // --------------------------------------------------------------- labels

  async registerLabel(
    tenantId: string,
    gatewayId: string,
    dto: RegisterLabelDto,
    actor: AuditActor,
  ): Promise<EslLabelDetail> {
    const result = await this.repository.upsertLabel(
      tenantId,
      gatewayId,
      {
        vendorLabelId: dto.vendorLabelId,
        batteryPercent: null,
        signalPercent: null,
        createdById: actor.id,
      },
      (label, created) =>
        this.audit(tenantId, actor, {
          action: created ? AuditAction.REGISTER : AuditAction.UPDATE,
          entityType: 'EslLabel',
          entityId: label.id,
          after: this.labelSnapshot(label),
          reason: `ESL label ${label.vendorLabelId} registered manually`,
        }),
    );
    return this.unwrapLabel(result);
  }

  findLabels(
    tenantId: string,
    query: QueryLabelsDto,
  ): Promise<{ items: EslLabelDetail[]; total: number }> {
    return this.repository.findLabels(
      tenantId,
      {
        ...(query.gatewayId ? { gatewayId: query.gatewayId } : {}),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.status ? { status: query.status as EslLabelStatus } : {}),
      },
      { skip: query.skip ?? 0, take: query.take ?? ESL_DEFAULT_TAKE },
    );
  }

  async findLabelById(tenantId: string, id: string): Promise<EslLabelDetail> {
    const label = await this.repository.findLabelById(tenantId, id);
    if (!label) {
      throw new NotFoundException('ESL label not found');
    }
    return label;
  }

  /**
   * Binding a label queues a render, because a freshly bound label is showing
   * nothing (or someone else's price) until it is pushed.
   */
  async updateLabel(
    tenantId: string,
    id: string,
    dto: UpdateLabelDto,
    actor: AuditActor,
  ): Promise<EslLabelDetail> {
    const result = await this.repository.updateLabel(
      tenantId,
      id,
      {
        ...(dto.productId === undefined
          ? {}
          : { productId: dto.productId ?? null }),
        ...(dto.cellAssignmentId === undefined
          ? {}
          : { cellAssignmentId: dto.cellAssignmentId ?? null }),
        ...(dto.status === undefined
          ? {}
          : { status: dto.status as EslLabelStatus }),
      },
      (before, after) =>
        this.audit(tenantId, actor, {
          action:
            after.status === EslLabelStatus.RETIRED
              ? AuditAction.CANCEL
              : AuditAction.UPDATE,
          entityType: 'EslLabel',
          entityId: after.id,
          before: this.labelSnapshot(before),
          after: this.labelSnapshot(after),
          reason: `ESL label ${after.vendorLabelId} ${
            after.status === EslLabelStatus.RETIRED ? 'retired' : 'rebound'
          }`,
        }),
    );
    const label = this.unwrapLabel(result);
    if (label.status === EslLabelStatus.BOUND) {
      await this.enqueueForLabels(
        tenantId,
        [label],
        EslUpdateTrigger.LABEL_BOUND,
        null,
        actor.id,
      );
    }
    return label;
  }

  /** Operator-forced re-render, for a label an engineer has just replaced. */
  async requestRender(
    tenantId: string,
    labelId: string,
    actor: AuditActor,
  ): Promise<{ enqueued: number }> {
    const label = await this.findLabelById(tenantId, labelId);
    if (label.status !== EslLabelStatus.BOUND) {
      throw new ConflictException(
        'Only a BOUND label can be rendered — bind a product first',
      );
    }
    const enqueued = await this.enqueueForLabels(
      tenantId,
      [label],
      EslUpdateTrigger.MANUAL_RERENDER,
      null,
      actor.id,
    );
    return { enqueued };
  }

  // ----------------------------------------------------------------- jobs

  findJobs(
    tenantId: string,
    query: QueryJobsDto,
  ): Promise<{ items: EslUpdateJobDetail[]; total: number }> {
    return this.repository.findJobs(
      tenantId,
      {
        ...(query.status ? { status: query.status } : {}),
        ...(query.labelId ? { labelId: query.labelId } : {}),
        ...(query.gatewayId ? { gatewayId: query.gatewayId } : {}),
      },
      { skip: query.skip ?? 0, take: query.take ?? ESL_DEFAULT_TAKE },
    );
  }

  /**
   * The price-activation subscriber. Runs after the activation transaction
   * has committed and must never throw back into pricing — the hub isolates
   * failures, and anything missed here is repaired by reconcile().
   */
  async onVersionActivated(event: PriceActivationEvent): Promise<void> {
    const labels = await this.repository.findBoundLabelsForProducts(
      event.tenantId,
      event.productIds,
      event.locationId,
    );
    if (labels.length === 0) {
      return;
    }
    const details: EslLabelDetail[] = [];
    for (const row of labels) {
      const label = await this.repository.findLabelById(
        event.tenantId,
        row.id,
      );
      if (label) {
        details.push(label);
      }
    }
    await this.enqueueForLabels(
      event.tenantId,
      details,
      EslUpdateTrigger.PRICE_ACTIVATION,
      event.priceBookVersionId,
      null,
    );
  }

  /**
   * Repairs drift: any bound label whose rendered content is not what the
   * price in force says it should be gets a job. This is what makes the
   * best-effort activation hand-off safe — a listener that was down when a
   * price changed is caught here.
   *
   * `actor` is null when the sweep is the background runner's rather than an
   * operator's, exactly as the price-activation listener enqueues with no
   * creator: the jobs are the system's, and attributing them to a user who
   * did not ask for them would be a lie in the audit trail.
   */
  async reconcile(
    tenantId: string,
    actor: AuditActor | null,
  ): Promise<{ inspected: number; enqueued: number }> {
    const labels = await this.repository.findAllBoundLabels(tenantId);
    const stale: EslLabelDetail[] = [];
    for (const label of labels) {
      const desired = await this.resolveContent(tenantId, label);
      if (!desired) {
        continue;
      }
      if (!alreadyRendered(label.renderedContentHash, desired.hash)) {
        stale.push(label);
      }
    }
    const enqueued = await this.enqueueForLabels(
      tenantId,
      stale,
      EslUpdateTrigger.RECONCILIATION,
      null,
      actor?.id ?? null,
    );
    return { inspected: labels.length, enqueued };
  }

  async reclaimExpired(
    tenantId: string,
  ): Promise<{ requeued: number; failed: number }> {
    return this.repository.reclaimExpired(tenantId);
  }

  /**
   * One processing pass: recover stranded work, claim a batch, push it to the
   * vendors a gateway at a time, and record each label's outcome on its own.
   * A failing label never blocks another, and a failing GATEWAY fails only
   * its own labels.
   */
  async processBatch(
    tenantId: string,
    limit: number = ESL_DEFAULT_TAKE,
  ): Promise<EslProcessSummary> {
    const reclaimed = await this.repository.reclaimExpired(tenantId);
    const jobs = await this.repository.claimBatch(
      tenantId,
      Math.min(limit, ESL_PROCESS_MAX_BATCH),
    );
    const summary: EslProcessSummary = {
      claimed: jobs.length,
      succeeded: 0,
      failed: 0,
      requeued: 0,
      leaseReclaimed: reclaimed.requeued,
      leaseFailed: reclaimed.failed,
    };
    const byGateway = new Map<string, EslUpdateJobDetail[]>();
    for (const job of jobs) {
      const bucket = byGateway.get(job.gatewayId) ?? [];
      bucket.push(job);
      byGateway.set(job.gatewayId, bucket);
    }
    for (const [gatewayId, batch] of byGateway) {
      await this.processGatewayBatch(tenantId, gatewayId, batch, summary);
    }
    return summary;
  }

  private async processGatewayBatch(
    tenantId: string,
    gatewayId: string,
    jobs: EslUpdateJobDetail[],
    summary: EslProcessSummary,
  ): Promise<void> {
    const gateway = await this.repository.findGatewayById(tenantId, gatewayId);
    if (!gateway) {
      await this.failAll(
        tenantId,
        jobs,
        EslUpdateErrorCode.GATEWAY_UNREACHABLE,
        null,
        summary,
      );
      return;
    }
    if (gateway.status === EslGatewayStatus.DISABLED) {
      await this.failAll(
        tenantId,
        jobs,
        EslUpdateErrorCode.GATEWAY_DISABLED,
        null,
        summary,
      );
      return;
    }
    const adapter = this.vendors.resolve(gateway.vendorCode);
    if (!adapter) {
      await this.failAll(
        tenantId,
        jobs,
        EslUpdateErrorCode.UNKNOWN_VENDOR,
        null,
        summary,
      );
      return;
    }

    // Resolve what each label should show NOW, not what it should have shown
    // when the job was queued: between enqueue and push the price may have
    // moved again, and the shelf must end up showing the truth.
    const requests: EslPushRequest[] = [];
    // Keyed by vendor label id, which is unique WITHIN a gateway — and a
    // batch is always one gateway's. The value holds a LIST of jobs because
    // one label can legitimately carry two claimed jobs in the same pass (a
    // binding and an activation, say). They want the identical content, so
    // the label is pushed once and every job for it takes that one outcome;
    // keeping only the last would strand the others RUNNING until their
    // leases expired.
    const pending = new Map<
      string,
      { jobs: EslUpdateJobDetail[]; hash: string; versionId: string | null }
    >();
    for (const job of jobs) {
      const label = await this.repository.findLabelById(tenantId, job.labelId);
      if (!label || label.status !== EslLabelStatus.BOUND) {
        await this.failOne(
          tenantId,
          job,
          EslUpdateErrorCode.LABEL_RETIRED,
          null,
          summary,
        );
        continue;
      }
      const desired = await this.resolveContent(tenantId, label);
      if (!desired) {
        await this.failOne(
          tenantId,
          job,
          EslUpdateErrorCode.CONTENT_UNRESOLVABLE,
          null,
          summary,
        );
        continue;
      }
      if (alreadyRendered(label.renderedContentHash, desired.hash)) {
        // Already correct: a replayed activation, or a sweep that raced a
        // successful push. Recorded as success, because the shelf IS right.
        await this.completeOne(tenantId, job, null, summary);
        continue;
      }
      const existing = pending.get(label.vendorLabelId);
      if (existing) {
        existing.jobs.push(job);
        continue;
      }
      requests.push({
        vendorLabelId: label.vendorLabelId,
        content: desired.content,
      });
      pending.set(label.vendorLabelId, {
        jobs: [job],
        hash: desired.hash,
        versionId: desired.priceBookVersionId,
      });
    }
    if (requests.length === 0) {
      return;
    }

    let outcomes: EslPushOutcome[];
    try {
      outcomes = await adapter.pushBatch(this.contextFor(gateway), requests);
    } catch (error) {
      // The gateway itself failed. Every label in this batch is retried; the
      // error class alone is logged, never the vendor's message.
      this.logger.warn(
        `ESL push failed for gateway ${gateway.code}: ` +
          `${error instanceof Error ? error.name : 'UnknownError'}`,
      );
      await this.repository.touchGatewaySeen(
        tenantId,
        gatewayId,
        EslGatewayStatus.UNREACHABLE,
      );
      await this.failAll(
        tenantId,
        [...pending.values()].flatMap((entry) => entry.jobs),
        EslUpdateErrorCode.GATEWAY_UNREACHABLE,
        null,
        summary,
      );
      return;
    }
    await this.repository.touchGatewaySeen(
      tenantId,
      gatewayId,
      EslGatewayStatus.ACTIVE,
    );

    const answered = new Set<string>();
    for (const outcome of outcomes) {
      const entry = pending.get(outcome.vendorLabelId);
      if (!entry) {
        continue;
      }
      if (answered.has(outcome.vendorLabelId)) {
        // An adapter that answered twice for one label does not get to write
        // the outcome twice; the first answer stands.
        continue;
      }
      answered.add(outcome.vendorLabelId);
      for (const job of entry.jobs) {
        if (outcome.ok) {
          await this.completeOne(
            tenantId,
            job,
            {
              contentHash: entry.hash,
              priceBookVersionId: entry.versionId,
              batteryPercent: clampPercent(outcome.label?.batteryPercent),
              signalPercent: clampPercent(outcome.label?.signalPercent),
            },
            summary,
          );
        } else {
          await this.failOne(
            tenantId,
            job,
            outcome.errorCode,
            safeVendorMessage(outcome.message),
            summary,
          );
        }
      }
    }
    // An adapter that returns fewer outcomes than requests has not answered
    // for some labels. Those are retried rather than silently dropped.
    for (const [vendorLabelId, entry] of pending) {
      if (!answered.has(vendorLabelId)) {
        for (const job of entry.jobs) {
          await this.failOne(
            tenantId,
            job,
            EslUpdateErrorCode.VENDOR_TIMEOUT,
            null,
            summary,
          );
        }
      }
    }
  }

  // ------------------------------------------------------------- internals

  /** What a label should show, plus its fingerprint. Null when no price. */
  private async resolveContent(
    tenantId: string,
    label: EslLabelDetail,
  ): Promise<{
    content: EslLabelContent;
    hash: string;
    priceBookVersionId: string | null;
  } | null> {
    if (!label.product) {
      return null;
    }
    const locations = await this.repository.findLabelLocations(tenantId, [
      label.id,
    ]);
    const price = await this.prices.resolve(
      tenantId,
      label.product.id,
      new Date(),
      locations.get(label.id) ?? null,
    );
    if (!price) {
      return null;
    }
    const content: EslLabelContent = {
      sku: label.product.sku,
      productName: label.product.name,
      unitPriceMinor: price.unitPriceMinor,
      currencyCode: price.currencyCode,
    };
    return {
      content,
      hash: contentHash(content),
      priceBookVersionId: price.priceBookVersionId,
    };
  }

  private async enqueueForLabels(
    tenantId: string,
    labels: readonly EslLabelDetail[],
    trigger: EslUpdateTrigger,
    priceBookVersionId: string | null,
    createdById: string | null,
  ): Promise<number> {
    const inputs: EnqueueJobInput[] = [];
    for (const label of labels) {
      const desired = await this.resolveContent(tenantId, label);
      if (!desired) {
        continue;
      }
      inputs.push({
        labelId: label.id,
        gatewayId: label.gatewayId,
        trigger,
        priceBookVersionId:
          priceBookVersionId ?? desired.priceBookVersionId ?? null,
        contentHash: desired.hash,
        idempotencyKey: this.idempotencyKey(
          trigger,
          label.id,
          priceBookVersionId,
          desired.hash,
        ),
        createdById,
      });
    }
    return this.repository.enqueueJobs(tenantId, inputs);
  }

  private idempotencyKey(
    trigger: EslUpdateTrigger,
    labelId: string,
    priceBookVersionId: string | null,
    hash: string,
  ): string {
    if (trigger === EslUpdateTrigger.PRICE_ACTIVATION && priceBookVersionId) {
      return activationIdempotencyKey(priceBookVersionId, labelId);
    }
    if (trigger === EslUpdateTrigger.RECONCILIATION) {
      // Keyed by the CONTENT: a repeated sweep that sees the same drift adds
      // nothing, but a genuinely new divergence gets its own job.
      return reconciliationIdempotencyKey(labelId, hash);
    }
    // An operator asking twice means it twice, so these never de-duplicate.
    return manualIdempotencyKey(labelId, randomUUID());
  }

  private async completeOne(
    tenantId: string,
    job: EslUpdateJobDetail,
    render: {
      contentHash: string;
      priceBookVersionId: string | null;
      batteryPercent: number | null;
      signalPercent: number | null;
    } | null,
    summary: EslProcessSummary,
  ): Promise<void> {
    const result = await this.repository.completeJob(
      tenantId,
      job.id,
      job.claimedAttempt ?? job.attempts,
      render,
      (before, after) =>
        this.systemAudit(tenantId, {
          action: AuditAction.COMPLETE,
          entityType: 'EslUpdateJob',
          entityId: after.id,
          before: this.jobSnapshot(before),
          after: this.jobSnapshot(after),
          reason: render
            ? 'ESL label rendered'
            : 'ESL label already showed the current price',
        }),
    );
    if (typeof result === 'string') {
      this.logger.warn(`ESL job ${job.id} could not complete: ${result}`);
      return;
    }
    summary.succeeded += 1;
  }

  private async failOne(
    tenantId: string,
    job: EslUpdateJobDetail,
    code: EslUpdateErrorCode,
    message: string | null,
    summary: EslProcessSummary,
  ): Promise<void> {
    const result = await this.repository.failJob(
      tenantId,
      job.id,
      job.claimedAttempt ?? job.attempts,
      { code, message },
      (before, after) =>
        this.systemAudit(tenantId, {
          action: AuditAction.FAIL,
          entityType: 'EslUpdateJob',
          entityId: after.id,
          before: this.jobSnapshot(before),
          after: this.jobSnapshot(after),
          reason: `ESL push failed (${code})`,
        }),
    );
    if (typeof result === 'string') {
      this.logger.warn(`ESL job ${job.id} could not fail cleanly: ${result}`);
      return;
    }
    if (result.status === 'FAILED') {
      summary.failed += 1;
    } else {
      summary.requeued += 1;
    }
  }

  private async failAll(
    tenantId: string,
    jobs: readonly EslUpdateJobDetail[],
    code: EslUpdateErrorCode,
    message: string | null,
    summary: EslProcessSummary,
  ): Promise<void> {
    for (const job of jobs) {
      await this.failOne(tenantId, job, code, message, summary);
    }
  }

  private contextFor(gateway: EslGatewayDetail): EslGatewayContext {
    return {
      gatewayCode: gateway.code,
      vendorCode: gateway.vendorCode,
      credentialRef: gateway.credentialRef,
      metadata:
        gateway.metadata && typeof gateway.metadata === 'object'
          ? (gateway.metadata as Record<string, unknown>)
          : null,
    };
  }

  /**
   * `credentialRef` names a secret; it must never BE one. Rejecting rather
   * than redacting is deliberate: a silently blanked reference would leave a
   * gateway that cannot authenticate and an operator with no explanation.
   */
  private assertSafeCredentialRef(value: string | undefined): void {
    if (value && containsSensitiveFreeText(value)) {
      throw new BadRequestException(
        'credentialRef names a credential in configuration — it must not ' +
          'contain the credential itself',
      );
    }
  }

  private assertSafeMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Prisma.InputJsonValue | undefined {
    if (metadata === undefined) {
      return undefined;
    }
    const offending = findSensitiveKeyPath(metadata);
    if (offending) {
      throw new BadRequestException(
        `metadata must not carry credential- or payment-bearing values ` +
          `(offending path: ${offending})`,
      );
    }
    return metadata as Prisma.InputJsonValue;
  }

  /** Snapshots exclude credentialRef so it can never reach an audit row. */
  private gatewaySnapshot(gateway: EslGateway): Record<string, unknown> {
    return {
      id: gateway.id,
      code: gateway.code,
      name: gateway.name,
      vendorCode: gateway.vendorCode,
      locationId: gateway.locationId,
      status: gateway.status,
      hasCredentialRef: gateway.credentialRef !== null,
    };
  }

  private labelSnapshot(label: EslLabel): Record<string, unknown> {
    return {
      id: label.id,
      gatewayId: label.gatewayId,
      vendorLabelId: label.vendorLabelId,
      productId: label.productId,
      cellAssignmentId: label.cellAssignmentId,
      status: label.status,
      renderedVersionId: label.renderedVersionId,
    };
  }

  private jobSnapshot(job: EslUpdateJob): Record<string, unknown> {
    return {
      id: job.id,
      labelId: job.labelId,
      gatewayId: job.gatewayId,
      trigger: job.trigger,
      status: job.status,
      attempts: job.attempts,
      lastErrorCode: job.lastErrorCode,
    };
  }

  private audit(
    tenantId: string,
    actor: AuditActor,
    entry: Omit<AuditEntry, 'tenantId' | 'actorId' | 'actorEmail'>,
  ): AuditEntry {
    return {
      ...entry,
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
    };
  }

  /** Queue transitions have no human actor — the processor made them. */
  private systemAudit(
    tenantId: string,
    entry: Omit<AuditEntry, 'tenantId' | 'actorId' | 'actorEmail'>,
  ): AuditEntry {
    return {
      ...entry,
      tenantId,
      actorId: null,
      actorEmail: SYSTEM_ACTOR_EMAIL,
    };
  }

  private unwrapGateway(
    result: EslGatewayDetail | GatewayRejection,
  ): EslGatewayDetail {
    if (typeof result !== 'string') {
      return result;
    }
    switch (result) {
      case 'code-taken':
        throw new ConflictException(
          'An ESL gateway with that code already exists in this tenant',
        );
      case 'location-not-found':
        throw new NotFoundException('Location not found in this tenant');
      case 'gateway-not-found':
        throw new NotFoundException('ESL gateway not found');
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled gateway rejection: ${String(exhaustive)}`);
      }
    }
  }

  private unwrapLabel(
    result: EslLabelDetail | LabelRejection,
  ): EslLabelDetail {
    if (typeof result !== 'string') {
      return result;
    }
    switch (result) {
      case 'gateway-not-found':
        throw new NotFoundException('ESL gateway not found');
      case 'label-not-found':
        throw new NotFoundException('ESL label not found');
      case 'label-retired':
        throw new ConflictException(
          'A RETIRED label cannot be changed — register the replacement ' +
            'hardware instead',
        );
      case 'product-not-found':
        throw new NotFoundException('Product not found in this tenant');
      case 'cell-not-found':
        throw new NotFoundException(
          'Planogram cell assignment not found in this tenant',
        );
      default: {
        const exhaustive: never = result;
        throw new Error(`Unhandled label rejection: ${String(exhaustive)}`);
      }
    }
  }
}
