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
  Prisma,
} from '@prisma/client';
import { cvTestProtocolAdvisoryLockKey } from '../common/locks';
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

/**
 * NO-SOURCE/NO-PATH screen (Codex P1): the sensitive-text predicate
 * catches credentials, but a protocol note could still persist a camera
 * URL or a local media path — violating the no-source contract the
 * moment it is echoed back. Rejects URLs of ANY scheme (rtsp/rtsps/
 * http/file/…), absolute Unix paths, Windows drive paths, UNC paths,
 * and obvious media filenames. Exported for direct testing.
 */
export function containsSourceOrPathText(value: string): boolean {
  return (
    // Any URI scheme (stream, http, file, s3, …) — scheme-agnostic.
    /[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    // Windows drive path (C:\… or C:/…).
    /\b[a-z]:[\\/]/i.test(value) ||
    // Any backslash separator (UNC, drive-less, and relative Windows
    // paths alike — backslashes have no place in operator prose).
    /\\/.test(value) ||
    // Absolute Unix path at start or after whitespace/punctuation.
    /(?:^|[\s"'(=])\/(?:[\w.-]+\/)*[\w.-]+/.test(value) ||
    // Relative / home-relative prefixes (./x, ../x, ~/x).
    /(?:^|[\s"'(=])(?:\.{1,2}|~)\//.test(value) ||
    // Obvious media/stream filenames anywhere.
    /\.(mp4|mov|avi|mkv|webm|m3u8|mts|png|jpe?g|bmp|gif)\b/i.test(value) ||
    // EVERY compact slash-separated token (feeds/camera, media/input,
    // recordings/session, a/b/c). No length/character heuristics
    // (Codex P1): this module's no-source/no-path contract outweighs
    // prose pairs — write "pass or fail", not "pass/fail".
    /[\w.-]+\/[\w.-]+/.test(value)
  );
}

/** Free-text fields (name/description/notes) are screened with the
 *  shared sensitive-text predicate AND the no-source/no-path screen —
 *  REJECTED (never echoed back) when either trips. */
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
  if (containsSourceOrPathText(text)) {
    throw new BadRequestException(
      `${label} rejected: URLs and file paths are not allowed in protocol text`,
    );
  }
  return text;
}

/**
 * FIXED expected actions per scenario template (Codex P1): a template
 * whose ground truth is unambiguous rejects contradictory input —
 * SINGLE_RETURN with PICKUP would make every downstream metric
 * uninterpretable. Only genuinely open-ended templates stay
 * caller-configurable.
 */
export const SCENARIO_FIXED_ACTIONS: Partial<
  Record<CvTestScenarioType, PilotExpectedAction>
> = {
  [CvTestScenarioType.SINGLE_PICKUP]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.MISSED_PICKUP]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.TWO_PRODUCTS_VISIBLE_ONE_PICKED]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.SIMILAR_SKU_CONFUSION]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.MULTI_QUANTITY_PICKUP]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.HAND_OCCLUSION]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.FAST_PICKUP]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.SLOW_PICKUP]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.LOW_LIGHT]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.BAD_ANGLE]: PilotExpectedAction.PICKUP,
  [CvTestScenarioType.SINGLE_RETURN]: PilotExpectedAction.RETURN,
  [CvTestScenarioType.MISSED_RETURN]: PilotExpectedAction.RETURN,
  [CvTestScenarioType.FALSE_TOUCH_NO_PRODUCT_MOVED]: PilotExpectedAction.NO_OP,
  [CvTestScenarioType.EMPTY_SHELF]: PilotExpectedAction.NO_OP,
  // UNKNOWN_PRODUCT stays open-ended (UNKNOWN/PICKUP/RETURN by intent).
};

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

  /**
   * ONE serialization boundary for every mutation that can affect
   * evidence validity (Codex P1): scenario insertion, result recording,
   * evaluation-run relinking, and the completion evidence check all run
   * under the SAME protocol-scoped advisory lock, and every decision is
   * made from IN-TRANSACTION re-reads — never pre-lock snapshots.
   */
  private withProtocolLock<T>(
    tenantId: string,
    protocolId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${cvTestProtocolAdvisoryLockKey(
        tenantId,
        protocolId,
      )}))::text`;
      return work(tx);
    });
  }

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
    // The evidence check and the terminal write run in ONE transaction
    // under the protocol's advisory lock (Codex P1): scenario inserts
    // take the same lock, so completion can never miss a concurrently
    // added pending scenario and a completed protocol can never gain
    // one.
    const updated = await this.withProtocolLock(
      tenantId,
      protocolId,
      async (tx) => {
      if (status === CvTestProtocolStatus.COMPLETED) {
        // COMPLETION GATE (Codex P1): a terminal protocol can never be
        // reopened, so completing without full evidence would strand
        // the test behind an official-looking partial report.
        // COMPLETED requires: a linked evaluation run that is itself
        // COMPLETED, at least one scenario, and every scenario resolved
        // with a result bound to a live session.
        const protocol = await tx.cvTestProtocol.findFirst({
          where: { id: protocolId, tenantId },
          select: { evaluationRunId: true },
        });
        if (!protocol) {
          throw new NotFoundException('Test protocol not found');
        }
        if (!protocol.evaluationRunId) {
          throw new ConflictException(
            'cannot complete: no evaluation run is linked',
          );
        }
        const run = await tx.pilotEvaluationRun.findFirst({
          where: { tenantId, id: protocol.evaluationRunId },
          select: { status: true },
        });
        if (run?.status !== 'COMPLETED') {
          throw new ConflictException(
            'cannot complete: the linked evaluation run is not COMPLETED',
          );
        }
        const scenarios = await tx.cvTestProtocolScenario.findMany({
          where: { tenantId, protocolId },
          select: { result: true, liveSessionId: true },
        });
        if (scenarios.length === 0) {
          throw new ConflictException(
            'cannot complete: no scenarios recorded',
          );
        }
        const unresolved = scenarios.filter(
          (row) => row.result === null || row.liveSessionId === null,
        );
        if (unresolved.length > 0) {
          throw new ConflictException(
            `cannot complete: ${unresolved.length} scenario(s) lack a session-bound result`,
          );
        }
      }
      return tx.cvTestProtocol.updateMany({
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
      },
    );
    if (updated.count === 0) {
      const protocol = await this.requireProtocol(tenantId, protocolId);
      throw new ConflictException(
        `test protocol is ${protocol.status} — transition to ${status} is not allowed`,
      );
    }
    return this.protocolDetail(tenantId, protocolId);
  }

  /** Link (or relink while non-terminal) the ONE evaluation run this
   *  protocol reports over. Relinking is REFUSED once any scenario
   *  result exists (Codex P1): results were validated against the
   *  previously linked run's sessions — mixing them with a new run's
   *  metrics would fabricate evidence. */
  async linkEvaluationRun(
    tenantId: string,
    protocolId: string,
    evaluationRunId: string,
  ) {
    await this.requireEvaluationRun(tenantId, evaluationRunId);
    // Every decision below is made from IN-LOCK re-reads (Codex P1): a
    // result recording holds the same lock, so relink can never observe
    // "no results yet" while a result from the OLD run is mid-commit.
    await this.withProtocolLock(tenantId, protocolId, async (tx) => {
      const current = await tx.cvTestProtocol.findFirst({
        where: { id: protocolId, tenantId },
        select: { status: true, evaluationRunId: true },
      });
      if (!current) {
        throw new NotFoundException('Test protocol not found');
      }
      if (current.evaluationRunId === evaluationRunId) {
        // Idempotent re-link to the SAME run — nothing changes.
        return;
      }
      if (!NON_TERMINAL_PROTOCOL_STATUSES.includes(current.status)) {
        throw new ConflictException(
          `test protocol is ${current.status} — evaluation run cannot change`,
        );
      }
      const recorded = await tx.cvTestProtocolScenario.count({
        where: { tenantId, protocolId, result: { not: null } },
      });
      if (recorded > 0) {
        throw new ConflictException(
          'scenario results already recorded against the linked run — ' +
            'relinking is not allowed (CV_TEST_PROTOCOL_RESULTS_EXIST)',
        );
      }
      await tx.cvTestProtocol.updateMany({
        where: {
          id: protocolId,
          tenantId,
          status: { in: NON_TERMINAL_PROTOCOL_STATUSES },
        },
        data: { evaluationRunId },
      });
    });
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
    // Contradictory ground truth is REJECTED (Codex P1): a fixed
    // template's expected action is part of the template.
    const fixedAction = SCENARIO_FIXED_ACTIONS[input.scenarioType];
    if (fixedAction !== undefined && input.expectedAction !== fixedAction) {
      throw new BadRequestException(
        `${input.scenarioType} scenarios expect ${fixedAction} — contradictory expectedAction rejected`,
      );
    }
    // UNKNOWN_PRODUCT is open-ended over PRODUCT interactions only —
    // NO_OP would mean "an unknown product was not interacted with",
    // which is contradictory ground truth (Codex P2).
    if (
      input.scenarioType === CvTestScenarioType.UNKNOWN_PRODUCT &&
      input.expectedAction === PilotExpectedAction.NO_OP
    ) {
      throw new BadRequestException(
        'UNKNOWN_PRODUCT scenarios expect UNKNOWN, PICKUP, or RETURN — NO_OP rejected',
      );
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
    // ATOMIC with completion (Codex P1): the insert takes the protocol's
    // advisory lock and RE-CHECKS the status inside the same transaction
    // — a completion committing concurrently either sees this scenario
    // in its evidence query or this insert sees the terminal status and
    // refuses. No COMPLETED protocol can gain a pending scenario.
    await this.withProtocolLock(tenantId, protocolId, async (tx) => {
      const current = await tx.cvTestProtocol.findFirst({
        where: { id: protocolId, tenantId },
        select: { status: true },
      });
      if (
        !current ||
        !NON_TERMINAL_PROTOCOL_STATUSES.includes(current.status)
      ) {
        throw new ConflictException('test protocol is not open for scenarios');
      }
      await tx.cvTestProtocolScenario.create({
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
    });
    return this.protocolDetail(tenantId, protocolId);
  }

  /**
   * Record (or re-record) the operator's PASS/FAIL/INCONCLUSIVE for one
   * scenario — reporting only, never a CV input. The result MUST name
   * the evaluated live session, and that session must be attached to
   * the protocol's linked evaluation run (Codex P1): a PASS/FAIL that
   * could describe unrelated footage is not evidence.
   */
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
    if (!input.liveSessionId) {
      throw new BadRequestException(
        'liveSessionId is required — a result must name the evaluated session',
      );
    }
    const liveSessionId = input.liveSessionId;
    const resultNotes = screenText('resultNotes', input.resultNotes);
    // ALL run/session validation happens INSIDE the protocol lock
    // (Codex P1): a concurrent relink holds the same lock, so the
    // session is always validated against the run the protocol is
    // linked to AT COMMIT TIME — evidence from a previously linked run
    // can never slip through.
    const updated = await this.withProtocolLock(
      tenantId,
      protocolId,
      async (tx) => {
        const current = await tx.cvTestProtocol.findFirst({
          where: { id: protocolId, tenantId },
          select: { status: true, evaluationRunId: true },
        });
        if (!current) {
          throw new NotFoundException('Test protocol not found');
        }
        if (!NON_TERMINAL_PROTOCOL_STATUSES.includes(current.status)) {
          throw new ConflictException('test protocol is not open for results');
        }
        if (!current.evaluationRunId) {
          throw new ConflictException(
            'link an evaluation run before recording scenario results',
          );
        }
        const attached = await tx.pilotEvaluationSession.findFirst({
          where: {
            tenantId,
            evaluationRunId: current.evaluationRunId,
            liveSessionId,
          },
          select: { id: true },
        });
        if (!attached) {
          throw new ConflictException(
            'live session is not attached to this protocol’s evaluation run',
          );
        }
        return tx.cvTestProtocolScenario.updateMany({
          where: { id: scenarioId, tenantId, protocolId },
          data: {
            result: input.result,
            resultNotes,
            liveSessionId,
            resultById: actorId ?? null,
            resultAt: new Date(),
          },
        });
      },
    );
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
