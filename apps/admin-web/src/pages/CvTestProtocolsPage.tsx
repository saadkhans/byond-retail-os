import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  CameraSourceView,
  CvTestProtocolDetail,
  CvTestProtocolReport,
  CvTestProtocolView,
  CvTestScenarioResult,
  CvTestScenarioType,
  LiveTestPreflight,
  Paginated,
  PilotEvaluationDetail,
  PilotExpectedAction,
  Store,
  api,
} from '../api';
import { Page, formatDate, useLoad } from '../components';
import { formatAccuracy } from '../pilot-evaluation-utils';
import { protocolStatusTone, scenarioResultTone } from '../cv-test-protocol-utils';
import {
  formatWarning,
  preflightCalibrationSummary,
} from '../camera-calibration-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

const SCENARIO_TYPES: CvTestScenarioType[] = [
  'SINGLE_PICKUP',
  'SINGLE_RETURN',
  'FALSE_TOUCH_NO_PRODUCT_MOVED',
  'MISSED_PICKUP',
  'MISSED_RETURN',
  'TWO_PRODUCTS_VISIBLE_ONE_PICKED',
  'SIMILAR_SKU_CONFUSION',
  'MULTI_QUANTITY_PICKUP',
  'HAND_OCCLUSION',
  'FAST_PICKUP',
  'SLOW_PICKUP',
  'LOW_LIGHT',
  'BAD_ANGLE',
  'EMPTY_SHELF',
  'UNKNOWN_PRODUCT',
];
const ACTIONS: PilotExpectedAction[] = ['PICKUP', 'RETURN', 'NO_OP', 'UNKNOWN'];
const RESULTS: CvTestScenarioResult[] = ['PASS', 'FAIL', 'INCONCLUSIVE'];

/** Fixed expected actions per template (mirrors the backend rule): the
 *  select locks to the template's ground truth; only open-ended
 *  templates stay configurable. */
const FIXED_ACTIONS: Partial<Record<CvTestScenarioType, PilotExpectedAction>> = {
  SINGLE_PICKUP: 'PICKUP',
  MISSED_PICKUP: 'PICKUP',
  TWO_PRODUCTS_VISIBLE_ONE_PICKED: 'PICKUP',
  SIMILAR_SKU_CONFUSION: 'PICKUP',
  MULTI_QUANTITY_PICKUP: 'PICKUP',
  HAND_OCCLUSION: 'PICKUP',
  FAST_PICKUP: 'PICKUP',
  SLOW_PICKUP: 'PICKUP',
  LOW_LIGHT: 'PICKUP',
  BAD_ANGLE: 'PICKUP',
  SINGLE_RETURN: 'RETURN',
  MISSED_RETURN: 'RETURN',
  FALSE_TOUCH_NO_PRODUCT_MOVED: 'NO_OP',
  EMPTY_SHELF: 'NO_OP',
};

/**
 * Phase 16 — live CV test protocols (SHADOW ONLY). Scripted real-footage
 * scenarios with expected outcomes, wrapped around the Phase 15
 * evaluation loop. No secrets, URLs, or source strings anywhere.
 */
