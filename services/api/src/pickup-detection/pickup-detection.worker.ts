import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  EvidenceSourceType,
  InferenceJobStatus,
  TenantStatus,
  VideoAssetStatus,
} from '@prisma/client';
import { PlatformModulesService } from '../platform-modules/platform-modules.service';
import { PrismaService } from '../prisma/prisma.service';
import { PickupDetectionConfig } from './pickup-detection.config';
import {
  CV_MODULE_DISABLED_ERROR_CODE,
  PickupDetectionService,
  pickupSourceId,
} from './pickup-detection.service';

/** Poll cadence — cheap indexed scans; analysis itself takes seconds. */
const SCAN_INTERVAL_MS = 4000;
/** Per-scan ceiling so one burst of uploads cannot starve the event loop. */
const MAX_ASSETS_PER_SCAN = 2;
/** Only assets validated this recently are auto-picked-up; older ones stay
 *  manual (see eligibleAssetWhere for why updatedAt carries the window). */
const AUTO_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Assets fetched per page while paging past already-attempted ones. */
const SCAN_PAGE_SIZE = 25;
/** First delay before re-trying an asset whose detect call threw before a
 *  job row existed; doubles per consecutive failure. */
const PRE_JOB_RETRY_BASE_MS = 60_000;
/** Ceiling for the pre-job retry backoff. */
const PRE_JOB_RETRY_MAX_MS = 60 * 60 * 1000;

/**
 * The automatic half of the requirement "upload → inference job with no
 * operator action": a flag-gated in-process worker that watches for
 * validated assets with no pickup attempt yet and runs the pipeline on
 * them. This is the codebase's FIRST automatic queue driver — Phase 9
 * deliberately shipped manual-only endpoints — so it is deliberately
 * narrow: pickup jobs only, small batches, one at a time, gated by
 * PICKUP_DETECTION_ENABLED.
 */
