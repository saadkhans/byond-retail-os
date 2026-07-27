import { FormEvent, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  apiUpload,
  InferenceJob,
  Paginated,
  VideoArtifact,
  VideoAsset,
} from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const ASSET_STATUSES = [
  '',
  'UPLOADED',
  'VALIDATED',
  'REJECTED',
  'PROCESSING',
  'READY',
  'FAILED',
];

const CROP_REASONS = [
  '',
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'SHELF_AUDIT',
  'CART_INSERTION',
  'OCR_REVIEW',
  'VLM_REVIEW',
];

const ACCEPTED_EXTENSIONS = '.mp4,.m4v,.mov,.webm,.mkv,.avi,.mpg,.mpeg';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

function formatBytes(size: number): string {
  if (size >= 1_048_576) {
    return `${(size / 1_048_576).toFixed(1)} MiB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  return `${size} B`;
}

function formatDurationMs(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`;
}

function shortChecksum(checksum: string): string {
  return checksum.length > 12 ? `${checksum.slice(0, 12)}…` : checksum;
}

export function VideoAssetsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const fileInput = useRef<HTMLInputElement>(null);
  const [locationId, setLocationId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [attested, setAttested] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { data, error, loading } = useLoad<Paginated<VideoAsset>>(
    () =>
      api(
        `/video-assets?skip=${skip}&take=${take}` +
          (status ? `&status=${status}` : ''),
      ),
    [status, skip],
  );

  async function upload(event: FormEvent) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setUploadError('Choose a test video file first.');
      return;
    }
    if (!attested) {
      setUploadError(
        'Confirm the attestation: the staged test clip must contain no ' +
          'payment-card or credential content in its frames.',
      );
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // Required, audited operator attestation — the API refuses to store
      // without it (text screening cannot inspect pixels).
      formData.append('attestNoSensitiveContent', 'true');
      if (locationId.trim()) {
        formData.append('locationId', locationId.trim());
      }
      if (unitId.trim()) {
        formData.append('unitId', unitId.trim());
      }
      if (deviceId.trim()) {
        formData.append('deviceId', deviceId.trim());
      }
      if (sessionId.trim()) {
        formData.append('sessionId', sessionId.trim());
      }
      const asset = await apiUpload<VideoAsset>('/video-assets', formData);
      navigate(`/video-assets/${asset.id}`);
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Page title="Test videos" error={error} loading={loading}>
      <form className="toolbar" onSubmit={(e) => void upload(e)}>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          title="Controlled test clip (10–30 s recommended)"
        />
        <input
          type="text"
          placeholder="Store id (optional)"
          style={{ minWidth: '10rem' }}
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        />
        <input
          type="text"
          placeholder="Unit id (optional)"
          style={{ minWidth: '10rem' }}
          value={unitId}
          onChange={(e) => setUnitId(e.target.value)}
        />
        <input
          type="text"
          placeholder="Device id (optional)"
          style={{ minWidth: '10rem' }}
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
        />
        <input
          type="text"
          placeholder="Session id (optional)"
          style={{ minWidth: '10rem' }}
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        />
        <label
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          title={
            'Required attestation: the API refuses to store a clip without ' +
            'it. Text screening cannot inspect pixels.'
          }
        >
          <input
            type="checkbox"
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
          />
          Staged test clip — no card/credential content in frames
        </label>
        <button
          className="primary"
          type="submit"
          disabled={uploading || !attested}
        >
          {uploading ? 'Uploading…' : 'Upload test video'}
        </button>
      </form>
      {uploadError ? <div className="error">{uploadError}</div> : null}
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setSkip(0);
            setStatus(e.target.value);
          }}
        >
          {ASSET_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value || 'Any status'}
            </option>
          ))}
        </select>
        <span className="muted">{data?.total ?? 0} total</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th>Size</th>
            <th>Duration</th>
            <th>Dimensions</th>
            <th>Session</th>
            <th>Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((asset) => (
            <tr key={asset.id}>
              <td>
                <Link to={`/video-assets/${asset.id}`}>
                  {asset.originalFilename}
                </Link>
              </td>
              <td>
                <StatusBadge status={asset.status} />
              </td>
              <td>{formatBytes(asset.sizeBytes)}</td>
              <td>{formatDurationMs(asset.durationMs)}</td>
              <td>
                {asset.width && asset.height
                  ? `${asset.width}×${asset.height}`
                  : '—'}
              </td>
              <td>
                {asset.sessionId ? (
                  <Link to={`/checkout-sessions/${asset.sessionId}`}>
                    {asset.sessionId}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{formatDate(asset.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button
          disabled={skip === 0}
          onClick={() => setSkip(Math.max(0, skip - take))}
        >
          Previous
        </button>
        <button
          disabled={!data || skip + take >= data.total}
          onClick={() => setSkip(skip + take)}
        >
          Next
        </button>
      </div>
    </Page>
  );
}

export function VideoAssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Extract-frames form. The idempotency key is generated once per logical
  // submission and rotated only after confirmed success (same pattern as
  // InferenceJobsPage): a retried/failed submit REPLAYS the committed batch
  // instead of appending duplicate append-only artifacts.
  const [intervalMs, setIntervalMs] = useState('1000');
  const [maxFrames, setMaxFrames] = useState('5');
  const [frameTimestampMs, setFrameTimestampMs] = useState('');
  const [frameIdempotencyKey, setFrameIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );

  // Crop form (same idempotency-key rotation).
  const [cropTimestampMs, setCropTimestampMs] = useState('0');
  const [cropX, setCropX] = useState('0');
  const [cropY, setCropY] = useState('0');
  const [cropWidth, setCropWidth] = useState('');
  const [cropHeight, setCropHeight] = useState('');
  const [cropReason, setCropReason] = useState('');
  const [cropIdempotencyKey, setCropIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );

  const asset = useLoad<VideoAsset>(() => api(`/video-assets/${id}`), [
    id,
    reload,
  ]);
  const artifacts = useLoad<VideoArtifact[]>(
    () => api(`/video-assets/${id}/artifacts`),
    [id, reload],
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    await run(async () => {
      await api(`/video-assets/${id}/validate`, { method: 'POST', body: {} });
    });
  }

  async function extractFrames(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const single = frameTimestampMs.trim();
      const body = single
        ? { timestampMs: Number(single), idempotencyKey: frameIdempotencyKey }
        : {
            ...(intervalMs.trim() ? { intervalMs: Number(intervalMs) } : {}),
            ...(maxFrames.trim() ? { maxFrames: Number(maxFrames) } : {}),
            idempotencyKey: frameIdempotencyKey,
          };
      await api(`/video-assets/${id}/extract-frames`, {
        method: 'POST',
        body,
      });
      setFrameIdempotencyKey(crypto.randomUUID());
    });
  }

  async function createCrop(event: FormEvent) {
    event.preventDefault();
    if (!cropWidth.trim() || !cropHeight.trim()) {
      setActionError('Crop width and height are required.');
      return;
    }
    await run(async () => {
      await api(`/video-assets/${id}/crops`, {
        method: 'POST',
        body: {
          timestampMs: Number(cropTimestampMs),
          x: Number(cropX),
          y: Number(cropY),
          width: Number(cropWidth),
          height: Number(cropHeight),
          ...(cropReason ? { reason: cropReason } : {}),
          idempotencyKey: cropIdempotencyKey,
        },
      });
      setCropIdempotencyKey(crypto.randomUUID());
    });
  }

  async function deleteAsset() {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/video-assets/${id}`, { method: 'DELETE' });
      navigate('/video-assets');
    } catch (err) {
      setActionError(errorMessage(err));
      setBusy(false);
    }
  }

  async function createInferenceJob(artifactId: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api<{
        artifact: VideoArtifact;
        job: InferenceJob;
        replayed: boolean;
      }>(`/video-crops/${artifactId}/inference-job`, {
        method: 'POST',
        body: {},
      });
      setNotice(
        result.replayed
          ? `Replayed existing inference job ${result.job.id}.`
          : `Created inference job ${result.job.id}.`,
      );
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const data = asset.data;
  const canProcess =
    data?.status === 'VALIDATED' ||
    data?.status === 'READY' ||
    data?.status === 'FAILED';

  return (
    <Page title="Test video" error={asset.error} loading={asset.loading}>
      {data ? (
        <div className="detail">
          {actionError ? <div className="error">{actionError}</div> : null}
          {notice ? <p className="muted">{notice}</p> : null}
          <div className="toolbar">
            {data.status === 'UPLOADED' ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void validate()}
              >
                Validate (probe metadata)
              </button>
            ) : null}
            <button disabled={busy} onClick={() => void deleteAsset()}>
              Delete asset
            </button>
          </div>
          {canProcess ? (
            <form className="toolbar" onSubmit={(e) => void extractFrames(e)}>
              <input
                type="number"
                min={100}
                step={100}
                style={{ width: '8rem' }}
                title="Sampling interval in ms (ignored when a single timestamp is set)"
                placeholder="Interval ms"
                value={intervalMs}
                onChange={(e) => setIntervalMs(e.target.value)}
              />
              <input
                type="number"
                min={1}
                max={30}
                step={1}
                style={{ width: '7rem' }}
                title="Maximum frames per request (cap 30)"
                placeholder="Max frames"
                value={maxFrames}
                onChange={(e) => setMaxFrames(e.target.value)}
              />
              <input
                type="number"
                min={0}
                step={1}
                style={{ width: '10rem' }}
                title="Extract exactly one frame at this position instead of sampling"
                placeholder="Single frame at ms"
                value={frameTimestampMs}
                onChange={(e) => setFrameTimestampMs(e.target.value)}
              />
              <button className="primary" type="submit" disabled={busy}>
                Extract frames
              </button>
            </form>
          ) : null}
          {canProcess ? (
            <form className="toolbar" onSubmit={(e) => void createCrop(e)}>
              <input
                type="number"
                min={0}
                step={1}
                style={{ width: '9rem' }}
                placeholder="Timestamp ms"
                value={cropTimestampMs}
                onChange={(e) => setCropTimestampMs(e.target.value)}
              />
              <input
                type="number"
                min={0}
                step={1}
                style={{ width: '5.5rem' }}
                placeholder="x"
                value={cropX}
                onChange={(e) => setCropX(e.target.value)}
              />
              <input
                type="number"
                min={0}
                step={1}
                style={{ width: '5.5rem' }}
                placeholder="y"
                value={cropY}
                onChange={(e) => setCropY(e.target.value)}
              />
              <input
                type="number"
                min={1}
                step={1}
                style={{ width: '6.5rem' }}
                placeholder="Width"
                value={cropWidth}
                onChange={(e) => setCropWidth(e.target.value)}
              />
              <input
                type="number"
                min={1}
                step={1}
                style={{ width: '6.5rem' }}
                placeholder="Height"
                value={cropHeight}
                onChange={(e) => setCropHeight(e.target.value)}
              />
              <select
                value={cropReason}
                onChange={(e) => setCropReason(e.target.value)}
              >
                {CROP_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {value || 'Reason…'}
                  </option>
                ))}
              </select>
              <button className="primary" type="submit" disabled={busy}>
                Create crop
              </button>
            </form>
          ) : null}
          <dl>
            <dt>Asset ID</dt>
            <dd>{data.id}</dd>
            <dt>Original filename</dt>
            <dd>{data.originalFilename}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>MIME type</dt>
            <dd>{data.mimeType}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(data.sizeBytes)}</dd>
            <dt>Duration</dt>
            <dd>{formatDurationMs(data.durationMs)}</dd>
            <dt>Dimensions</dt>
            <dd>
              {data.width && data.height
                ? `${data.width}×${data.height}`
                : '—'}
            </dd>
            <dt>FPS</dt>
            <dd>{data.fps ?? '—'}</dd>
            <dt>SHA-256</dt>
            <dd title={data.checksumSha256}>
              {shortChecksum(data.checksumSha256)}
            </dd>
            <dt>Store</dt>
            <dd>
              {data.locationId ? (
                <Link to={`/stores/${data.locationId}`}>{data.locationId}</Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Unit</dt>
            <dd>
              {data.unitId ? (
                <Link to={`/units/${data.unitId}`}>{data.unitId}</Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Device</dt>
            <dd>
              {data.deviceId ? (
                <Link to={`/devices/${data.deviceId}`}>{data.deviceId}</Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Checkout session</dt>
            <dd>
              {data.sessionId ? (
                <Link to={`/checkout-sessions/${data.sessionId}`}>
                  {data.sessionId}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Error</dt>
            <dd>
              {data.errorCode
                ? `${data.errorCode}${data.errorMessage ? ` — ${data.errorMessage}` : ''}`
                : '—'}
            </dd>
            <dt>Uploaded</dt>
            <dd>{formatDate(data.createdAt)}</dd>
          </dl>

          <h2 style={{ marginTop: '1.5rem' }}>
            Artifacts ({artifacts.data?.length ?? 0})
          </h2>
          {artifacts.error ? (
            <div className="error">{artifacts.error}</div>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Reason</th>
                <th>Timestamp</th>
                <th>Crop box</th>
                <th>Dimensions</th>
                <th>Size</th>
                <th>SHA-256</th>
                <th>Created</th>
                <th>Inference job</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.data?.map((artifact) => (
                <tr key={artifact.id}>
                  <td>{artifact.artifactType}</td>
                  <td>{artifact.reason ?? '—'}</td>
                  <td>{formatDurationMs(artifact.timestampMs)}</td>
                  <td>
                    {artifact.artifactType === 'CROP'
                      ? `${artifact.cropWidth}×${artifact.cropHeight} @ (${artifact.cropX}, ${artifact.cropY})`
                      : '—'}
                  </td>
                  <td>
                    {artifact.width}×{artifact.height}
                  </td>
                  <td>{formatBytes(artifact.sizeBytes)}</td>
                  <td title={artifact.checksumSha256}>
                    {shortChecksum(artifact.checksumSha256)}
                  </td>
                  <td>{formatDate(artifact.createdAt)}</td>
                  <td>
                    {artifact.inferenceJobId ? (
                      <Link to={`/inference/${artifact.inferenceJobId}`}>
                        {artifact.inferenceJobId}
                      </Link>
                    ) : artifact.artifactType === 'CROP' ? (
                      <button
                        disabled={busy}
                        onClick={() => void createInferenceJob(artifact.id)}
                      >
                        Create inference job
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