export function CvTestProtocolsPage() {
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [locationId, setLocationId] = useState('');
  const [cameraSourceId, setCameraSourceId] = useState('');
  const [fastModeExpected, setFastModeExpected] = useState('');
  const protocols = useLoad<CvTestProtocolView[]>(
    () => api('/cv-test-protocols'),
    [reload],
  );
  // Store/camera pickers (ids + names only — no source strings).
  const stores = useLoad<Paginated<Store>>(() => api('/stores?take=50'), []);
  const cameras = useLoad<CameraSourceView[]>(() => api('/camera-sources'), []);

  async function createProtocol() {
    if (!name.trim()) {
      setActionError('Name is required');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api('/cv-test-protocols', {
        method: 'POST',
        body: {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(locationId ? { locationId } : {}),
          ...(cameraSourceId ? { cameraSourceId } : {}),
          ...(fastModeExpected
            ? { fastModeExpected: fastModeExpected === 'on' }
            : {}),
        },
      });
      setName('');
      setDescription('');
      setLocationId('');
      setCameraSourceId('');
      setFastModeExpected('');
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="CV test protocols (shadow)"
      error={protocols.error}
      loading={protocols.loading && !protocols.data}
    >
      <p className="muted">
        Script repeatable real-footage tests, run them under an evaluation
        run, and report honestly. Shadow mode — no billing or inventory
        mutation.
      </p>
      {actionError ? <div className="error">{actionError}</div> : null}
      <div className="form-row">
        <input
          placeholder="Protocol name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Store (optional)</option>
          {(stores.data?.items ?? []).map((store) => (
            <option key={store.id} value={store.id}>
              {store.name}
            </option>
          ))}
        </select>
        <select
          value={cameraSourceId}
          onChange={(e) => setCameraSourceId(e.target.value)}
        >
          <option value="">Camera source (optional)</option>
          {(cameras.data ?? []).map((camera) => (
            <option key={camera.id} value={camera.id}>
              {camera.name}
            </option>
          ))}
        </select>
        <select
          value={fastModeExpected}
          onChange={(e) => setFastModeExpected(e.target.value)}
        >
          <option value="">Fast mode: not specified</option>
          <option value="on">Fast mode: expected ON</option>
          <option value="off">Fast mode: expected OFF</option>
        </select>
        <button className="primary" disabled={busy} onClick={() => void createProtocol()}>
          Create protocol
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Store</th>
            <th>Camera</th>
            <th>Scenarios</th>
            <th>Evaluation run</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {(protocols.data ?? []).map((protocol) => (
            <tr key={protocol.protocolId}>
              <td>
                <Link to={`/cv-test-protocols/${protocol.protocolId}`}>
                  {protocol.name}
                </Link>
              </td>
              <td>
                <span className={`badge ${protocolStatusTone(protocol.status)}`}>
                  {protocol.status}
                </span>
              </td>
              <td>{protocol.locationName ?? '—'}</td>
              <td>{protocol.cameraSourceName ?? '—'}</td>
              <td>{protocol.scenarioCount}</td>
              <td>
                {protocol.evaluationRunId ? (
                  <Link to={`/pilot-evaluations/${protocol.evaluationRunId}`}>
                    open →
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{formatDate(protocol.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(protocols.data ?? []).length === 0 ? (
        <p className="muted">No test protocols yet — create one above.</p>
      ) : null}
    </Page>
  );
}

export function CvTestProtocolDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [linkRunId, setLinkRunId] = useState('');
  const [scenarioType, setScenarioType] =
    useState<CvTestScenarioType>('SINGLE_PICKUP');
  const [expectedAction, setExpectedAction] =
    useState<PilotExpectedAction>('PICKUP');
  const [expectedProductId, setExpectedProductId] = useState('');
  const [notes, setNotes] = useState('');

  const [resultSessionId, setResultSessionId] = useState('');
  const [preflight, setPreflight] = useState<LiveTestPreflight | null>(null);

  const detail = useLoad<CvTestProtocolDetail>(
    () => api(`/cv-test-protocols/${id}`),
    [id, tick],
  );
  const report = useLoad<CvTestProtocolReport>(
    () => api(`/cv-test-protocols/${id}/report`),
    [id, tick],
  );
  const data = detail.data;
  const open = data?.status === 'DRAFT' || data?.status === 'ACTIVE';
  // Attached sessions of the linked evaluation run — every scenario
  // result must name one of these.
  const runDetail = useLoad<PilotEvaluationDetail | null>(
    () =>
      data?.evaluationRunId
        ? api(`/pilot-evaluations/${data.evaluationRunId}`)
        : Promise.resolve(null),
    [data?.evaluationRunId, tick],
  );
  const attachedSessions = runDetail.data?.sessions ?? [];
  // Exactly one attached session → default the result binding to it.
  useEffect(() => {
    if (attachedSessions.length === 1) {
      setResultSessionId(attachedSessions[0].liveSessionId);
    }
  }, [attachedSessions.length, attachedSessions[0]?.liveSessionId]);
  // The scenario-type template locks its expected action; UNKNOWN_PRODUCT
  // is open-ended over PRODUCT interactions only (never NO_OP).
  const fixedAction = FIXED_ACTIONS[scenarioType];
  const allowedActions: PilotExpectedAction[] =
    fixedAction !== undefined
      ? [fixedAction]
      : scenarioType === 'UNKNOWN_PRODUCT'
        ? ['UNKNOWN', 'PICKUP', 'RETURN']
        : ACTIONS;
  useEffect(() => {
    if (fixedAction) {
      setExpectedAction(fixedAction);
    } else if (
      scenarioType === 'UNKNOWN_PRODUCT' &&
      expectedAction === 'NO_OP'
    ) {
      setExpectedAction('UNKNOWN');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedAction, scenarioType]);

  async function runPreflight() {
    if (!data?.cameraSourceId) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const expected =
        data.fastModeExpected === null
          ? ''
          : `&fastModeExpected=${data.fastModeExpected}`;
      setPreflight(
        await api<LiveTestPreflight>(
          `/camera-sources/${data.cameraSourceId}/live-test-preflight?x=1${expected}${
            data.evaluationRunId
              ? `&evaluationRunId=${data.evaluationRunId}`
              : ''
          }`,
        ),
      );
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setTick((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="CV test protocol (shadow)"
      error={detail.error}
      loading={detail.loading && !data}
    >
      {actionError ? <div className="error">{actionError}</div> : null}
      {data ? (
        <div className="detail">
          <div>
            <span className={`badge ${protocolStatusTone(data.status)}`}>
              {data.status}
            </span>{' '}
            <strong>{data.name}</strong>{' '}
            <span className="muted">
              {data.description ?? ''} · created {formatDate(data.createdAt)}
              {data.cameraSourceName ? ` · camera ${data.cameraSourceName}` : ''}
              {data.fastModeExpected !== null
                ? ` · expects fast mode ${data.fastModeExpected ? 'ON' : 'OFF'}`
                : ''}
            </span>{' '}
            {data.status === 'DRAFT' ? (
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    api(`/cv-test-protocols/${id}/status`, {
                      method: 'POST',
                      body: { status: 'ACTIVE' },
                    }),
                  )
                }
              >
                Activate
              </button>
            ) : null}{' '}
            {open ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/cv-test-protocols/${id}/status`, {
                        method: 'POST',
                        body: { status: 'COMPLETED' },
                      }),
                    )
                  }
                >
                  Complete
                </button>{' '}
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/cv-test-protocols/${id}/status`, {
                        method: 'POST',
                        body: { status: 'CANCELLED' },
                      }),
                    )
                  }
                >
                  Cancel
                </button>
              </>
            ) : null}
          </div>

          <p>
            {data.evaluationRunId ? (
              <>
                <Link to={`/pilot-evaluations/${data.evaluationRunId}`}>
                  Evaluation run (review / missed events / export) →
                </Link>{' '}
              </>
            ) : (
              <span className="muted">no evaluation run linked · </span>
            )}
            <Link to="/live-sessions">Live sessions →</Link>{' '}
            <Link to="/review-queue">Review queue →</Link>{' '}
            {data.cameraSourceId ? (
              <button disabled={busy} onClick={() => void runPreflight()}>
                Run preflight
              </button>
            ) : null}
          </p>
          {preflight ? (
            (() => {
              const calibration = preflightCalibrationSummary(preflight);
              return (
                <>
                  <p className="muted">
                    Preflight:{' '}
                    <span className={`badge ${preflight.ready ? 'ok' : 'down'}`}>
                      {preflight.ready ? 'READY' : 'NOT READY'}
                    </span>{' '}
                    source {preflight.sourceExists ? 'ok' : 'missing'} · active{' '}
                    {preflight.sourceActive ? 'yes' : 'no'} · configured{' '}
                    {preflight.sourceConfigured ? 'yes' : 'no'} · ffmpeg{' '}
                    {preflight.ffmpegAvailable ? 'yes' : 'no'} · free{' '}
                    {preflight.noActiveLiveSession ? 'yes' : 'session active'} ·
                    fast mode {preflight.fastModeActive ? 'ON' : 'OFF'}
                    {preflight.fastModeMatches === false
                      ? ' (MISMATCH with expectation)'
                      : ''}{' '}
                    · pilot runner{' '}
                    {preflight.pilotRunnerEnabled
                      ? 'enabled'
                      : 'disabled (manual ok)'}
                    {preflight.evaluationRunExists === false
                      ? ' · evaluation run missing'
                      : ''}{' '}
                    · calibration{' '}
                    <span className={`badge ${calibration.tone}`}>
                      {calibration.label}
                    </span>{' '}
                    <Link to={`/camera-calibration/${preflight.cameraSourceId}`}>
                      calibration →
                    </Link>
                  </p>
                  {calibration.warnings.length > 0 ? (
                    <ul>
                      {calibration.warnings.map((warning) => (
                        <li key={warning} className="muted">
                          {formatWarning(warning)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              );
            })()
          ) : null}

          {open ? (
            <div className="form-row">
              <input
                placeholder="Evaluation run id to link"
                value={linkRunId}
                onChange={(e) => setLinkRunId(e.target.value)}
              />
              <button
                disabled={busy || !linkRunId.trim()}
                onClick={() =>
                  void action(() =>
                    api(`/cv-test-protocols/${id}/evaluation-run`, {
                      method: 'POST',
                      body: { evaluationRunId: linkRunId.trim() },
                    }),
                  ).then(() => setLinkRunId(''))
                }
              >
                Link evaluation run
              </button>
            </div>
          ) : null}

          <h2>Scenario checklist ({data.scenarios.length})</h2>
          {open ? (
            <p className="muted">
              Results are recorded against the evaluated session:{' '}
              <select
                value={resultSessionId}
                onChange={(e) => setResultSessionId(e.target.value)}
              >
                <option value="">
                  {attachedSessions.length === 0
                    ? 'no sessions attached to the linked run yet'
                    : 'select session'}
                </option>
                {attachedSessions.map((session) => (
                  <option key={session.liveSessionId} value={session.liveSessionId}>
                    {session.liveSessionId} ({session.status})
                  </option>
                ))}
              </select>
            </p>
          ) : null}
          {open ? (
            <div className="form-row">
              <select
                value={scenarioType}
                onChange={(e) =>
                  setScenarioType(e.target.value as CvTestScenarioType)
                }
              >
                {SCENARIO_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <select
                value={expectedAction}
                disabled={fixedAction !== undefined}
                title={
                  fixedAction !== undefined
                    ? 'Expected action is fixed by the scenario template'
                    : undefined
                }
                onChange={(e) =>
                  setExpectedAction(e.target.value as PilotExpectedAction)
                }
              >
                {allowedActions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <input
                placeholder="Expected product id (optional)"
                value={expectedProductId}
                onChange={(e) => setExpectedProductId(e.target.value)}
              />
              <input
                placeholder="Notes (optional, screened)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    api(`/cv-test-protocols/${id}/scenarios`, {
                      method: 'POST',
                      body: {
                        scenarioType,
                        expectedAction,
                        ...(expectedProductId.trim()
                          ? { expectedProductId: expectedProductId.trim() }
                          : {}),
                        ...(notes.trim() ? { notes: notes.trim() } : {}),
                      },
                    }),
                  ).then(() => {
                    setExpectedProductId('');
                    setNotes('');
                  })
                }
              >
                Add scenario
              </button>
            </div>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Expected</th>
                <th>SKU</th>
                <th>Notes</th>
                <th>Result</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {data.scenarios.map((scenario) => (
                <tr key={scenario.scenarioId}>
                  <td>{scenario.scenarioType}</td>
                  <td>
                    {scenario.expectedAction}
                    {scenario.expectedQuantity
                      ? ` ×${scenario.expectedQuantity}`
                      : ''}
                  </td>
                  <td>
                    {scenario.expectedSku ?? '—'}{' '}
                    <span className="muted">
                      {scenario.expectedProductName ?? ''}
                    </span>
                  </td>
                  <td>{scenario.notes ?? '—'}</td>
                  <td>
                    {scenario.result ? (
                      <span
                        className={`badge ${scenarioResultTone(scenario.result)}`}
                      >
                        {scenario.result}
                      </span>
                    ) : (
                      <span className="muted">pending</span>
                    )}
                  </td>
                  <td>
                    {open
                      ? RESULTS.map((result) => (
                          <button
                            key={result}
                            disabled={busy || !resultSessionId}
                            title={
                              resultSessionId
                                ? `Record ${result} for session ${resultSessionId}`
                                : 'Select the evaluated session first'
                            }
                            onClick={() =>
                              void action(() =>
                                api(
                                  `/cv-test-protocols/${id}/scenarios/${scenario.scenarioId}/result`,
                                  {
                                    method: 'POST',
                                    body: {
                                      result,
                                      liveSessionId: resultSessionId,
                                    },
                                  },
                                ),
                              )
                            }
                          >
                            {result[0]}
                          </button>
                        ))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.scenarios.length === 0 ? (
            <p className="muted">No scenarios yet — add the checklist above.</p>
          ) : null}

          <h2>Validation report</h2>
          {report.data ? (
            <>
              <div className="cards">
                {[
                  {
                    label: 'Scenarios pass / fail / inconclusive',
                    value: `${report.data.scenarios.pass} / ${report.data.scenarios.fail} / ${report.data.scenarios.inconclusive}`,
                  },
                  {
                    label: 'Scenarios completed / total',
                    value: `${report.data.scenarios.completed} / ${report.data.scenarios.total}`,
                  },
                  {
                    label: 'Detection recall',
                    value: formatAccuracy(report.data.detectionRecall),
                  },
                  {
                    label: 'SKU accuracy',
                    value: formatAccuracy(
                      report.data.evaluation?.accuracy.sku ?? null,
                    ),
                  },
                  {
                    label: 'Action accuracy',
                    value: formatAccuracy(
                      report.data.evaluation?.accuracy.action ?? null,
                    ),
                  },
                  {
                    label: 'Fast mode (expected · observed)',
                    value: `${
                      report.data.fastModeExpected === null
                        ? '—'
                        : report.data.fastModeExpected
                          ? 'ON'
                          : 'OFF'
                    } · ${
                      report.data.fastModeObserved === null
                        ? 'unknown'
                        : report.data.fastModeObserved
                          ? 'ON'
                          : 'OFF'
                    }`,
                  },
                  {
                    label: 'Dataset export',
                    value: report.data.datasetExport
                      ? report.data.datasetExport.available
                        ? `${report.data.datasetExport.rowCount} rows ready`
                        : 'no exportable rows yet'
                      : 'no evaluation run',
                  },
                ].map((tile) => (
                  <div key={tile.label} className="card">
                    <div className="value">{tile.value}</div>
                    <div className="label">{tile.label}</div>
                  </div>
                ))}
              </div>
              {report.data.evaluation ? (
                <p className="muted">
                  Reviewed {report.data.evaluation.totals.reviewed} /{' '}
                  {report.data.evaluation.totals.observations} observations ·
                  missed {report.data.evaluation.totals.missedEvents} · false
                  touches {report.data.evaluation.totals.falseTouch} · slowest
                  stage{' '}
                  {report.data.evaluation.latency.combined?.slowestStage
                    ? `${report.data.evaluation.latency.combined.slowestStage.stage} (p95 ${report.data.evaluation.latency.combined.slowestStage.p95Ms}ms)`
                    : 'unknown'}
                </p>
              ) : (
                <p className="muted">
                  Link an evaluation run to see review metrics.
                </p>
              )}
              <p className="muted">
                Safety — mutations from CV: orders {report.data.safety.orders}{' '}
                · checkout {report.data.safety.checkoutSessions} · payment
                intents {report.data.safety.paymentIntents} · payment events{' '}
                {report.data.safety.paymentEvents} · inventory{' '}
                {report.data.safety.inventoryMovements} (structural —
                shadow-mode guard)
              </p>
            </>
          ) : report.error ? (
            <p className="muted">Validation report unavailable.</p>
          ) : (
            <p className="muted">Report loading…</p>
          )}

          <p className="muted">
            Shadow mode — protocols organize testing only; CV decisions
            never read them; no billing or inventory mutation; no stream
            URLs or credentials anywhere.
          </p>
        </div>
      ) : null}
    </Page>
  );
}
