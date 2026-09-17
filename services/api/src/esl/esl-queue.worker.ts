import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PrismaService } from '../prisma/prisma.service';
import { EslQueueConfig } from './esl-queue.config';
import { ESL_MODULE_CODE } from './esl.constants';
import { EslService } from './esl.service';

/**
 * The thing that makes the ESL queue actually drain.
 *
 * WHY IT EXISTS. `POST /esl/update-jobs/process` and `POST /esl/reconcile`
 * are the operations; until this class there was no CLOCK behind either.
 * The consequence was silent divergence, which is the exact failure the ESL
 * phase exists to prevent: an operator activates a price, checkout charges
 * the new one immediately, and the shelf label keeps showing the old one
 * with no error anywhere until a human remembers to POST to that route.
 *
 * WHAT IT IS NOT. It is not a second queue, a second claim protocol or a
 * second failure vocabulary. Every sweep calls the SAME service methods an
 * operator drives by hand, so the lease, the attempt budget, the fencing
 * token, the backoff and the audit trail are the ones Phase 28 already
 * shipped. Nothing here bypasses them, and a deployment that prefers an
 * external scheduler can leave this off and keep hitting the routes.
 *
 * SHAPE (deliberately the same as PickupDetectionWorker, the repository's
 * existing precedent for background work):
 *   * `setInterval` + `.unref()` — polling must never hold the process (or a
 *     jest worker) open.
 *   * OFF by default behind one env flag, forced off in every test process.
 *   * Tenant enumeration from the platform-scoped Tenant table; every query
 *     underneath is scoped to ONE tenantId.
 *   * One `try` per tenant, so a tenant that throws costs that tenant only.
 *   * A re-entrancy guard, so a slow sweep cannot stack on the next tick.
 */
