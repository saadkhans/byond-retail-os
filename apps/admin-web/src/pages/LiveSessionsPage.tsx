import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, LiveSessionDetail, LiveSessionView, api } from '../api';
import { Page, formatDate, useLoad } from '../components';
import {
  SOURCE_TYPE_LABEL,
  formatClipOffset,
  liveSessionIsActionable,
  liveSessionStatusTone,
  liveSessionStopLabel,
  vlmCounterLabel,
} from '../camera-utils';
import { decisionTone } from '../cv-evaluation-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/**
 * Phase 13 live RTSP shadow sessions. Each row is one live camera start:
 * sampled frames → event windows → window-scoped fusion → VLM (through
 * the existing verifier path only) → shadow journey. Stream URLs and
 * credentials never leave the server; errors surface as controlled codes.
 */
export function LiveSessionsPage() {
  const sessions = useLoad<LiveSessionView[]>(() => api('/live-sessions'), []);

  return (
    <Page
      title="Live sessions (shadow)"
      error={sessions.error}
      loading={sessions.loading && !sessions.data}
    >
      <p className="muted">
        Shadow mode — no billing or inventory mutation; stream URLs and
        credentials never leave the server.
      </p>
      <table>
        <thead>
          <tr>
            <th>Camera</th>
            <th>Type</th>
            <th>Status</th>
            <th>Started</th>
            <th>Heartbeat</th>
            <th>Last frame</th>
            <th>Frames</th>
            <th>Windows det / proc</th>
            <th>Fusion</th>
            <th>VLM (inv·skip·fail)</th>
            <th>Journey events</th>
            <th>Review needed</th>
            <th>Decision</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {(sessions.data ?? []).map((session) => (
            <tr key={session.sessionId}>
              <td>
                <Link to={`/live-sessions/${session.sessionId}`}>
                  {session.cameraSourceName}
                </Link>
              </td>
              <td>{SOURCE_TYPE_LABEL[session.sourceType]}</td>
              <td>
                <span
                  className={`badge ${liveSessionStatusTone(session.status)}`}
                >
                  {session.status}
                </span>
              </td>
              <td>{formatDate(session.startedAt)}</td>
              <td>
                {session.heartbeatAt ? formatDate(session.heartbeatAt) : '—'}
              </td>
              <td>
                {session.lastFrameAt ? formatDate(session.lastFrameAt) : '—'}
              </td>
              <td>{session.framesSampled}</td>
              <td>
                {session.eventWindowsDetected} /{' '}
                {session.eventWindowsProcessed}
              </td>
              <td>{session.fusionRunsCompleted}</td>
              <td>{vlmCounterLabel(session)}</td>
              <td>{session.journeyEventsCreated}</td>
              <td>{session.reviewNeeded}</td>
              <td>
                {session.decision ? (
                  <span className={`badge ${decisionTone(session.decision)}`}>
                    {session.decision}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>{session.errorCode ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(sessions.data ?? []).length === 0 ? (
        <p className="muted">
          No live sessions yet — activate an RTSP (shadow) camera with a
          credential slot and start one.
        </p>
      ) : null}
    </Page>
  );
}

export function LiveSessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const session = useLoad<LiveSessionDetail>(
    () => api(`/live-sessions/${id}`),
    [id, tick],
  );
  const data = session.data;
  // STOPPING is a RETRYABLE state (Codex P1): a parked finalization
  // resumes only when another stop() arrives, so the session stays
  // actionable — polling continues and the stop action stays visible
  // (labeled as a retry). Only terminal STOPPED/ERROR go quiet.
  const live = data ? liveSessionIsActionable(data.status) : false;

  // Refresh an actionable session every 5s (PickupDetectionPanel polling
  // idiom); terminal sessions stop polling.
  useEffect(() => {
    if (!live) {
      return;
    }
    const timer = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [live]);

  async function stop() {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/live-sessions/${id}/stop`, { method: 'POST', body: {} });
      setTick((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const tiles: { label: string; value: string }[] = data
    ? [
        { label: 'Frames sampled', value: String(data.framesSampled) },
        {
          label: 'Windows detected / processed',
          value: `${data.eventWindowsDetected} / ${data.eventWindowsProcessed}`,
        },
        { label: 'Fusion runs', value: String(data.fusionRunsCompleted) },
        { label: 'VLM inv·skip·fail', value: vlmCounterLabel(data) },
        {
          label: 'Journey events',
          value: String(data.journeyEventsCreated),
        },
        { label: 'Review needed', value: String(data.reviewNeeded) },
        {
          label: 'Frame interval',
          value: `${data.frameIntervalMs}ms`,
        },
        { label: 'Error code', value: data.errorCode ?? '—' },
      ]
    : [];

  return (
    <Page
      title="Live session (shadow)"
      error={session.error}
      loading={session.loading && !data}
    >
      {actionError ? <div className="error">{actionError}</div> : null}
      {data ? (
        <div className="detail">
          <div>
            <span className={`badge ${liveSessionStatusTone(data.status)}`}>
              {data.status}
            </span>{' '}
            {data.decision ? (
              <span className={`badge ${decisionTone(data.decision)}`}>
                {data.decision}
              </span>
            ) : null}{' '}
            <span className="muted">
              {data.cameraSourceName} · {SOURCE_TYPE_LABEL[data.sourceType]} ·
              started {formatDate(data.startedAt)}
              {data.stoppedAt ? ` · stopped ${formatDate(data.stoppedAt)}` : ''}
              {data.heartbeatAt
                ? ` · heartbeat ${formatDate(data.heartbeatAt)}`
                : ''}
              {data.lastFrameAt
                ? ` · last frame ${formatDate(data.lastFrameAt)}`
                : ''}
            </span>{' '}
            {live ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void stop()}
              >
                {liveSessionStopLabel(data.status)}
              </button>
            ) : null}
          </div>
          <p>
            {data.journeyId ? (
              <Link to={`/journeys/${data.journeyId}`}>Journey →</Link>
            ) : (
              <span className="muted">no journey</span>
            )}{' '}
            <Link to="/review-queue">Review queue →</Link>{' '}
            <Link to="/cameras">Camera sources →</Link>
          </p>

          <div className="cards">
            {tiles.map((tile) => (
              <div key={tile.label} className="card">
                <div className="value">{tile.value}</div>
                <div className="label">{tile.label}</div>
              </div>
            ))}
          </div>

          <h2>Candidate event windows ({data.eventWindows.length})</h2>
          {data.eventWindows.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Start</th>
                  <th>Peak</th>
                  <th>End</th>
                  <th>Confidence (uncalibrated)</th>
                </tr>
              </thead>
              <tbody>
                {data.eventWindows.map((window) => (
                  <tr key={`${window.startMs}-${window.endMs}`}>
                    <td>{formatClipOffset(window.startMs)}</td>
                    <td>{formatClipOffset(window.peakMs)}</td>
                    <td>{formatClipOffset(window.endMs)}</td>
                    <td>{window.confidence.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No candidate windows detected yet.</p>
          )}

          <p className="muted">
            Shadow mode — no billing or inventory mutation; stream URLs and
            credentials never leave the server.
          </p>
        </div>
      ) : null}
    </Page>
  );
}
