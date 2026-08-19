import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CvTestProtocolStatus,
  CvTestScenarioResult,
  CvTestScenarioType,
  PilotExpectedAction,
} from '@prisma/client';
import { CvTestProtocolService } from './cv-test-protocol.service';

const TENANT = 'tenant-1';

/** In-memory stub over the two protocol tables + read-only fixtures.
 *  The Phase 15 evaluation service is injected as a STUB — the report
 *  must reuse its numbers verbatim, never recompute them. */
function buildHarness(
  options: {
    summary?: Record<string, unknown> | null;
    exportRows?: number;
    sessionPerformance?: ({ fastMode?: boolean } | null)[];
    /** Linked run's status for the completion gate (default COMPLETED). */
    runStatus?: string;
  } = {},
) {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;
  const protocols: Record<string, unknown>[] = [];
  const scenarios: Record<string, unknown>[] = [];

  const whereMatch = (
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond !== null && typeof cond === 'object' && 'in' in (cond as object)) {
        return ((cond as { in: unknown[] }).in ?? []).includes(row[key]);
      }
      if (cond !== null && typeof cond === 'object' && 'not' in (cond as object)) {
        return row[key] !== (cond as { not: unknown }).not;
      }
      return row[key] === cond;
    });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    cvTestProtocol: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: nextId('proto'),
          status: CvTestProtocolStatus.DRAFT,
          description: null,
          locationId: null,
          cameraSourceId: null,
          evaluationRunId: null,
          fastModeExpected: null,
          completedAt: null,
          createdAt: new Date('2026-08-19T12:00:00.000Z'),
          ...args.data,
        };
        protocols.push(row);
        return row;
      }),
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const row = protocols.find((r) => whereMatch(r, args.where));
        return row ? { ...row, location: null, cameraSource: null } : null;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        protocols
          .filter((r) => whereMatch(r, args.where))
          .map((row) => ({
            ...row,
            location: null,
            cameraSource: null,
            _count: {
              scenarios: scenarios.filter((s) => s.protocolId === row.id)
                .length,
            },
          })),
      ),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = protocols.filter((r) => whereMatch(r, args.where));
          for (const row of hits) {
            Object.assign(row, args.data);
          }
          return { count: hits.length };
        },
      ),
    },
    cvTestProtocolScenario: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: nextId('scen'),
          result: null,
          resultNotes: null,
          resultById: null,
          resultAt: null,
          liveSessionId: null,
          createdAt: new Date('2026-08-19T12:01:00.000Z'),
          ...args.data,
        };
        scenarios.push(row);
        return row;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        scenarios
          .filter((r) => whereMatch(r, args.where))
          .map((row) => ({ ...row, expectedProduct: null })),
      ),
      updateMany: jest.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hits = scenarios.filter((r) => whereMatch(r, args.where));
          for (const row of hits) {
            Object.assign(row, args.data);
          }
          return { count: hits.length };
        },
      ),
      count: jest.fn(async (args: { where: Record<string, unknown> }) =>
        scenarios.filter((r) => whereMatch(r, args.where)).length,
      ),
    },
    location: {
      findFirst: jest.fn(async (args: { where: { id?: string } }) =>
        args.where.id === 'store-1' ? { id: 'store-1' } : null,
      ),
    },
    cameraSource: {
      findFirst: jest.fn(async (args: { where: { id?: string } }) =>
        args.where.id === 'cam-1' ? { id: 'cam-1' } : null,
      ),
    },
    product: {
      findFirst: jest.fn(async (args: { where: { id?: string } }) =>
        args.where.id === 'prod-a' ? { sku: 'SKU-A' } : null,
      ),
    },
    liveCameraSession: {
      findFirst: jest.fn(async (args: { where: { id?: string } }) =>
        args.where.id === 'live-1' ? { id: 'live-1' } : null,
      ),
    },
    pilotEvaluationRun: {
      findFirst: jest.fn(async (args: { where: { id?: string } }) =>
        args.where.id === 'run-1'
          ? { id: 'run-1', status: options.runStatus ?? 'COMPLETED' }
          : null,
      ),
    },
    pilotEvaluationSession: {
      // live-1 is attached to run-1; nothing else is.
      findFirst: jest.fn(
        async (args: {
          where: { evaluationRunId?: string; liveSessionId?: string };
        }) =>
          args.where.evaluationRunId === 'run-1' &&
          args.where.liveSessionId === 'live-1'
            ? { id: 'att-1' }
            : null,
      ),
      findMany: jest.fn(async () =>
        (options.sessionPerformance ?? []).map((performance, index) => ({
          liveSession: { id: `live-${index + 1}`, performance },
        })),
      ),
    },
    $queryRaw: jest.fn(async () => []),
  };
  // Interactive transaction: same client back (advisory lock is a
  // no-result side effect in the stub).
  prisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const evaluations = {
    summary: jest.fn(async () => options.summary ?? null),
    datasetExport: jest.fn(async () => ({
      rowCount: options.exportRows ?? 0,
      format: 'jsonl',
      manifest: '',
      evaluationRunId: 'run-1',
    })),
  };
  const service = new CvTestProtocolService(
    prisma as never,
    evaluations as never,
  );
  return { service, prisma, protocols, scenarios, evaluations };
}

