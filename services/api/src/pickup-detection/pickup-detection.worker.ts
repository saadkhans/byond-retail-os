import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EvidenceSourceType, VideoAssetStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PickupDetectionConfig } from './pickup-detection.config';
import {
  PickupDetectionService,
  pickupSourceId,
} from './pickup-detection.service';

/** Poll cadence — cheap indexed scans; analysis itself takes seconds. */
const SCAN_INTERVAL_MS = 4000;
/** Per-scan ceiling so one burst of uploads cannot starve the event loop. */
const MAX_ASSETS_PER_SCAN = 2;
/** Only assets this recent are auto-picked-up; older ones stay manual. */
const AUTO_WINDOW_MS = 24 * 60 * 60 * 1000;

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PickupDetectionConfig,
    private readonly detection: PickupDetectionService,
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

  /** One scan: newest unprocessed VALIDATED/READY assets, oldest first. */
  async scanOnce(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      const assets = await this.prisma.videoAsset.findMany({
        where: {
          deletedAt: null,
          status: {
            in: [VideoAssetStatus.VALIDATED, VideoAssetStatus.READY],
          },
          createdAt: { gte: new Date(Date.now() - AUTO_WINDOW_MS) },
        },
        select: { id: true, tenantId: true },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });
      let processed = 0;
      for (const asset of assets) {
        if (processed >= MAX_ASSETS_PER_SCAN) {
          break;
        }
        const attempted = await this.prisma.inferenceJob.findFirst({
          where: {
            tenantId: asset.tenantId,
            sourceType: EvidenceSourceType.VISION,
            sourceId: pickupSourceId(asset.id),
          },
          select: { id: true },
        });
        if (attempted) {
          continue;
        }
        processed += 1;
        try {
          await this.detection.detectForAsset(asset.tenantId, asset.id);
        } catch (error) {
          // detectForAsset records job-level failures itself; this guards
          // the loop against pre-job refusals (e.g. a race with delete).
          this.logger.warn(
            `Auto pickup detection skipped asset ${asset.id}: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          );
        }
      }
    } finally {
      this.scanning = false;
    }
  }
}
