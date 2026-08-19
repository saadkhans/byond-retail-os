import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CvTestProtocolStatus,
  CvTestScenarioResult,
  CvTestScenarioType,
  PilotExpectedAction,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  PILOT_NOTES_MAX_LENGTH,
  PilotEvaluationService,
} from './pilot-evaluation.service';

/**
 * Phase 16 — live CV TEST PROTOCOL (SHADOW ONLY). A protocol scripts
 * repeatable real-footage tests (scenario templates with EXPECTED
 * outcomes) around ONE Phase 15 evaluation run, and reports honestly on
 * the results. Purely organizational: no CV decision reads these
 * tables, scenario results are operator statements for reporting only,
 * and nothing here touches checkout/order/payment/inventory state.
 * Every response is controlled ids/enums/numbers — no URLs, paths, or
 * credential material.
 */

/** Free-text fields (name/description/notes) are screened with the
 *  shared sensitive-text predicate and REJECTED when it trips. */
function screenText(label: string, value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) {
    return null;
  }
  if (text.length > PILOT_NOTES_MAX_LENGTH) {
    throw new BadRequestException(
      `${label} must be at most ${PILOT_NOTES_MAX_LENGTH} characters`,
    );
  }
  if (containsSensitiveFreeText(text)) {
    throw new BadRequestException(
      `${label} rejected by the sensitive-content screen`,
    );
  }
  return text;
}

const NON_TERMINAL_PROTOCOL_STATUSES: CvTestProtocolStatus[] = [
  CvTestProtocolStatus.DRAFT,
  CvTestProtocolStatus.ACTIVE,
];