const SUMMARY = {
  totals: {
    observations: 3,
    reviewed: 3,
    unreviewed: 0,
    correct: 2,
    incorrect: 0,
    uncertain: 0,
    falseTouch: 0,
    wrongSku: 1,
    wrongAction: 0,
    missedEvents: 1,
  },
  accuracy: { action: 1, sku: 0.667, combined: 0.667 },
  confusion: { action: [], sku: [] },
  latency: { sessions: [], combined: null },
  safety: {
    orders: 0,
    checkoutSessions: 0,
    paymentIntents: 0,
    paymentEvents: 0,
    inventoryMovements: 0,
    basis: 'SHADOW_MODE_STATIC_GUARD',
  },
};

describe('CvTestProtocolService — protocols', () => {
  it('creates, lists, and details a protocol; foreign tenant 404s', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(
      TENANT,
      { name: 'Water bottle test day', locationId: 'store-1', cameraSourceId: 'cam-1' },
      'user-1',
    );
    expect(created.status).toBe(CvTestProtocolStatus.DRAFT);
    const list = await harness.service.listProtocols(TENANT);
    expect(list).toHaveLength(1);
    await expect(
      harness.service.protocolDetail('tenant-B', created.protocolId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('screens name/description with the sensitive-text predicate', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.createProtocol(TENANT, {
        name: 'card 4111 1111 1111 1111',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.createProtocol(TENANT, {
        name: 'ok',
        description: 'cvv 123 4111 1111 1111 1111',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.protocols).toHaveLength(0);
  });

  it('status transitions: DRAFT→ACTIVE→COMPLETED (with evidence); no reopening; no DRAFT return', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
    });
    const active = await harness.service.setStatus(
      TENANT,
      created.protocolId,
      CvTestProtocolStatus.ACTIVE,
    );
    expect(active.status).toBe(CvTestProtocolStatus.ACTIVE);
    // Earn completion: one scenario with a session-bound result.
    const detail = await harness.service.addScenario(TENANT, created.protocolId, {
      scenarioType: CvTestScenarioType.SINGLE_PICKUP,
      expectedAction: PilotExpectedAction.PICKUP,
    });
    await harness.service.recordScenarioResult(
      TENANT,
      created.protocolId,
      detail.scenarios[0].scenarioId,
      { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
    );
    const done = await harness.service.setStatus(
      TENANT,
      created.protocolId,
      CvTestProtocolStatus.COMPLETED,
    );
    expect(done.status).toBe(CvTestProtocolStatus.COMPLETED);
    expect(done.completedAt).not.toBeNull();
    await expect(
      harness.service.setStatus(
        TENANT,
        created.protocolId,
        CvTestProtocolStatus.ACTIVE,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      harness.service.setStatus(
        TENANT,
        created.protocolId,
        CvTestProtocolStatus.DRAFT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('links an evaluation run while non-terminal; unknown run 404s', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, { name: 'p' });
    const linked = await harness.service.linkEvaluationRun(
      TENANT,
      created.protocolId,
      'run-1',
    );
    expect(linked.evaluationRunId).toBe('run-1');
    await expect(
      harness.service.linkEvaluationRun(TENANT, created.protocolId, 'run-x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CvTestProtocolService — scenarios', () => {
  async function protocolWithScenario() {
    const harness = buildHarness({ summary: SUMMARY, exportRows: 2 });
    const created = await harness.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
    });
    const withScenario = await harness.service.addScenario(
      TENANT,
      created.protocolId,
      {
        scenarioType: CvTestScenarioType.SINGLE_PICKUP,
        expectedAction: PilotExpectedAction.PICKUP,
        expectedProductId: 'prod-a',
        expectedQuantity: 1,
        notes: 'water bottle, front shelf',
      },
      'user-1',
    );
    return { harness, protocolId: created.protocolId, detail: withScenario };
  }

  it('adds a scenario with a snapshotted expected SKU and validated fields', async () => {
    const { detail } = await protocolWithScenario();
    expect(detail.scenarios).toHaveLength(1);
    expect(detail.scenarios[0].expectedSku).toBe('SKU-A');
    expect(detail.scenarios[0].result).toBeNull();
  });

  it('validates quantity bounds, screens notes, and 404s unknown products', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, { name: 'p' });
    await expect(
      harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.MULTI_QUANTITY_PICKUP,
        expectedAction: PilotExpectedAction.PICKUP,
        expectedQuantity: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.SINGLE_PICKUP,
        expectedAction: PilotExpectedAction.PICKUP,
        notes: 'pan 4111 1111 1111 1111',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.SINGLE_PICKUP,
        expectedAction: PilotExpectedAction.PICKUP,
        expectedProductId: 'prod-x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.scenarios).toHaveLength(0);
  });

  it('records and re-records an operator result with attribution', async () => {
    const { harness, protocolId, detail } = await protocolWithScenario();
    const scenarioId = detail.scenarios[0].scenarioId;
    const recorded = await harness.service.recordScenarioResult(
      TENANT,
      protocolId,
      scenarioId,
      { result: CvTestScenarioResult.FAIL, liveSessionId: 'live-1' },
      'operator-1',
    );
    expect(recorded.scenarios[0].result).toBe(CvTestScenarioResult.FAIL);
    const rerecorded = await harness.service.recordScenarioResult(
      TENANT,
      protocolId,
      scenarioId,
      { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
      'operator-1',
    );
    expect(rerecorded.scenarios[0].result).toBe(CvTestScenarioResult.PASS);
    expect(harness.scenarios[0].resultById).toBe('operator-1');
    expect(harness.scenarios[0].resultAt).not.toBeNull();
  });

  it('a COMPLETED protocol accepts no more scenarios or results', async () => {
    const { harness, protocolId, detail } = await protocolWithScenario();
    await harness.service.recordScenarioResult(
      TENANT,
      protocolId,
      detail.scenarios[0].scenarioId,
      { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
    );
    await harness.service.setStatus(
      TENANT,
      protocolId,
      CvTestProtocolStatus.COMPLETED,
    );
    await expect(
      harness.service.addScenario(TENANT, protocolId, {
        scenarioType: CvTestScenarioType.SINGLE_RETURN,
        expectedAction: PilotExpectedAction.RETURN,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      harness.service.recordScenarioResult(
        TENANT,
        protocolId,
        detail.scenarios[0].scenarioId,
        { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CvTestProtocolService — validation report', () => {
  it('counts pass/fail/inconclusive/pending and reuses the Phase 15 summary VERBATIM', async () => {
    const harness = buildHarness({
      summary: SUMMARY,
      exportRows: 2,
      sessionPerformance: [{ fastMode: true }],
    });
    const created = await harness.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
      fastModeExpected: true,
    });
    for (const [type, action, result] of [
      [
        CvTestScenarioType.SINGLE_PICKUP,
        PilotExpectedAction.PICKUP,
        CvTestScenarioResult.PASS,
      ],
      [
        CvTestScenarioType.SINGLE_RETURN,
        PilotExpectedAction.RETURN,
        CvTestScenarioResult.FAIL,
      ],
      [
        CvTestScenarioType.FALSE_TOUCH_NO_PRODUCT_MOVED,
        PilotExpectedAction.NO_OP,
        null,
      ],
    ] as const) {
      const detail = await harness.service.addScenario(
        TENANT,
        created.protocolId,
        { scenarioType: type, expectedAction: action },
      );
      if (result) {
        await harness.service.recordScenarioResult(
          TENANT,
          created.protocolId,
          detail.scenarios[detail.scenarios.length - 1].scenarioId,
          { result, liveSessionId: 'live-1' },
        );
      }
    }
    const report = await harness.service.report(TENANT, created.protocolId);
    expect(report.scenarios).toEqual({
      total: 3,
      completed: 2,
      pending: 1,
      pass: 1,
      fail: 1,
      inconclusive: 0,
    });
    // The evaluation block is the Phase 15 summary object itself.
    expect(report.evaluation).toBe(SUMMARY as never);
    expect(harness.evaluations.summary).toHaveBeenCalledWith(TENANT, 'run-1');
    // Recall: (2 correct + 1 wrongSku + 0 wrongAction) / (3 + 1 missed).
    expect(report.detectionRecall).toBe(0.75);
    expect(report.datasetExport).toEqual({ available: true, rowCount: 2 });
    expect(report.fastModeExpected).toBe(true);
    expect(report.fastModeObserved).toBe(true);
    expect(report.safety).toMatchObject({ orders: 0, inventoryMovements: 0 });
    // Controlled JSON only.
    const raw = JSON.stringify(report);
    expect(raw).not.toContain('rtsp');
    expect(raw).not.toContain('://');
    expect(raw).not.toContain('CAMERA_');
  });

  it('an UNLINKED protocol reports null evaluation/export/recall — never fabricated', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, { name: 'p' });
    const report = await harness.service.report(TENANT, created.protocolId);
    expect(report.evaluation).toBeNull();
    expect(report.datasetExport).toBeNull();
    expect(report.detectionRecall).toBeNull();
    expect(report.fastModeObserved).toBeNull();
    expect(harness.evaluations.summary).not.toHaveBeenCalled();
  });

  it('fastModeObserved is null when sessions are mixed or unstamped', async () => {
    const harness = buildHarness({
      summary: SUMMARY,
      sessionPerformance: [{ fastMode: true }, { fastMode: false }],
    });
    const created = await harness.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
    });
    const report = await harness.service.report(TENANT, created.protocolId);
    expect(report.fastModeObserved).toBeNull();
  });
});

describe('CvTestProtocolService — Codex round 1 (source screening, binding, gating, consistency)', () => {
  it('protocol free text REJECTS source URLs, file paths, and media filenames — without echoing them', async () => {
    const harness = buildHarness();
    const scheme = 'rtsp' + '://';
    const cases = [
      scheme + 'host/path',
      'rtsps' + '://' + 'host/path',
      'file' + ':///tmp/camera.mp4',
      '/home/user/camera.mp4',
      'C:\\Users\\test\\camera.mp4',
      '\\\\server\\share\\clip.avi',
      'see camera.mp4 for footage',
    ];
    for (const value of cases) {
      const error = await harness.service
        .createProtocol(TENANT, { name: 'ok', description: value })
        .then(() => null)
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(BadRequestException);
      // The rejected value is NEVER echoed back.
      expect(error!.message).not.toContain('camera');
      expect(error!.message).not.toContain('host/path');
    }
    expect(harness.protocols).toHaveLength(0);
    // Normal human notes still pass.
    const created = await harness.service.createProtocol(TENANT, {
      name: 'Water bottle day',
      description: 'front shelf, second row, morning light',
    });
    expect(created.name).toBe('Water bottle day');
  });

  it('scenario results REQUIRE a session attached to the linked run; no run = controlled conflict', async () => {
    const harness = buildHarness();
    const noRun = await harness.service.createProtocol(TENANT, { name: 'p' });
    const detail = await harness.service.addScenario(TENANT, noRun.protocolId, {
      scenarioType: CvTestScenarioType.SINGLE_PICKUP,
      expectedAction: PilotExpectedAction.PICKUP,
    });
    // No evaluation run linked → conflict.
    await expect(
      harness.service.recordScenarioResult(
        TENANT,
        noRun.protocolId,
        detail.scenarios[0].scenarioId,
        { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await harness.service.linkEvaluationRun(TENANT, noRun.protocolId, 'run-1');
    // Missing session → 400.
    await expect(
      harness.service.recordScenarioResult(
        TENANT,
        noRun.protocolId,
        detail.scenarios[0].scenarioId,
        { result: CvTestScenarioResult.PASS },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Session NOT attached to the linked run → conflict.
    await expect(
      harness.service.recordScenarioResult(
        TENANT,
        noRun.protocolId,
        detail.scenarios[0].scenarioId,
        { result: CvTestScenarioResult.PASS, liveSessionId: 'live-unrelated' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Attached session → accepted and bound.
    const recorded = await harness.service.recordScenarioResult(
      TENANT,
      noRun.protocolId,
      detail.scenarios[0].scenarioId,
      { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
    );
    expect(recorded.scenarios[0].liveSessionId).toBe('live-1');
  });

  it('COMPLETION GATE: requires linked COMPLETED run, ≥1 scenario, and session-bound results on every scenario', async () => {
    // No run linked.
    const bare = buildHarness();
    const noRun = await bare.service.createProtocol(TENANT, { name: 'p' });
    await expect(
      bare.service.setStatus(
        TENANT,
        noRun.protocolId,
        CvTestProtocolStatus.COMPLETED,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Run linked but still OPEN.
    const openRun = buildHarness({ runStatus: 'OPEN' });
    const p2 = await openRun.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
    });
    await expect(
      openRun.service.setStatus(
        TENANT,
        p2.protocolId,
        CvTestProtocolStatus.COMPLETED,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Run COMPLETED but no scenarios.
    const noScenarios = buildHarness();
    const p3 = await noScenarios.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
    });
    await expect(
      noScenarios.service.setStatus(
        TENANT,
        p3.protocolId,
        CvTestProtocolStatus.COMPLETED,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Scenario pending (no result).
    const pending = buildHarness();
    const p4 = await pending.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
    });
    const d4 = await pending.service.addScenario(TENANT, p4.protocolId, {
      scenarioType: CvTestScenarioType.SINGLE_PICKUP,
      expectedAction: PilotExpectedAction.PICKUP,
    });
    await expect(
      pending.service.setStatus(
        TENANT,
        p4.protocolId,
        CvTestProtocolStatus.COMPLETED,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Fully resolved → completes.
    await pending.service.recordScenarioResult(
      TENANT,
      p4.protocolId,
      d4.scenarios[0].scenarioId,
      { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
    );
    const done = await pending.service.setStatus(
      TENANT,
      p4.protocolId,
      CvTestProtocolStatus.COMPLETED,
    );
    expect(done.status).toBe(CvTestProtocolStatus.COMPLETED);
    // CANCELLED needs no evidence (separate path unchanged).
    const cancel = buildHarness();
    const p5 = await cancel.service.createProtocol(TENANT, { name: 'p' });
    const cancelled = await cancel.service.setStatus(
      TENANT,
      p5.protocolId,
      CvTestProtocolStatus.CANCELLED,
    );
    expect(cancelled.status).toBe(CvTestProtocolStatus.CANCELLED);
  });

  it('contradictory scenario expectations are REJECTED for fixed templates; UNKNOWN_PRODUCT stays open', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, { name: 'p' });
    await expect(
      harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.SINGLE_RETURN,
        expectedAction: PilotExpectedAction.PICKUP,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.FALSE_TOUCH_NO_PRODUCT_MOVED,
        expectedAction: PilotExpectedAction.PICKUP,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.scenarios).toHaveLength(0);
    // Matching fixed actions pass.
    await harness.service.addScenario(TENANT, created.protocolId, {
      scenarioType: CvTestScenarioType.FALSE_TOUCH_NO_PRODUCT_MOVED,
      expectedAction: PilotExpectedAction.NO_OP,
    });
    // Open-ended template accepts any action.
    const open = await harness.service.addScenario(TENANT, created.protocolId, {
      scenarioType: CvTestScenarioType.UNKNOWN_PRODUCT,
      expectedAction: PilotExpectedAction.UNKNOWN,
    });
    expect(open.scenarios).toHaveLength(2);
  });
});

describe('CvTestProtocolService — Codex round 2 (relink guard, relative paths, atomic completion, NO_OP)', () => {
  it('relinking is allowed before results exist, REFUSED after — results untouched', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, {
      name: 'p',
      evaluationRunId: 'run-1',
    });
    const detail = await harness.service.addScenario(TENANT, created.protocolId, {
      scenarioType: CvTestScenarioType.SINGLE_PICKUP,
      expectedAction: PilotExpectedAction.PICKUP,
    });
    // No results yet → relink (to the same run is idempotent; the guard
    // is for CHANGING the run).
    await harness.service.linkEvaluationRun(TENANT, created.protocolId, 'run-1');
    // Record a result, then attempt to change the run.
    await harness.service.recordScenarioResult(
      TENANT,
      created.protocolId,
      detail.scenarios[0].scenarioId,
      { result: CvTestScenarioResult.PASS, liveSessionId: 'live-1' },
    );
    // A different (also valid-looking) run id must be refused. The stub
    // only knows run-1, so extend it for this call.
    harness.prisma.pilotEvaluationRun.findFirst.mockResolvedValueOnce({
      id: 'run-2',
      status: 'OPEN',
    });
    const error = await harness.service
      .linkEvaluationRun(TENANT, created.protocolId, 'run-2')
      .then(() => null)
      .catch((err: Error) => err);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error!.message).toContain('CV_TEST_PROTOCOL_RESULTS_EXIST');
    // The rejection cleared NOTHING.
    expect(harness.scenarios[0].result).toBe(CvTestScenarioResult.PASS);
    expect(harness.scenarios[0].liveSessionId).toBe('live-1');
    expect(harness.protocols[0].evaluationRunId).toBe('run-1');
    // Idempotent same-run relink still fine even with results.
    const same = await harness.service.linkEvaluationRun(
      TENANT,
      created.protocolId,
      'run-1',
    );
    expect(same.evaluationRunId).toBe('run-1');
  });

  it('relative and home-relative paths are rejected from protocol text — never echoed', async () => {
    const harness = buildHarness();
    const cases = [
      './recordings/camera',
      '../feeds/cam-a',
      'recordings/session',
      '~/streams/camera',
      'recordings\\session',
    ];
    for (const value of cases) {
      const error = await harness.service
        .createProtocol(TENANT, { name: 'ok', description: value })
        .then(() => null)
        .catch((err: Error) => err);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error!.message).not.toContain('recordings');
      expect(error!.message).not.toContain('feeds');
      expect(error!.message).not.toContain('streams');
    }
    expect(harness.protocols).toHaveLength(0);
    // Ordinary prose — including natural slash pairs — still passes.
    const created = await harness.service.createProtocol(TENANT, {
      name: 'ok',
      description: 'test low light pickup near shelf, note pass/fail per item',
    });
    expect(created.protocolId).toBeTruthy();
  });

  it('a protocol completed between addScenario’s pre-read and its transactional write does NOT gain the scenario (Codex P1)', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, { name: 'p' });
    // The pre-read (requireProtocol) sees DRAFT; a concurrent completion
    // lands before the transactional re-check. The in-tx status read is
    // the SECOND cvTestProtocol.findFirst call of addScenario.
    const original =
      harness.prisma.cvTestProtocol.findFirst.getMockImplementation() as (
        args: unknown,
      ) => Promise<unknown>;
    let reads = 0;
    harness.prisma.cvTestProtocol.findFirst.mockImplementation(
      async (args: unknown) => {
        reads += 1;
        if (reads === 2) {
          // Concurrent completion committed while this insert was on the
          // way to its transaction.
          harness.protocols[0].status = CvTestProtocolStatus.CANCELLED;
        }
        return original(args);
      },
    );
    await expect(
      harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.SINGLE_PICKUP,
        expectedAction: PilotExpectedAction.PICKUP,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // The terminal protocol gained NO scenario.
    expect(harness.scenarios).toHaveLength(0);
    // Both the insert and the completion path take the SAME advisory
    // lock inside a transaction — the serialization primitive is pinned.
    expect(harness.prisma.$transaction).toHaveBeenCalled();
    expect(harness.prisma.$queryRaw).toHaveBeenCalled();
  });

  it('UNKNOWN_PRODUCT accepts UNKNOWN/PICKUP/RETURN and rejects NO_OP (Codex P2)', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProtocol(TENANT, { name: 'p' });
    for (const action of [
      PilotExpectedAction.UNKNOWN,
      PilotExpectedAction.PICKUP,
      PilotExpectedAction.RETURN,
    ]) {
      await harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.UNKNOWN_PRODUCT,
        expectedAction: action,
      });
    }
    expect(harness.scenarios).toHaveLength(3);
    await expect(
      harness.service.addScenario(TENANT, created.protocolId, {
        scenarioType: CvTestScenarioType.UNKNOWN_PRODUCT,
        expectedAction: PilotExpectedAction.NO_OP,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.scenarios).toHaveLength(3);
  });
});
