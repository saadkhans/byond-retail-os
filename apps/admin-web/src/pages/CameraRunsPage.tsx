import { Link, useSearchParams } from 'react-router-dom';
import { LiveSessionView, PilotRunView, api } from '../api';
import { Badge, DataColumn, DataTable, Page, Tabs, formatDate, useLoad } from '../components';
import {
  SOURCE_TYPE_LABEL,
  liveSessionStatusTone,
  runStatusTone,
  vlmCounterLabel,
} from '../camera-utils';
import { decisionTone } from '../cv-evaluation-utils';

type RunType = 'all' | 'replay' | 'live';

/** One row for either lifecycle: a finite FILE_REPLAY run or an RTSP shadow session. */
export interface CameraRunRow {
  key: string;
  type: 'replay' | 'live';
  to: string;
  camera: string;
  sourceType: string;
  status: string;
  statusTone: string;
  startedAt: string | null;
  frames: number;
  windows: string;
  fusion: number;
  vlm: string;
  journeyEvents: number;
  reviewNeeded: number;
  decision: string | null;
  errors: string;
}

export function replayRow(run: PilotRunView): CameraRunRow {
  return {
    key: `replay:${run.runId}`,
    type: 'replay',
    to: `/pilot-runs/${run.runId}`,
    camera: run.cameraSourceName,
    sourceType: 'File replay',
    status: run.status,
    statusTone: runStatusTone(run.status),
    startedAt: run.startedAt,
    frames: run.framesProcessed,
    windows: `${run.eventWindowsDetected} / ${run.eventWindowsProcessed}`,
    fusion: run.fusionRunsCompleted,
    vlm: vlmCounterLabel(run),
    journeyEvents: run.journeyEventsCreated,
    reviewNeeded: run.reviewNeeded,
    decision: run.decision ?? null,
    errors: String(run.errorCount),
  };
}

export function liveRow(session: LiveSessionView): CameraRunRow {
  return {
    key: `live:${session.sessionId}`,
    type: 'live',
    to: `/live-sessions/${session.sessionId}`,
    camera: session.cameraSourceName,
    sourceType: SOURCE_TYPE_LABEL[session.sourceType] ?? session.sourceType,
    status: session.status,
    statusTone: liveSessionStatusTone(session.status),
    startedAt: session.startedAt,
    frames: session.framesSampled,
    windows: `${session.eventWindowsDetected} / ${session.eventWindowsProcessed}`,
    fusion: session.fusionRunsCompleted,
    vlm: vlmCounterLabel(session),
    journeyEvents: session.journeyEventsCreated,
    reviewNeeded: session.reviewNeeded,
    decision: session.decision ?? null,
    errors: session.errorCode ?? '—',
  };
}

function parseType(value: string | null): RunType {
  return value === 'replay' || value === 'live' ? value : 'all';
}

const COLUMNS: DataColumn<CameraRunRow>[] = [
  {
    key: 'camera',
    header: 'Camera',
    render: (row) => <Link to={row.to}>{row.camera}</Link>,
  },
  {
    key: 'type',
    header: 'Type',
    render: (row) => (
      <Badge tone={row.type === 'live' ? 'accent' : 'neutral'}>
        {row.type === 'live' ? 'Live' : 'Replay'}
      </Badge>
    ),
  },
  { key: 'source', header: 'Source', render: (row) => row.sourceType },
  {
    key: 'status',
    header: 'Status',
    render: (row) => <Badge tone={row.statusTone}>{row.status}</Badge>,
  },
  { key: 'frames', header: 'Frames', numeric: true, render: (row) => row.frames },
  { key: 'windows', header: 'Windows det / proc', numeric: true, render: (row) => row.windows },
  { key: 'fusion', header: 'Fusion', numeric: true, render: (row) => row.fusion },
  { key: 'vlm', header: 'VLM (inv·skip·fail)', numeric: true, render: (row) => row.vlm },
  { key: 'journey', header: 'Journey events', numeric: true, render: (row) => row.journeyEvents },
  { key: 'review', header: 'Review needed', numeric: true, render: (row) => row.reviewNeeded },
  {
    key: 'decision',
    header: 'Decision',
    render: (row) =>
      row.decision ? <Badge tone={decisionTone(row.decision)}>{row.decision}</Badge> : '—',
  },
  { key: 'errors', header: 'Errors', render: (row) => row.errors },
  { key: 'started', header: 'Started', render: (row) => formatDate(row.startedAt) },
];

/**
 * Camera runs (shadow): file replays (Phase 12) and live RTSP shadow
 * sessions (Phase 13) in one list. Both are the same pipeline with a
 * different lifecycle; their detail pages keep the type-specific controls
 * (stop / polling / performance for live, stage timings for replay).
 */
export function CameraRunsPage() {
  const [params, setParams] = useSearchParams();
  const type = parseType(params.get('type'));

  const replays = useLoad<PilotRunView[]>(() => api('/pilot-runs'), []);
  const sessions = useLoad<LiveSessionView[]>(() => api('/live-sessions'), []);

  const rows: CameraRunRow[] = [
    ...(type === 'live' ? [] : (replays.data ?? []).map(replayRow)),
    ...(type === 'replay' ? [] : (sessions.data ?? []).map(liveRow)),
  ].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  return (
    <Page
      title="Camera runs (shadow)"
      description="File replays and live RTSP shadow sessions. Nothing here touches billing or inventory; stream URLs and credentials never leave the server."
      error={replays.error ?? sessions.error}
      loading={(replays.loading && !replays.data) || (sessions.loading && !sessions.data)}
    >
      <Tabs
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'replay', label: 'Replay' },
          { id: 'live', label: 'Live' },
        ]}
        value={type}
        onChange={(id) => setParams(id === 'all' ? {} : { type: id })}
      />
      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.key}
        empty={
          type === 'live'
            ? 'No live sessions yet — activate an RTSP (shadow) camera with a credential slot and start one.'
            : type === 'replay'
              ? 'No replay runs yet — register a FILE_REPLAY camera and run a replay.'
              : 'No camera runs yet — start a replay or a live session from Cameras.'
        }
      />
    </Page>
  );
}