@Injectable()
export class CvTestProtocolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluations: PilotEvaluationService,
  ) {}

  async createProtocol(
    tenantId: string,
    input: {
      name: string;
      description?: string | null;
      locationId?: string | null;
      cameraSourceId?: string | null;
      evaluationRunId?: string | null;
      fastModeExpected?: boolean | null;
    },
    actorId?: string,
  ) {
    const name = screenText('name', input.name);
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const description = screenText('description', input.description);
    if (input.locationId) {
      const location = await this.prisma.location.findFirst({
        where: { tenantId, id: input.locationId },
        select: { id: true },
      });
      if (!location) {
        throw new NotFoundException('Store not found');
      }
    }
    if (input.cameraSourceId) {
      const source = await this.prisma.cameraSource.findFirst({
        where: { tenantId, id: input.cameraSourceId },
        select: { id: true },
      });
      if (!source) {
        throw new NotFoundException('Camera source not found');
      }
    }
    if (input.evaluationRunId) {
      await this.requireEvaluationRun(tenantId, input.evaluationRunId);
    }
    const protocol = await this.prisma.cvTestProtocol.create({
      data: {
        tenantId,
        name,
        description,
        locationId: input.locationId ?? null,
        cameraSourceId: input.cameraSourceId ?? null,
        evaluationRunId: input.evaluationRunId ?? null,
        fastModeExpected: input.fastModeExpected ?? null,
        createdById: actorId ?? null,
      },
    });
    return this.protocolDetail(tenantId, protocol.id);
  }

  private async requireEvaluationRun(tenantId: string, evaluationRunId: string) {
    const run = await this.prisma.pilotEvaluationRun.findFirst({
      where: { tenantId, id: evaluationRunId },
      select: { id: true },
    });
    if (!run) {
      throw new NotFoundException('Evaluation run not found');
    }
  }

  async listProtocols(tenantId: string) {
    const protocols = await this.prisma.cvTestProtocol.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: {
        location: { select: { name: true } },
        cameraSource: { select: { name: true } },
        _count: { select: { scenarios: true } },
      },
    });
    return protocols.map((protocol) => ({
      protocolId: protocol.id,
      name: protocol.name,
      description: protocol.description,
      status: protocol.status,
      locationName: protocol.location?.name ?? null,
      cameraSourceName: protocol.cameraSource?.name ?? null,
      evaluationRunId: protocol.evaluationRunId,
      fastModeExpected: protocol.fastModeExpected,
      scenarioCount: protocol._count.scenarios,
      createdAt: protocol.createdAt,
      completedAt: protocol.completedAt,
    }));
  }

  private async requireProtocol(tenantId: string, protocolId: string) {
    const protocol = await this.prisma.cvTestProtocol.findFirst({
      where: { tenantId, id: protocolId },
      include: {
        location: { select: { name: true } },
        cameraSource: { select: { name: true } },
      },
    });
    if (!protocol) {
      throw new NotFoundException('Test protocol not found');
    }
    return protocol;
  }

  async protocolDetail(tenantId: string, protocolId: string) {
    const protocol = await this.requireProtocol(tenantId, protocolId);
    const scenarios = await this.prisma.cvTestProtocolScenario.findMany({
      where: { tenantId, protocolId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { expectedProduct: { select: { name: true } } },
    });
    return {
      protocolId: protocol.id,
      name: protocol.name,
      description: protocol.description,
      status: protocol.status,
      locationId: protocol.locationId,
      locationName: protocol.location?.name ?? null,
      cameraSourceId: protocol.cameraSourceId,
      cameraSourceName: protocol.cameraSource?.name ?? null,
      evaluationRunId: protocol.evaluationRunId,
      fastModeExpected: protocol.fastModeExpected,
      createdAt: protocol.createdAt,
      completedAt: protocol.completedAt,
      scenarios: scenarios.map((scenario) => ({
        scenarioId: scenario.id,
        scenarioType: scenario.scenarioType,
        expectedAction: scenario.expectedAction,
        expectedProductId: scenario.expectedProductId,
        expectedSku: scenario.expectedSku,
        expectedProductName: scenario.expectedProduct?.name ?? null,
        expectedQuantity: scenario.expectedQuantity,
        notes: scenario.notes,
        liveSessionId: scenario.liveSessionId,
        result: scenario.result,
        resultNotes: scenario.resultNotes,
        resultAt: scenario.resultAt,
        createdAt: scenario.createdAt,
      })),
    };
  }

  /** DRAFT → ACTIVE; DRAFT/ACTIVE → COMPLETED/CANCELLED. Terminal
   *  states are final (no reopening). */
  async setStatus(
    tenantId: string,
    protocolId: string,
    status: CvTestProtocolStatus,
  ) {
    if (status === CvTestProtocolStatus.DRAFT) {
      throw new BadRequestException('a protocol cannot return to DRAFT');
    }
    const terminal =
      status === CvTestProtocolStatus.COMPLETED ||
      status === CvTestProtocolStatus.CANCELLED;
    const updated = await this.prisma.cvTestProtocol.updateMany({
      where: {
        id: protocolId,
        tenantId,
        status: {
          in:
            status === CvTestProtocolStatus.ACTIVE
              ? [CvTestProtocolStatus.DRAFT]
              : NON_TERMINAL_PROTOCOL_STATUSES,
        },
      },
      data: {
        status,
        ...(terminal ? { completedAt: new Date() } : {}),
      },
    });
    if (updated.count === 0) {
      const protocol = await this.requireProtocol(tenantId, protocolId);
      throw new ConflictException(
        `test protocol is ${protocol.status} — transition to ${status} is not allowed`,
      );
    }
    return this.protocolDetail(tenantId, protocolId);
  }

  /** Link (or relink while non-terminal) the ONE evaluation run this
   *  protocol reports over. */
  async linkEvaluationRun(
    tenantId: string,
    protocolId: string,
    evaluationRunId: string,
  ) {
    await this.requireEvaluationRun(tenantId, evaluationRunId);
    const updated = await this.prisma.cvTestProtocol.updateMany({
      where: {
        id: protocolId,
        tenantId,
        status: { in: NON_TERMINAL_PROTOCOL_STATUSES },
      },
      data: { evaluationRunId },
    });
    if (updated.count === 0) {
      const protocol = await this.requireProtocol(tenantId, protocolId);
      throw new ConflictException(
        `test protocol is ${protocol.status} — evaluation run cannot change`,
      );
    }
    return this.protocolDetail(tenantId, protocolId);
  }

  async addScenario(
    tenantId: string,
    protocolId: string,
    input: {
      scenarioType: CvTestScenarioType;
      expectedAction: PilotExpectedAction;
      expectedProductId?: string | null;
      expectedQuantity?: number | null;
      notes?: string | null;
    },
    actorId?: string,
  ) {
    const protocol = await this.requireProtocol(tenantId, protocolId);
    if (!NON_TERMINAL_PROTOCOL_STATUSES.includes(protocol.status)) {
      throw new ConflictException('test protocol is not open for scenarios');
    }
    const notes = screenText('notes', input.notes);
    if (
      input.expectedQuantity !== undefined &&
      input.expectedQuantity !== null &&
      (!Number.isInteger(input.expectedQuantity) ||
        input.expectedQuantity < 1 ||
        input.expectedQuantity > 99)
    ) {
      throw new BadRequestException('expectedQuantity must be 1..99');
    }
    let expectedSku: string | null = null;
    if (input.expectedProductId) {
      const product = await this.prisma.product.findFirst({
        where: { tenantId, id: input.expectedProductId },
        select: { sku: true },
      });
      if (!product) {
        throw new NotFoundException('Expected product not found');
      }
      expectedSku = product.sku;
    }
    await this.prisma.cvTestProtocolScenario.create({
      data: {
        tenantId,
        protocolId,
        scenarioType: input.scenarioType,
        expectedAction: input.expectedAction,
        expectedProductId: input.expectedProductId ?? null,
        expectedSku,
        expectedQuantity: input.expectedQuantity ?? null,
        notes,
        createdById: actorId ?? null,
      },
    });
    return this.protocolDetail(tenantId, protocolId);
  }

  /** Record (or re-record) the operator's PASS/FAIL/INCONCLUSIVE for one
   *  scenario — reporting only, never a CV input. */
  async recordScenarioResult(
    tenantId: string,
    protocolId: string,
    scenarioId: string,
    input: {
      result: CvTestScenarioResult;
      liveSessionId?: string | null;
      resultNotes?: string | null;
    },
    actorId?: string,
  ) {
    const protocol = await this.requireProtocol(tenantId, protocolId);
    if (!NON_TERMINAL_PROTOCOL_STATUSES.includes(protocol.status)) {
      throw new ConflictException('test protocol is not open for results');
    }
    const resultNotes = screenText('resultNotes', input.resultNotes);
    if (input.liveSessionId) {
      const liveSession = await this.prisma.liveCameraSession.findFirst({
        where: { tenantId, id: input.liveSessionId },
        select: { id: true },
      });
      if (!liveSession) {
        throw new NotFoundException('Live session not found');
      }
    }
    const updated = await this.prisma.cvTestProtocolScenario.updateMany({
      where: { id: scenarioId, tenantId, protocolId },
      data: {
        result: input.result,
        resultNotes,
        liveSessionId: input.liveSessionId ?? null,
        resultById: actorId ?? null,
        resultAt: new Date(),
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Scenario not found');
    }
    return this.protocolDetail(tenantId, protocolId);
  }

  /**
   * Phase 16 validation report: scenario pass/fail counts + the linked
   * evaluation run's honest metrics (Phase 15 summary reused verbatim) +
   * detection recall + fast-mode observation + dataset availability.
   * Missing data is null/unknown — NEVER fabricated.
   */
  async report(tenantId: string, protocolId: string) {
    const protocol = await this.requireProtocol(tenantId, protocolId);
    const scenarios = await this.prisma.cvTestProtocolScenario.findMany({
      where: { tenantId, protocolId },
      select: { result: true },
    });
    const count = (result: CvTestScenarioResult) =>
      scenarios.filter((row) => row.result === result).length;
    const pass = count(CvTestScenarioResult.PASS);
    const fail = count(CvTestScenarioResult.FAIL);
    const inconclusive = count(CvTestScenarioResult.INCONCLUSIVE);

    let evaluation: Awaited<
      ReturnType<PilotEvaluationService['summary']>
    > | null = null;
    let datasetExport: { available: boolean; rowCount: number } | null = null;
    let fastModeObserved: boolean | null = null;
    if (protocol.evaluationRunId) {
      evaluation = await this.evaluations.summary(
        tenantId,
        protocol.evaluationRunId,
      );
      const exported = await this.evaluations.datasetExport(
        tenantId,
        protocol.evaluationRunId,
      );
      datasetExport = {
        available: exported.rowCount > 0,
        rowCount: exported.rowCount,
      };
      // Fast mode as OBSERVED on the attached sessions' stamped
      // performance snapshots: true/false only when every stamped
      // session agrees; null when unknown or mixed.
      const attached = await this.prisma.pilotEvaluationSession.findMany({
        where: { tenantId, evaluationRunId: protocol.evaluationRunId },
        include: { liveSession: { select: { performance: true } } },
      });
      const stamps = attached
        .map((row) =>
          row.liveSession.performance &&
          typeof row.liveSession.performance === 'object'
            ? ((row.liveSession.performance as { fastMode?: boolean })
                .fastMode ?? null)
            : null,
        )
        .filter((value): value is boolean => value !== null);
      if (stamps.length === attached.length && attached.length > 0) {
        fastModeObserved = stamps.every((value) => value)
          ? true
          : stamps.every((value) => !value)
            ? false
            : null;
      }
    }
    // Detection recall over REVIEWED ground truth: the CV "detected" a
    // real event when the operator confirmed or corrected it (CORRECT /
    // WRONG_SKU / WRONG_ACTION); MISSED_EVENT rows are the ground-truth
    // events it did not produce. Null when nothing is labeled yet.
    let detectionRecall: number | null = null;
    if (evaluation) {
      const detected =
        evaluation.totals.correct +
        evaluation.totals.wrongSku +
        evaluation.totals.wrongAction;
      const denominator = detected + evaluation.totals.missedEvents;
      detectionRecall =
        denominator > 0
          ? Math.round((detected / denominator) * 1000) / 1000
          : null;
    }
    return {
      protocolId: protocol.id,
      name: protocol.name,
      status: protocol.status,
      evaluationRunId: protocol.evaluationRunId,
      fastModeExpected: protocol.fastModeExpected,
      fastModeObserved,
      scenarios: {
        total: scenarios.length,
        completed: pass + fail + inconclusive,
        pending: scenarios.length - (pass + fail + inconclusive),
        pass,
        fail,
        inconclusive,
      },
      detectionRecall,
      evaluation,
      datasetExport,
      safety: {
        orders: 0,
        checkoutSessions: 0,
        paymentIntents: 0,
        paymentEvents: 0,
        inventoryMovements: 0,
        basis: 'SHADOW_MODE_STATIC_GUARD',
      },
    };
  }
}
