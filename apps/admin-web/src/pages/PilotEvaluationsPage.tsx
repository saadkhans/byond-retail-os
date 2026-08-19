import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  PilotDatasetExport,
  PilotEvaluationDetail,
  PilotEvaluationRunView,
  PilotEvaluationSummary,
  PilotExpectedAction,
  PilotObservationsResponse,
  PilotVerdict,
  api,
} from '../api';
import { Page, formatDate, useLoad } from '../components';
import { decisionTone } from '../cv-evaluation-utils';
import { liveSessionStatusTone } from '../camera-utils';
import {
  evaluationStatusTone,
  formatAccuracy,
  verdictTone,
} from '../pilot-evaluation-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/**
 * Phase 15 — pilot evaluation loop (SHADOW ONLY). Evaluation runs group
 * live sessions; operators label live CV observations (append-only);
 * accuracy/confusion/latency summaries and the JSONL dataset export
 * read those labels. No secrets, URLs, or source strings anywhere.
 */
export function PilotEvaluationsPage() {
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const runs = useLoad<PilotEvaluationRunView[]>(
    () => api('/pilot-evaluations'),
    [reload],
  );

  async function createRun() {
    if (!name.trim()) {
      setActionError('Name is required');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api('/pilot-evaluations', {
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
      title="Pilot evaluations (shadow)"
      error={runs.error}
      loading={runs.loading && !runs.data}
    >
      <p className="muted">
        Group live sessions into evaluation runs, review/correct CV
        observations, and export confirmed labels as a training dataset.
        Shadow mode — no billing or inventory mutation.
      </p>
      {actionError ? <div className="error">{actionError}</div> : null}
      <div className="form-row">
        <input
          placeholder="Evaluation name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button className="primary" disabled={busy} onClick={() => void createRun()}>
          Create evaluation run
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Store</th>
            <th>Sessions</th>
            <th>Reviews</th>
            <th>Created</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          {(runs.data ?? []).map((run) => (
            <tr key={run.evaluationRunId}>
              <td>
                <Link to={`/pilot-evaluations/${run.evaluationRunId}`}>
                  {run.name}
                </Link>
              </td>
              <td>
                <span className={`badge ${evaluationStatusTone(run.status)}`}>
                  {run.status}
                </span>
              </td>
              <td>{run.locationName ?? '—'}</td>
              <td>{run.sessionCount}</td>
              <td>{run.reviewCount}</td>
              <td>{formatDate(run.createdAt)}</td>
              <td>{run.completedAt ? formatDate(run.completedAt) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(runs.data ?? []).length === 0 ? (
        <p className="muted">No evaluation runs yet — create one above.</p>
      ) : null}
    </Page>
  );
}

const VERDICTS: PilotVerdict[] = [
  'CORRECT',
  'INCORRECT',
  'UNCERTAIN',
  'FALSE_TOUCH',
  'WRONG_SKU',
  'WRONG_ACTION',
];
const ACTIONS: PilotExpectedAction[] = ['PICKUP', 'RETURN', 'NO_OP', 'UNKNOWN'];

export function PilotEvaluationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [attachId, setAttachId] = useState('');
  const [reviewEventId, setReviewEventId] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<PilotVerdict>('CORRECT');
  const [expectedAction, setExpectedAction] =
    useState<PilotExpectedAction>('PICKUP');
  const [expectedProductId, setExpectedProductId] = useState('');
  const [notes, setNotes] = useState('');
  // MISSED-EVENT entry (Codex P1): a false negative has no observation
  // to attach to — it is recorded against an attached SESSION.
  const [missedSessionId, setMissedSessionId] = useState('');
  const [missedAction, setMissedAction] =
    useState<PilotExpectedAction>('PICKUP');
  const [missedProductId, setMissedProductId] = useState('');
  const [missedNotes, setMissedNotes] = useState('');

  const detail = useLoad<PilotEvaluationDetail>(
    () => api(`/pilot-evaluations/${id}`),
    [id, tick],
  );
  const observations = useLoad<PilotObservationsResponse>(
    () => api(`/pilot-evaluations/${id}/observations`),
    [id, tick],
  );
  const summary = useLoad<PilotEvaluationSummary>(
    () => api(`/pilot-evaluations/${id}/summary`),
    [id, tick],
  );
  const data = detail.data;
  const open = data?.status === 'OPEN';

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

  async function submitMissedEvent() {
    if (!missedSessionId) {
      setActionError('Select the session the missed event happened in');
      return;
    }
    await action(() =>
      api(`/pilot-evaluations/${id}/reviews`, {
        method: 'POST',
        body: {
          verdict: 'MISSED_EVENT',
          expectedAction: missedAction,
          liveSessionId: missedSessionId,
          ...(missedProductId.trim()
            ? { expectedProductId: missedProductId.trim() }
            : {}),
          ...(missedNotes.trim() ? { notes: missedNotes.trim() } : {}),
        },
      }),
    );
    setMissedProductId('');
    setMissedNotes('');
  }

  async function submitReview() {
    if (!reviewEventId) {
      return;
    }
    await action(() =>
      api(`/pilot-evaluations/${id}/reviews`, {
        method: 'POST',
        body: {
          verdict,
          expectedAction,
          journeyEventId: reviewEventId,
          ...(expectedProductId.trim()
            ? { expectedProductId: expectedProductId.trim() }
            : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      }),
    );
    setReviewEventId(null);
    setExpectedProductId('');
    setNotes('');
  }

  async function downloadDataset() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await api<PilotDatasetExport>(
        `/pilot-evaluations/${id}/dataset-export`,
      );
      const blob = new Blob([result.manifest], {
        type: 'application/x-ndjson',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `pilot-dataset-${id}.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="Pilot evaluation (shadow)"
      error={detail.error}
      loading={detail.loading && !data}
    >
      {actionError ? <div className="error">{actionError}</div> : null}
      {data ? (
        <div className="detail">
          <div>
            <span className={`badge ${evaluationStatusTone(data.status)}`}>
              {data.status}
            </span>{' '}
            <strong>{data.name}</strong>{' '}
            <span className="muted">
              {data.description ?? ''} · created {formatDate(data.createdAt)}
              {data.completedAt
                ? ` · closed ${formatDate(data.completedAt)}`
                : ''}
            </span>{' '}
            {open ? (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/pilot-evaluations/${id}/status`, {
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
                      api(`/pilot-evaluations/${id}/status`, {
                        method: 'POST',
                        body: { status: 'CANCELLED' },
                      }),
                    )
                  }
                >
                  Cancel
                </button>
              </>
            ) : null}{' '}
            <button className="primary" disabled={busy} onClick={() => void downloadDataset()}>
              Export dataset (JSONL)
            </button>
          </div>

          {open ? (
            <div className="form-row">
              <input
                placeholder="Live session id to attach"
                value={attachId}
                onChange={(e) => setAttachId(e.target.value)}
              />
              <button
                disabled={busy || !attachId.trim()}
                onClick={() =>
                  void action(() =>
                    api(`/pilot-evaluations/${id}/sessions`, {
                      method: 'POST',
                      body: { liveSessionId: attachId.trim() },
                    }),
                  ).then(() => setAttachId(''))
                }
              >
                Attach session
              </button>
            </div>
          ) : null}

          <h2>Linked live sessions ({data.sessions.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th>Decision</th>
                <th>Frames</th>
                <th>Windows det/proc</th>
                <th>Review needed</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((session) => (
                <tr key={session.liveSessionId}>
                  <td>
                    <Link to={`/live-sessions/${session.liveSessionId}`}>
                      {session.liveSessionId}
                    </Link>
                  </td>
                  <td>
                    <span
                      className={`badge ${liveSessionStatusTone(session.status)}`}
                    >
                      {session.status}
                    </span>
                  </td>
                  <td>
                    {session.decision ? (
                      <span className={`badge ${decisionTone(session.decision)}`}>
                        {session.decision}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{session.framesSampled}</td>
                  <td>
                    {session.eventWindowsDetected} /{' '}
                    {session.eventWindowsProcessed}
                  </td>
                  <td>{session.reviewNeeded}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Accuracy</h2>
          {summary.data ? (
            <>
              <div className="cards">
                {[
                  {
                    label: 'Action accuracy',
                    value: formatAccuracy(summary.data.accuracy.action),
                  },
                  {
                    label: 'SKU accuracy',
                    value: formatAccuracy(summary.data.accuracy.sku),
                  },
                  {
                    label: 'Combined accuracy',
                    value: formatAccuracy(summary.data.accuracy.combined),
                  },
                  {
                    label: 'Reviewed / observations',
                    value: `${summary.data.totals.reviewed} / ${summary.data.totals.observations}`,
                  },
                  {
                    label: 'Correct · wrong SKU · wrong action',
                    value: `${summary.data.totals.correct} · ${summary.data.totals.wrongSku} · ${summary.data.totals.wrongAction}`,
                  },
                  {
                    label: 'Uncertain · false touch · missed',
                    value: `${summary.data.totals.uncertain} · ${summary.data.totals.falseTouch} · ${summary.data.totals.missedEvents}`,
                  },
                ].map((tile) => (
                  <div key={tile.label} className="card">
                    <div className="value">{tile.value}</div>
                    <div className="label">{tile.label}</div>
                  </div>
                ))}
              </div>

              <h2>Confusion (predicted → expected)</h2>
              {summary.data.confusion.sku.length > 0 ||
              summary.data.confusion.action.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Predicted</th>
                      <th>Expected</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.confusion.action.map((row) => (
                      <tr key={`a-${row.predicted}-${row.expected}`}>
                        <td>Action</td>
                        <td>{row.predicted}</td>
                        <td>{row.expected}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                    {summary.data.confusion.sku.map((row) => (
                      <tr key={`s-${row.predicted}-${row.expected}`}>
                        <td>SKU</td>
                        <td>{row.predicted}</td>
                        <td>{row.expected}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">No reviewed observations yet.</p>
              )}

              <h2>Latency</h2>
              {summary.data.latency.sessions.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Event→review p50/p95/max</th>
                      <th>Fusion p50/p95/max</th>
                      <th>Import p50/p95/max</th>
                      <th>Slowest stage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.latency.sessions.map((row) => (
                      <tr key={row.liveSessionId}>
                        <td>{row.liveSessionId}</td>
                        <td>
                          {row.eventToReview
                            ? `${row.eventToReview.p50Ms} / ${row.eventToReview.p95Ms} / ${row.eventToReview.maxMs}ms`
                            : '—'}
                        </td>
                        <td>
                          {row.fusion
                            ? `${row.fusion.p50Ms} / ${row.fusion.p95Ms} / ${row.fusion.maxMs}ms`
                            : '—'}
                        </td>
                        <td>
                          {row.journeyImport
                            ? `${row.journeyImport.p50Ms} / ${row.journeyImport.p95Ms} / ${row.journeyImport.maxMs}ms`
                            : '—'}
                        </td>
                        <td>
                          {row.slowestStage
                            ? `${row.slowestStage.stage} (p95 ${row.slowestStage.p95Ms}ms)`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">No sessions attached yet.</p>
              )}

              <p className="muted">
                Safety — mutations from CV: orders{' '}
                {summary.data.safety.orders} · checkout{' '}
                {summary.data.safety.checkoutSessions} · payment intents{' '}
                {summary.data.safety.paymentIntents} · payment events{' '}
                {summary.data.safety.paymentEvents} · inventory{' '}
                {summary.data.safety.inventoryMovements} (structural —
                shadow-mode guard)
              </p>
            </>
          ) : summary.error ? (
            <p className="muted">Summary unavailable.</p>
          ) : (
            <p className="muted">Summary loading…</p>
          )}

          <h2>
            Observations (
            {observations.data ? observations.data.observations.length : '…'})
          </h2>
          {observations.data ? (
            <table>
              <thead>
                <tr>
                  <th>Occurred</th>
                  <th>Type</th>
                  <th>Predicted SKU</th>
                  <th>Score</th>
                  <th>Review</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {observations.data.observations.map((row) => (
                  <tr key={row.journeyEventId}>
                    <td>{formatDate(row.occurredAt)}</td>
                    <td>{row.eventType}</td>
                    <td>
                      {row.predictedSku ?? '—'}{' '}
                      <span className="muted">
                        {row.predictedProductName ?? ''}
                      </span>
                    </td>
                    <td>{row.matchScore?.toFixed(2) ?? '—'}</td>
                    <td>
                      {row.latestReview ? (
                        <span
                          className={`badge ${verdictTone(row.latestReview.verdict)}`}
                        >
                          {row.latestReview.verdict}
                        </span>
                      ) : (
                        <span className="muted">unreviewed</span>
                      )}
                    </td>
                    <td>
                      {open ? (
                        <button
                          disabled={busy}
                          onClick={() => setReviewEventId(row.journeyEventId)}
                        >
                          {row.latestReview ? 'Re-review' : 'Review'}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Observations loading…</p>
          )}

          {reviewEventId ? (
            <div className="form-row">
              <span className="muted">Reviewing {reviewEventId}:</span>
              <select
                value={verdict}
                onChange={(e) => setVerdict(e.target.value as PilotVerdict)}
              >
                {VERDICTS.map((option) => (
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
                placeholder="Expected product id (for corrections)"
                value={expectedProductId}
                onChange={(e) => setExpectedProductId(e.target.value)}
              />
              <input
                placeholder="Notes (optional, screened)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <button
                className="primary"
                disabled={busy}
                onClick={() => void submitReview()}
              >
                Submit review
              </button>
              <button disabled={busy} onClick={() => setReviewEventId(null)}>
                Close
              </button>
            </div>
          ) : null}

          <h2>
            Record missed event (
            {observations.data ? observations.data.missedEvents.length : '…'}{' '}
            recorded)
          </h2>
          <p className="muted">
            An interaction the CV never detected — recorded against the
            session it happened in (no observation exists to attach it to).
          </p>
          {open ? (
            <div className="form-row">
              <select
                value={missedSessionId}
                onChange={(e) => setMissedSessionId(e.target.value)}
              >
                <option value="">
                  {data.sessions.length === 0
                    ? 'no sessions attached yet'
                    : 'select session'}
                </option>
                {data.sessions.map((session) => (
                  <option
                    key={session.liveSessionId}
                    value={session.liveSessionId}
                  >
                    {session.liveSessionId} ({session.status})
                  </option>
                ))}
              </select>
              <select
                value={missedAction}
                onChange={(e) =>
                  setMissedAction(e.target.value as PilotExpectedAction)
                }
              >
                <option value="PICKUP">missed PICKUP</option>
                <option value="RETURN">missed RETURN</option>
              </select>
              <input
                placeholder="Expected product id (optional)"
                value={missedProductId}
                onChange={(e) => setMissedProductId(e.target.value)}
              />
              <input
                placeholder="Notes (optional, screened)"
                value={missedNotes}
                onChange={(e) => setMissedNotes(e.target.value)}
              />
              <button
                className="primary"
                disabled={busy || !missedSessionId}
                onClick={() => void submitMissedEvent()}
              >
                Record missed event
              </button>
            </div>
          ) : (
            <p className="muted">Run is closed — no new entries.</p>
          )}
          {observations.data && observations.data.missedEvents.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Expected</th>
                  <th>SKU</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {observations.data.missedEvents.map((row) => (
                  <tr key={row.reviewId}>
                    <td>{row.liveSessionId ?? '—'}</td>
                    <td>{row.expectedAction}</td>
                    <td>{row.expectedSku ?? '—'}</td>
                    <td>{formatDate(row.reviewedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          <p className="muted">
            Shadow mode — reviews are append-only labels; no billing or
            inventory mutation; no stream URLs or credentials anywhere.
          </p>
        </div>
      ) : null}
    </Page>
  );
}
