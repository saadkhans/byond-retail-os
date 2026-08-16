import { Injectable } from '@nestjs/common';
import { FusionRunScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EVALUATION_MAX_CLIPS,
  EvaluatedClip,
  EvaluationSummary,
  SCORE_NOTE,
  evaluateClip,
  evaluateScenario,
  summarize,
} from './cv-evaluation.metrics';

/**
 * Phase 11 CV evaluation — READ-ONLY aggregation over ground truth and
 * fusion shadow runs. This module writes NOTHING: no prisma create/
 * update/delete of any kind exists here (pinned by shadow-mode.spec.ts).
 *
 * Response safety: only classified codes, SKUs, filenames, and numbers
 * leave this service — never rawPreview/errorDetail, OCR text, or
 * barcode values from the evidence JSON.
 */

export interface TestRunRow {
  videoAssetId: string;
  originalFilename: string;
  testType: string | null;
  groundTruth: {
    eventKind: string;
    sku: string | null;
    quantity: number;
  };
  run: {
    runId: string;
    createdAt: Date;
    policy: string;
    predictedKind: string | null;
    predictedSku: string | null;
    fusedTopScore: number | null;
    vlmStatus: string | null;
    requiresHumanReview: boolean | null;
  } | null;
  evaluation: {
    pass: boolean | null;
    expected: string;
    actual: string;
  };
}

@Injectable()
export class CvEvaluationService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string): Promise<EvaluationSummary> {
    return summarize(await this.load(tenantId));
  }

  async testRuns(
    tenantId: string,
  ): Promise<{ rows: TestRunRow[]; scoreNote: typeof SCORE_NOTE }> {
    const pairs = await this.load(tenantId);
    return {
      rows: pairs.map(({ gt, clip }) => ({
        videoAssetId: gt.videoAssetId,
        originalFilename: gt.originalFilename,
        testType: gt.testType,
        groundTruth: {
          eventKind: gt.eventKind,
          sku: gt.sku,
          quantity: gt.quantity,
        },
        run: clip.hasRun
          ? {
              runId: clip.runId as string,
              createdAt: clip.runCreatedAt as Date,
              policy: clip.policy as string,
              predictedKind: clip.predictedKind,
              predictedSku: clip.predictedSku,
              fusedTopScore: clip.fusedTopScore,
              vlmStatus: clip.vlm.invoked ? clip.vlm.status : null,
              requiresHumanReview: clip.vlm.requiresHumanReview,
            }
          : null,
        evaluation: evaluateScenario(gt.testType, gt, clip),
      })),
      scoreNote: SCORE_NOTE,
    };
  }

  /** Ground-truthed clips (newest first, capped) paired with each clip's
   *  LATEST fusion shadow run — the same "latest run" indirection the
   *  journey import uses. */
  private async load(tenantId: string): Promise<EvaluatedClip[]> {
    const truths = await this.prisma.videoGroundTruth.findMany({
      where: { tenantId, videoAsset: { deletedAt: null } },
      include: {
        product: { select: { sku: true } },
        videoAsset: { select: { originalFilename: true, deletedAt: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: EVALUATION_MAX_CLIPS,
    });
    const liveTruths = truths.filter(
      (truth) => truth.videoAsset.deletedAt === null,
    );
    const assetIds = liveTruths.map((truth) => truth.videoAssetId);
    const runs =
      assetIds.length === 0
        ? []
        : await this.prisma.pickupFusionRun.findMany({
            // WHOLE_CLIP only: ground truth describes the entire clip, so
            // a camera replay's REPLAY_WINDOW runs of the same video must
            // never displace the whole-clip result these metrics score
            // (Codex P1 — pilot runs contaminating evaluation).
            where: {
              tenantId,
              videoAssetId: { in: assetIds },
              runScope: FusionRunScope.WHOLE_CLIP,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              videoAssetId: true,
              createdAt: true,
              policy: true,
              fusedTopScore: true,
              processingMs: true,
              evidence: true,
            },
          });
    const latestByAsset = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (!latestByAsset.has(run.videoAssetId)) {
        latestByAsset.set(run.videoAssetId, run);
      }
    }
    return liveTruths.map((truth) => {
      const gt = {
        videoAssetId: truth.videoAssetId,
        originalFilename: truth.videoAsset.originalFilename,
        eventKind: truth.eventKind,
        testType: truth.testType,
        sku: truth.product?.sku ?? null,
        quantity: truth.quantity,
      };
      const run = latestByAsset.get(truth.videoAssetId);
      return {
        gt,
        clip: evaluateClip(
          gt,
          run
            ? {
                runId: run.id,
                createdAt: run.createdAt,
                policy: run.policy,
                fusedTopScore: run.fusedTopScore,
                processingMs: run.processingMs,
                evidence: run.evidence,
              }
            : null,
        ),
      };
    });
  }
}
