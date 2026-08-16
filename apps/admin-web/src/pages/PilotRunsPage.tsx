import { Link, useParams } from 'react-router-dom';
import { PilotRunDetail, PilotRunView, api } from '../api';
import { Page, formatDate, useLoad } from '../components';
import {
  SOURCE_TYPE_LABEL,
  formatClipOffset,
  runStatusTone,
  vlmCounterLabel,
} from '../camera-utils';
import { decisionTone } from '../cv-evaluation-utils';

/**
 * Phase 12 pilot-run dashboard (SHADOW): each row is one auditable replay
 * of a video asset through event-window detection → pickup detection →
 * fusion → VLM → journey import → reconciliation. Nothing here touches
 * billing or inventory.
 */
export function PilotRunsPage() {
  const runs = useLoad<PilotRunView[]>(() => api('/pilot-runs'), []);

  return (
    <Page
      title="Pilot runs (shadow)"
      error={runs.error}
      loading={runs.loading && !runs.data}
    >
      <p className="muted">
        Replay runs are repeatable and auditable — same idempotency key,
        same run. Shadow mode: no billing or inventory mutation.
      </p>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Frames</th>
            <th>Windows det / proc</th>
            <th>Crop frames</th>
            <th>Clip artifacts</th>
            <th>Fusion</th>
            <th>VLM (inv·skip·fail)</th>
            <th>Journey events</th>
            <th>Review needed</th>
            <th>Decision</th>
            <th>Errors</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {(runs.data ?? []).map((run) => (
            <tr key={run.runId}>
              <td>
                <Link to={`/pilot-runs/${run.runId}`}>
                  {run.cameraSourceName}
                </Link>
              </td>
              <td>
                <span className={`badge ${runStatusTone(run.status)}`}>
                  {run.status}
                </span>
              </td>
              <td>{run.framesProcessed}</td>
              <td>
                {run.eventWindowsDetected} / {run.eventWindowsProcessed}
              </td>
              <td>{run.cropFramesGenerated}</td>
              <td>{run.clipArtifactsGenerated}</td>
              <td>{run.fusionRunsCompleted}</td>
              <td>{vlmCounterLabel(run)}</td>
              <td>{run.journeyEventsCreated}</td>
              <td>{run.reviewNeeded}</td>
              <td>
                {run.decision ? (
                  <span className={`badge ${decisionTone(run.decision)}`}>
                    {run.decision}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>{run.errorCount}</td>
              <td>{formatDate(run.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(runs.data ?? []).length === 0 ? (
        <p className="muted">
          No pilot runs yet — register a FILE_REPLAY camera and run a
          replay.
        </p>
      ) : null}
    </Page>
  );
}

export function PilotRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const run = useLoad<PilotRunDetail>(() => api(`/pilot-runs/${id}`), [id]);
  const data = run.data;

  const tiles: { label: string; value: string }[] = data
    ? [
        { label: 'Frames processed', value: String(data.framesProcessed) },
        {
          label: 'Windows detected / processed',
          value: `${data.eventWindowsDetected} / ${data.eventWindowsProcessed}`,
        },
        {
          label: 'Crop frames (evidence)',
          value: String(data.cropFramesGenerated),
        },
        {
          label: 'Clip artifacts',
          value: String(data.clipArtifactsGenerated),
        },
        { label: 'Fusion runs', value: String(data.fusionRunsCompleted) },
        { label: 'VLM inv·skip·fail', value: vlmCounterLabel(data) },
        {
          label: 'Journey events',
          value: String(data.journeyEventsCreated),
        },
        { label: 'Review needed', value: String(data.reviewNeeded) },
        { label: 'Errors', value: String(data.errorCount) },
      ]
    : [];

  return (
    <Page
      title="Pilot run (shadow)"
      error={run.error}
      loading={run.loading && !data}
    >
      {data ? (
        <div className="detail">
          <div>
            <span className={`badge ${runStatusTone(data.status)}`}>
              {data.status}
            </span>{' '}
            {data.decision ? (
              <span className={`badge ${decisionTone(data.decision)}`}>
                {data.decision}
              </span>
            ) : null}{' '}
            <span className="muted">
              {data.cameraSourceName} · {SOURCE_TYPE_LABEL[data.sourceType]} ·
              frame interval {data.frameIntervalMs}ms · started{' '}
              {formatDate(data.startedAt)}
              {data.finishedAt
                ? ` · finished ${formatDate(data.finishedAt)}`
                : ''}
            </span>
          </div>
          <p>
            <Link to={`/video-assets/${data.videoAssetId}`}>
              Replayed video →
            </Link>{' '}
            {data.journeyId ? (
              <Link to={`/journeys/${data.journeyId}`}>Journey →</Link>
            ) : (
              <span className="muted">no journey created</span>
            )}
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
            <p className="muted">No candidate windows detected.</p>
          )}

          <h2>Latency per stage</h2>
          {data.stageTimings.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {data.stageTimings.map((timing) => (
                  <tr key={timing.stage}>
                    <td>{timing.stage}</td>
                    <td>{Math.round(timing.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No stage timings recorded.</p>
          )}

          <h2>Errors ({data.errors.length})</h2>
          {data.errors.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Code</th>
                </tr>
              </thead>
              <tbody>
                {data.errors.map((error, index) => (
                  <tr key={`${error.stage}-${index}`}>
                    <td>{error.stage}</td>
                    <td>{error.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No errors.</p>
          )}

          <p className="muted">
            Shadow mode: no billing or inventory mutation.
          </p>
        </div>
      ) : null}
    </Page>
  );
}