@Injectable()
export class PickupDetectionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PickupDetectionWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  /**
   * Assets whose detectForAsset call threw BEFORE a job row existed (e.g.
   * the asset's store or unit was deleted after upload, so job creation
   * itself is refused). Nothing marks such assets attempted, so without a
   * backoff they would be re-selected oldest-first on EVERY scan and
   * permanently starve the MAX_ASSETS_PER_SCAN budget. Failures that do
   * reach a job are excluded by the attempted lookup instead. In-memory
   * on purpose: a restart merely grants one extra retry.
   */
  private readonly preJobFailures = new Map<
    string,
    { failures: number; retryAt: number }
  >();
  /**
   * Tenant that received the LAST unit of scan budget. Each scan resumes
   * with the next tenant id after this one (wrapping), because the tenant
   * enumeration sorts identically every poll — without a cursor the first
   * tenant's backlog would consume the whole MAX_ASSETS_PER_SCAN budget on
   * every scan and starve later tenants forever. In-memory on purpose: a
   * restart merely restarts the rotation at the first tenant.
   */
  private lastTenantServed: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PickupDetectionConfig,
    private readonly detection: PickupDetectionService,
    private readonly platformModules: PlatformModulesService,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      return;
    }
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, SCAN_INTERVAL_MS);
    // Never keep the process alive just to poll.
    this.timer.unref();
    this.logger.log(
      `Pickup-detection worker active (every ${SCAN_INTERVAL_MS} ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One scan: unprocessed VALIDATED/READY assets, oldest first, per tenant. */
  async scanOnce(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      const cutoff = new Date(Date.now() - AUTO_WINDOW_MS);
      this.prunePreJobFailures();
      // Candidate tenants come from the platform-scoped Tenant table,
      // never from a cross-tenant scan of tenant data: every VideoAsset
      // and InferenceJob read in this worker is scoped to a single
      // tenantId. Only ACTIVE tenants are candidates — suspended and
      // archived tenants must not have pipelines run on their behalf.
      const tenants = await this.prisma.tenant.findMany({
        where: { status: TenantStatus.ACTIVE },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      let remaining = MAX_ASSETS_PER_SCAN;
      const rotation = this.rotateTenants(tenants.map(({ id }) => id));
      for (const tenantId of rotation) {
        if (remaining <= 0) {
          break;
        }
        const processed = await this.scanTenant(tenantId, cutoff, remaining);
        if (processed > 0) {
          // Only budget spent advances the cursor: a tenant skipped for a
          // closed cv gate or a fully-attempted backlog costs nothing, so
          // it must not push the rotation past tenants that DID have work.
          this.lastTenantServed = tenantId;
        }
        remaining -= processed;
      }
    } catch (error) {
      // A failed poll (e.g. transient DB outage) must never become an
      // unhandled rejection from the interval callback; log and retry on
      // the next tick.
      this.logger.warn(
        `Pickup-detection scan failed: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    } finally {
      this.scanning = false;
    }
  }

  /** Drop backoff entries whose asset must have aged out of the auto
   *  window (retryAt is capped at PRE_JOB_RETRY_MAX_MS, so an entry idle
   *  for a whole window belongs to an asset no scan will select again). */
  private prunePreJobFailures(): void {
    const staleBefore = Date.now() - AUTO_WINDOW_MS;
    for (const [key, entry] of this.preJobFailures) {
      if (entry.retryAt < staleBefore) {
        this.preJobFailures.delete(key);
      }
    }
  }

  /** Rotate the ascending tenant list so scanning resumes AFTER the tenant
   *  that last received budget. Comparing ids (rather than indexOf) keeps
   *  the rotation stable when that tenant has since dropped out of the
   *  list; a single-tenant list always comes back unchanged. */
  private rotateTenants(tenantIds: string[]): string[] {
    if (this.lastTenantServed === null) {
      return tenantIds;
    }
    const cursor = this.lastTenantServed;
    const start = tenantIds.findIndex((id) => id > cursor);
    // start === 0: every id already sorts after the cursor; start === -1:
    // none do, so wrap to the beginning. Either way: no rotation needed.
    return start <= 0
      ? tenantIds
      : [...tenantIds.slice(start), ...tenantIds.slice(0, start)];
  }

  /** Required tenantId keeps every VideoAsset predicate tenant-scoped by
   *  construction — there is deliberately no unscoped variant. */
  private eligibleAssetWhere(cutoff: Date, tenantId: string) {
    return {
      tenantId,
      deletedAt: null,
      status: {
        in: [VideoAssetStatus.VALIDATED, VideoAssetStatus.READY],
      },
      // The auto window starts when validation COMPLETES, not at upload:
      // an asset can sit QUARANTINED past the window and only then be
      // approved, and it must still get its automatic attempt. VideoAsset
      // has no dedicated validatedAt column, but the status transition
      // into VALIDATED/READY bumps @updatedAt and rows in these statuses
      // see no routine later writes — so updatedAt is always >= the
      // transition time and never strands a freshly validated asset.
      updatedAt: { gte: cutoff },
    };
  }

  /**
   * Scan one tenant's eligible assets, oldest first, paging PAST assets
   * that already have a pickup attempt (InferenceJob keyed by
   * pickupSourceId) so a backlog of attempted assets can never wedge the
   * scan short of newer unattempted ones. Returns how many assets it ran
   * detection on (at most `budget`).
   */
  private async scanTenant(
    tenantId: string,
    cutoff: Date,
    budget: number,
  ): Promise<number> {
    // Cheap tenant-scoped existence probe first: enumeration covers EVERY
    // active tenant (not just those with eligible assets), so an idle
    // tenant must cost one indexed lookup — not a module-gate check plus
    // a page query — before the scan moves on.
    const eligible = await this.prisma.videoAsset.findFirst({
      where: this.eligibleAssetWhere(cutoff, tenantId),
      select: { id: true },
    });
    if (!eligible) {
      return 0;
    }
    // Dependency gate next: while cv is disabled every attempt is
    // guaranteed to fail (runJob refuses with CV_MODULE_DISABLED), so the
    // tenant is skipped WITHOUT burning any asset's automatic attempt —
    // the backlog stays unattempted and is picked up once the gate clears.
    const cvEnabled = await this.platformModules.isEnabledForTenant(
      tenantId,
      'cv',
    );
    if (!cvEnabled) {
      return 0;
    }
    let processed = 0;
    let cursor: string | null = null;
    while (processed < budget) {
      const page: { id: string }[] = await this.prisma.videoAsset.findMany({
        where: this.eligibleAssetWhere(cutoff, tenantId),
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SCAN_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) {
        break;
      }
      cursor = page[page.length - 1].id;
      // One batched lookup excludes the whole page's attempted assets
      // (VideoAsset↔InferenceJob is linked only by the derived sourceId
      // string, so the exclusion cannot live inside the asset query).
      const attempted = await this.prisma.inferenceJob.findMany({
        where: {
          tenantId,
          sourceType: EvidenceSourceType.VISION,
          sourceId: { in: page.map((asset) => pickupSourceId(asset.id)) },
          // A cv-gate refusal is environmental, not a verdict on the
          // asset: attempts that failed ONLY on the gate do not count, so
          // those assets are re-attempted once the tenant's gate clears
          // (the gate check above keeps this from looping while closed).
          NOT: {
            status: InferenceJobStatus.FAILED,
            errorCode: CV_MODULE_DISABLED_ERROR_CODE,
          },
        },
        select: { sourceId: true },
      });
      const attemptedSourceIds = new Set(
        attempted.map((job) => job.sourceId),
      );
      for (const asset of page) {
        if (processed >= budget) {
          break;
        }
        const backoffKey = `${tenantId}:${asset.id}`;
        if (attemptedSourceIds.has(pickupSourceId(asset.id))) {
          this.preJobFailures.delete(backoffKey);
          continue;
        }
        const backoff = this.preJobFailures.get(backoffKey);
        if (backoff && backoff.retryAt > Date.now()) {
          // Still backing off a pre-job failure — skip WITHOUT spending
          // budget, so a persistently refusing asset cannot starve newer
          // ones out of the per-scan cap.
          continue;
        }
        processed += 1;
        try {
          await this.detection.detectForAsset(tenantId, asset.id);
          this.preJobFailures.delete(backoffKey);
        } catch (error) {
          // detectForAsset records job-level failures itself, so a THROW
          // means no job row exists (a race with delete, or a store/unit
          // removed after upload). Nothing marks the asset attempted, so
          // back off exponentially instead of re-running it every scan.
          const failures = (backoff?.failures ?? 0) + 1;
          const delayMs = Math.min(
            PRE_JOB_RETRY_BASE_MS * 2 ** (failures - 1),
            PRE_JOB_RETRY_MAX_MS,
          );
          this.preJobFailures.set(backoffKey, {
            failures,
            retryAt: Date.now() + delayMs,
          });
          this.logger.warn(
            `Auto pickup detection skipped asset ${asset.id} (next retry ` +
              `in ~${Math.round(delayMs / 1000)}s): ${
                error instanceof Error ? error.message : 'unknown'
              }`,
          );
        }
      }
      if (page.length < SCAN_PAGE_SIZE) {
        break;
      }
    }
    return processed;
  }
}
