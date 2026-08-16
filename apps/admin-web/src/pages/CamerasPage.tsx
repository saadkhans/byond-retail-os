import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  CameraSourceView,
  Paginated,
  PilotRunDetail,
  Store,
  api,
} from '../api';
import { Page, formatDate, useLoad } from '../components';
import {
  SOURCE_TYPE_LABEL,
  isPlaceholderType,
  sourceStatusTone,
} from '../camera-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/**
 * Phase 12 camera source registry (SHADOW pilot). Only FILE_REPLAY
 * sources are functional; RTSP/webcam register as disabled placeholders.
 * No URL or credential is ever shown — the API never returns one.
 */
export function CamerasPage() {
  const navigate = useNavigate();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create-form state.
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [shelfZone, setShelfZone] = useState('');
  const [sourceType, setSourceType] = useState('FILE_REPLAY');
  const [connectionNote, setConnectionNote] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [replayVideoAssetId, setReplayVideoAssetId] = useState('');

  const sources = useLoad<CameraSourceView[]>(
    () => api('/camera-sources'),
    [reload],
  );
  const stores = useLoad<Paginated<Store>>(
    () => api<Paginated<Store>>('/stores?take=100'),
    [],
  );

  // One replay idempotency key per source, created on the first attempt
  // and dropped only after a CONFIRMED success — a retry after a lost
  // response resends the same key and the server returns the SAME run
  // instead of replaying the footage twice (JourneysPage review idiom).
  const replayKeys = useRef(new Map<string, string>());

  async function createSource() {
    if (!locationId || !name.trim()) {
      setActionError('A camera needs a store and a name.');
      return;
    }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api('/camera-sources', {
        method: 'POST',
        body: {
          locationId,
          name: name.trim(),
          sourceType,
          ...(shelfZone.trim() ? { shelfZone: shelfZone.trim() } : {}),
          ...(connectionNote.trim()
            ? { connectionNote: connectionNote.trim() }
            : {}),
          ...(credentialRef.trim()
            ? { credentialRef: credentialRef.trim() }
            : {}),
          ...(replayVideoAssetId.trim()
            ? { replayVideoAssetId: replayVideoAssetId.trim() }
            : {}),
        },
      });
      setName('');
      setShelfZone('');
      setConnectionNote('');
      setCredentialRef('');
      setReplayVideoAssetId('');
      setNotice('Camera source registered.');
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(source: CameraSourceView, status: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api(`/camera-sources/${source.id}`, {
        method: 'PATCH',
        body: { status },
      });
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runReplay(source: CameraSourceView) {
    const existing = replayKeys.current.get(source.id);
    const idempotencyKey = existing ?? crypto.randomUUID();
    replayKeys.current.set(source.id, idempotencyKey);
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const run = await api<PilotRunDetail>(
        `/camera-sources/${source.id}/replay-run`,
        { method: 'POST', body: { idempotencyKey } },
      );
      replayKeys.current.delete(source.id);
      navigate(`/pilot-runs/${run.runId}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const storeName = (id: string) =>
    stores.data?.items.find((store) => store.id === id)?.name ?? id;

  return (
    <Page
      title="Cameras (shadow pilot)"
      error={sources.error}
      loading={sources.loading && !sources.data}
    >
      <p className="muted">
        Camera source registry for the replay pilot. Only file replay is
        enabled — RTSP and local webcam are registered placeholders. No
        source URL or credential is ever stored in plaintext or shown here.
      </p>
      {actionError ? <div className="error">{actionError}</div> : null}
      {notice ? <p className="muted">✓ {notice}</p> : null}

      <div className="toolbar">
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">Store…</option>
          {(stores.data?.items ?? []).map((store) => (
            <option key={store.id} value={store.id}>
              {store.name} ({store.code})
            </option>
          ))}
        </select>
        <input
          placeholder="Camera name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="Shelf zone (zone-r1c1 … zone-r3c3)"
          value={shelfZone}
          onChange={(e) => setShelfZone(e.target.value)}
        />
        <select
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value)}
        >
          <option value="FILE_REPLAY">{SOURCE_TYPE_LABEL.FILE_REPLAY}</option>
          <option value="RTSP_PLACEHOLDER">
            {SOURCE_TYPE_LABEL.RTSP_PLACEHOLDER}
          </option>
          <option value="LOCAL_WEBCAM_PLACEHOLDER">
            {SOURCE_TYPE_LABEL.LOCAL_WEBCAM_PLACEHOLDER}
          </option>
        </select>
      </div>
      <div className="toolbar">
        <input
          placeholder="Connection note (no URLs with credentials)"
          value={connectionNote}
          onChange={(e) => setConnectionNote(e.target.value)}
          style={{ minWidth: '16rem' }}
        />
        <input
          placeholder="Credential ref (secret slot NAME — never the secret)"
          value={credentialRef}
          onChange={(e) => setCredentialRef(e.target.value)}
          style={{ minWidth: '16rem' }}
        />
        <input
          placeholder="Replay video asset id"
          value={replayVideoAssetId}
          onChange={(e) => setReplayVideoAssetId(e.target.value)}
          style={{ minWidth: '14rem' }}
        />
        <button
          className="primary"
          disabled={busy}
          onClick={() => void createSource()}
        >
          Register camera
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Store</th>
            <th>Zone</th>
            <th>Type</th>
            <th>Status</th>
            <th>Credential</th>
            <th>Replay asset</th>
            <th>Last error</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(sources.data ?? []).map((source) => (
            <tr key={source.id}>
              <td>{source.name}</td>
              <td>{storeName(source.locationId)}</td>
              <td>{source.shelfZone ?? '—'}</td>
              <td>{SOURCE_TYPE_LABEL[source.sourceType]}</td>
              <td>
                <span className={`badge ${sourceStatusTone(source.status)}`}>
                  {source.status}
                </span>
              </td>
              <td>{source.hasCredentialRef ? 'configured' : '—'}</td>
              <td>
                {source.replayVideoAssetId ? (
                  <Link to={`/video-assets/${source.replayVideoAssetId}`}>
                    video
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{source.lastError ?? '—'}</td>
              <td>{formatDate(source.createdAt)}</td>
              <td>
                <span style={{ whiteSpace: 'nowrap' }}>
                  {isPlaceholderType(source.sourceType) ? (
                    <span className="muted">not enabled in shadow pilot</span>
                  ) : (
                    <>
                      {source.status !== 'ACTIVE' ? (
                        <button
                          disabled={busy}
                          onClick={() => void setStatus(source, 'ACTIVE')}
                        >
                          Enable
                        </button>
                      ) : null}{' '}
                      {source.status !== 'DISABLED' ? (
                        <button
                          disabled={busy}
                          onClick={() => void setStatus(source, 'DISABLED')}
                        >
                          Disable
                        </button>
                      ) : null}{' '}
                      {source.status === 'ACTIVE' ? (
                        <button
                          className="primary"
                          disabled={busy || !source.replayVideoAssetId}
                          title={
                            source.replayVideoAssetId
                              ? undefined
                              : 'set a replay video asset first'
                          }
                          onClick={() => void runReplay(source)}
                        >
                          Run replay
                        </button>
                      ) : null}
                    </>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(sources.data ?? []).length === 0 ? (
        <p className="muted">No camera sources registered yet.</p>
      ) : null}
    </Page>
  );
}
