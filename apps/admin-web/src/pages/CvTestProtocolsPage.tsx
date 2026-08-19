import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  CvTestProtocolDetail,
  CvTestProtocolReport,
  CvTestProtocolView,
  CvTestScenarioResult,
  CvTestScenarioType,
  PilotExpectedAction,
  api,
} from '../api';
import { Page, formatDate, useLoad } from '../components';
import { formatAccuracy } from '../pilot-evaluation-utils';
import { protocolStatusTone, scenarioResultTone } from '../cv-test-protocol-utils';

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
  const protocols = useLoad<CvTestProtocolView[]>(
    () => api('/cv-test-protocols'),
    [reload],
  );

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
        },
      });
      setName('');
      setDescription('');
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
            <Link to="/review-queue">Review queue →</Link>
          </p>

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
                onChange={(e) =>
                  setExpectedAction(e.target.value as PilotExpectedAction)
                }
              >
                {ACTIONS.map((option) => (
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
                            disabled={busy}
                            onClick={() =>
                              void action(() =>
                                api(
                                  `/cv-test-protocols/${id}/scenarios/${scenario.scenarioId}/result`,
                                  {
                                    method: 'POST',
                                    body: { result },
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