@Injectable()
export class EslQueueWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EslQueueWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  /**
   * When each tenant last completed a reconciliation pass. Reconciliation
   * reads every bound label and resolves the price in force for each, so it
   * runs on its own slow clock rather than every sweep.
   *
   * Stamped only on SUCCESS: a tenant whose reconcile threw is due again on
   * the very next sweep instead of waiting out a whole interval. In-memory
   * on purpose — a restart merely grants one extra pass — and pruned to the
   * live tenant set each sweep so a deleted tenant cannot leak an entry.
   */
  private readonly lastReconciledAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: EslQueueConfig,
    private readonly esl: EslService,
    private readonly platformModules: PlatformModulesService,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, this.config.sweepIntervalMs);
    // Never keep the process alive just to poll.
    this.timer.unref();
    this.logger.log(
      `ESL queue worker active (every ${this.config.sweepIntervalMs} ms, ` +
        `up to ${this.config.batchSize} jobs per tenant, reconciling every ` +
        `${Math.round(this.config.reconcileIntervalMs / 1000)} s)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep: drain every ESL-enabled active tenant's queue, and repair
   * drift for those whose reconciliation is due.
   *
   * Never rejects. The interval callback has nowhere to put a rejection, and
   * this repository treats an unhandled rejection from a background timer as
   * a crash, so both the per-tenant body and the sweep as a whole are
   * wrapped.
   */
  async sweepOnce(): Promise<void> {
    if (this.sweeping) {
      // A previous sweep is still running — a slow vendor, a big backlog, a
      // stalled database. Ticks are dropped rather than queued: stacking
      // sweeps would claim the same jobs twice over and multiply the load
      // that made the sweep slow in the first place.
      return;
    }
    this.sweeping = true;
    try {
      // Candidate tenants come from the platform-scoped Tenant table, never
      // from a cross-tenant scan of tenant data: every job, label and gateway
      // read below happens inside a single-tenant service call. Only ACTIVE
      // tenants are candidates — a suspended or archived tenant must not have
      // hardware pushed on its behalf.
      const tenants = await this.prisma.tenant.findMany({
        where: { status: TenantStatus.ACTIVE },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      this.pruneReconcileCursors(tenants.map(({ id }) => id));
      for (const { id } of tenants) {
        await this.sweepTenant(id);
      }
    } catch (error) {
      // Enumeration itself failed (e.g. a transient database outage). Log
      // and retry on the next tick.
      this.logger.warn(`ESL sweep failed: ${describe(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * One tenant's turn. Isolated from every other tenant's: anything thrown
   * in here is logged and the sweep moves on, because a queue wedged in one
   * tenant must never stop another tenant's shelves from being corrected.
   *
   * Gateway-level isolation is NOT re-implemented here — `processBatch`
   * already groups a claimed batch by gateway and fails only that gateway's
   * labels when a vendor is unreachable, leaving the rest of the batch to
   * push normally.
   */
  private async sweepTenant(tenantId: string): Promise<void> {
    try {
      // The same module gate `@RequireModule('esl')` applies to every route
      // this worker stands in for. A tenant without the module enabled is
      // skipped before any job is claimed.
      const enabled = await this.platformModules.isEnabledForTenant(
        tenantId,
        ESL_MODULE_CODE,
      );
      if (!enabled) {
        return;
      }
      // Drain first, repair second: reconciliation ENQUEUES work, and
      // draining first means anything it finds is picked up by the next
      // sweep rather than sitting behind a batch that was already claimed.
      const summary = await this.esl.processBatch(
        tenantId,
        this.config.batchSize,
      );
      if (
        summary.claimed > 0 ||
        summary.leaseReclaimed > 0 ||
        summary.leaseFailed > 0
      ) {
        // Counts only. The vendor's own payloads and error text never reach
        // a log line from here; the service screens what it stores on the
        // job row, and this summary carries none of it.
        this.logger.log(
          `ESL sweep tenant=${tenantId} claimed=${summary.claimed} ` +
            `succeeded=${summary.succeeded} failed=${summary.failed} ` +
            `requeued=${summary.requeued} ` +
            `leaseReclaimed=${summary.leaseReclaimed} ` +
            `leaseFailed=${summary.leaseFailed}`,
        );
      }
      await this.reconcileIfDue(tenantId);
    } catch (error) {
      this.logger.warn(
        `ESL sweep failed for tenant ${tenantId}: ${describe(error)}`,
      );
    }
  }

  /**
   * The repair half: any bound label whose rendered content is not what the
   * price in force says catches a fresh job. It is what makes the
   * best-effort activation hand-off safe, so it cannot be left to a human
   * either — but it is far more expensive than a drain, hence its own clock.
   *
   * The pass is attributed to no user: `reconcile` takes a null actor, the
   * same attribution the price-activation listener already uses for work
   * nobody asked for by hand.
   */
  private async reconcileIfDue(tenantId: string): Promise<void> {
    const last = this.lastReconciledAt.get(tenantId);
    const now = Date.now();
    if (last !== undefined && now - last < this.config.reconcileIntervalMs) {
      return;
    }
    const result = await this.esl.reconcile(tenantId, null);
    // Stamped only after the pass completed — a throw propagates to
    // sweepTenant, which logs it and leaves this tenant due next sweep.
    this.lastReconciledAt.set(tenantId, Date.now());
    if (result.enqueued > 0) {
      this.logger.log(
        `ESL reconcile tenant=${tenantId} inspected=${result.inspected} ` +
          `enqueued=${result.enqueued}`,
      );
    }
  }

  /** Forget cursors for tenants that are no longer active candidates. */
  private pruneReconcileCursors(tenantIds: readonly string[]): void {
    const live = new Set(tenantIds);
    for (const tenantId of this.lastReconciledAt.keys()) {
      if (!live.has(tenantId)) {
        this.lastReconciledAt.delete(tenantId);
      }
    }
  }
}

/**
 * Error class and message only.
 *
 * A vendor's own error text cannot reach here: the adapter call is caught
 * inside `processGatewayBatch`, which logs the error CLASS alone and screens
 * anything it writes to the job row. What surfaces to this worker is
 * infrastructure (a database outage, a programming error), which is exactly
 * what an operator needs to see in the log.
 */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
}
