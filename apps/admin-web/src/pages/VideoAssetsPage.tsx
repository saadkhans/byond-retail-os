import { FormEvent, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  apiUpload,
  InferenceJob,
  Paginated,
  ScreeningPreview,
  VideoArtifact,
  VideoAsset,
} from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';
import { FusionEvidencePanel } from './FusionEvidencePanel';
import { PickupDetectionPanel } from './PickupDetectionPanel';

const ASSET_STATUSES = [
  '',
  'PENDING_MEDIA',
  'QUARANTINED',
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

export const ACCEPTED_EXTENSIONS = '.mp4,.m4v,.mov,.webm,.mkv,.avi,.mpg,.mpeg';

/**
 * The FOUR attestations the upload API requires. They are the operator's
 * DECLARATIONS about controlled internal test media, recorded in the audit
 * trail as the policy the clip was accepted under — NOT a safety
 * guarantee: nothing inspects the footage to confirm them, and the API's
 * text/OCR screen can only REJECT a clip when it DETECTS card or
 * credential text. Detecting nothing proves nothing (rotated, blurred,
 * stylized or low-quality digits defeat recognition), so the honest
 * control is that these clips are ones YOU staged and control.
 */
export const UPLOAD_ATTESTATIONS = [
  {
    field: 'controlledTestMedia',
    header: 'x-controlled-test-media',
    label: 'Controlled internal test media I staged and own',
    title:
      'Phase 10 ingests controlled internal test clips only — footage you ' +
      'staged and can account for. Never real customer footage, never ' +
      'third-party material.',
  },
  {
    field: 'noPaymentCardsVisible',
    header: 'x-no-payment-cards-visible',
    label: 'No payment card is visible anywhere in this clip',
    title:
      'Your declaration as the operator. The API does not verify it: its ' +
      'text/OCR screen can only reject a clip when it DETECTS card text, ' +
      'and detecting nothing is not evidence that nothing is there.',
  },
  {
    field: 'noCustomerPII',
    header: 'x-no-customer-pii',
    label: 'No customer personal data in this clip',
    title:
      'No identifiable customers, documents, or screens showing personal ' +
      'records. Your declaration — nothing checks it for you.',
  },
  {
    field: 'attestNoSensitiveContent',
    header: 'x-attest-no-sensitive-content',
    label: 'No payment-card or credential content in the frames',
    title:
      'Your declaration, recorded in the audit trail. Not a safety ' +
      'guarantee — the upload still lands QUARANTINED until an audited ' +
      'screening decision releases it.',
  },
] as const;

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/**
 * Strict timestamp parse for the extraction and crop forms. Returns either
 * the parsed integer or an error string — NEVER a fallback value: an
 * empty, NaN, negative, or out-of-range entry must surface an error
 * instead of silently becoming 0 (`Number('')` is 0, which is exactly the
 * bug this guards against).
 */
function parseTimestampMs(
  raw: string,
  durationMs: number | null,
): { value: number; error: null } | { value: null; error: string } {
  const error =
    durationMs !== null
      ? `Timestamp must be between 0 and ${durationMs - 1} ms for this video.`
      : 'Timestamp must be a non-negative integer number of milliseconds.';
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { value: null, error };
  }
  const value = Number(trimmed);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (durationMs !== null && value >= durationMs)
  ) {
    return { value: null, error };
  }
  return { value, error: null };
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
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const allAttested = UPLOAD_ATTESTATIONS.every(({ field }) => attested[field]);

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
    if (!allAttested) {
      setUploadError(
        'Confirm all four operator attestations: this must be controlled ' +
          'internal test media you staged, with no payment card visible, ' +
          'no customer personal data, and no payment-card or credential ' +
          'content in its frames. They are declarations you make — the API ' +
          'records them, it does not verify them.',
      );
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // Required, audited operator DECLARATIONS — the API refuses to store
      // without all four. They record the policy the clip was accepted
      // under; the authorization itself is the server's controlled
      // test-media gate, and text screening only ever rejects.
      //
      // They travel TWICE, deliberately: as HEADERS, which the API's
      // pre-buffer gate reads before it accepts a single byte of the body
      // (a multipart field cannot gate that — reaching one means the whole
      // upload was already parsed into memory), and as the multipart
      // FIELDS, which remain the audited record stored with the asset.
      const attestationHeaders: Record<string, string> = {};
      for (const { field, header } of UPLOAD_ATTESTATIONS) {
        formData.append(field, 'true');
        attestationHeaders[header] = 'true';
      }
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
      const asset = await apiUpload<VideoAsset>(
        '/video-assets',
        formData,
        attestationHeaders,
      );
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
        {UPLOAD_ATTESTATIONS.map(({ field, label, title }) => (
          <label
            key={field}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            title={title}
          >
            <input
              type="checkbox"
              checked={attested[field] ?? false}
              onChange={(e) =>
                setAttested((current) => ({
                  ...current,
                  [field]: e.target.checked,
                }))
              }
            />
            {label}
          </label>
        ))}
        <button
          className="primary"
          type="submit"
          disabled={uploading || !allAttested}
        >
          {uploading ? 'Uploading…' : 'Upload test video'}
        </button>
      </form>
      <p className="muted">
        Uploads accept CONTROLLED INTERNAL TEST MEDIA only, and are disabled
        unless the server has the test-media policy gate enabled (a 503
        otherwise). The four boxes are your declarations, not a safety
        guarantee — the API records them and screens frame text, but that
        screen can only REJECT a clip: detecting nothing is not evidence
        that nothing is there.
      </p>
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
  const [groundTruthTick, setGroundTruthTick] = useState(0);
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

  // Screening decision (QUARANTINED assets only): the upload attestation is
  // defense-in-depth — this audited decision is what releases (or rejects)
  // the quarantined bytes before ANY processing.
  const [screeningNote, setScreeningNote] = useState('');
  // In-memory screening preview frames (audited server-side, never
  // persisted): the screener inspects them before Approve/Reject instead of
  // attesting blind.
  const [preview, setPreview] = useState<ScreeningPreview | null>(null);

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

  async function loadPreview() {
    // Deliberately NOT run(): a preview is a read (no reload needed), and
    // the 503 case gets its own actionable message.
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api<ScreeningPreview>(
        `/video-assets/${id}/screening-preview`,
        { method: 'POST', body: {} },
      );
      setPreview(result);
      if (result.frames.length === 0) {
        setNotice(
          'The preview returned no frames (nothing decodable at the ' +
            'sampled positions). Decide from the staged clip itself, or ' +
            'reject if it cannot be verified.',
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setActionError(
          'Preview unavailable: the video extractor is not available right ' +
            'now. Retry later — the screening decision stays open; nothing ' +
            'was rejected.',
        );
      } else {
        setActionError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function screen(decision: 'APPROVE' | 'REJECT') {
    await run(async () => {
      const note = screeningNote.trim();
      await api(`/video-assets/${id}/screening`, {
        method: 'POST',
        body: { decision, ...(note ? { note } : {}) },
      });
      setScreeningNote('');
      setPreview(null);
      setNotice(
        decision === 'APPROVE'
          ? 'Screening approved — the asset is released for validation.'
          : 'Screening rejected — the stored media was removed; the ' +
              'metadata row is kept as evidence.',
      );
    });
  }

  async function extractFrames(event: FormEvent) {
    event.preventDefault();
    // An empty single-frame field means interval SAMPLING (the form's other
    // mode); a non-empty one is validated strictly against the probed
    // duration BEFORE any request — invalid input never leaves the form,
    // and is never coerced to 0.
    const single = frameTimestampMs.trim();
    let singleTimestampMs: number | null = null;
    if (single) {
      const parsed = parseTimestampMs(single, asset.data?.durationMs ?? null);
      if (parsed.error !== null) {
        setActionError(parsed.error);
        return;
      }
      singleTimestampMs = parsed.value;
    }
    await run(async () => {
      const body =
        singleTimestampMs !== null
          ? {
              timestampMs: singleTimestampMs,
              idempotencyKey: frameIdempotencyKey,
            }
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
    // Strict parse — a cleared field must NOT become Number('') === 0.
    const parsedTimestamp = parseTimestampMs(
      cropTimestampMs,
      asset.data?.durationMs ?? null,
    );
    if (parsedTimestamp.error !== null) {
      setActionError(parsedTimestamp.error);
      return;
    }
    if (!cropWidth.trim() || !cropHeight.trim()) {
      setActionError('Crop width and height are required.');
      return;
    }
    await run(async () => {
      await api(`/video-assets/${id}/crops`, {
        method: 'POST',
        body: {
          timestampMs: parsedTimestamp.value,
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
    <Page
      title="Test video"
      error={asset.error}
      // Loading gates only the FIRST load: a background refetch (e.g.
      // after saving ground truth) must not unmount the children — that
      // would wipe transient UI state like the save-success notice.
      loading={asset.loading && !asset.data}
    >
      {data ? (
        <div className="detail">
          {actionError ? <div className="error">{actionError}</div> : null}
          {notice ? <p className="muted">{notice}</p> : null}
          {data.status === 'QUARANTINED' ? (
            <>
              <p className="muted">
                Pending frame-content screening: the upload is QUARANTINED
                and cannot be validated or processed until an audited
                screening decision approves it. Rejecting removes the stored
                media (the metadata row is kept as evidence). Load the
                preview frames and inspect them before deciding — the
                preview is extracted in memory, audited, and never
                persisted.
              </p>
              <div className="toolbar">
                <button
                  disabled={busy}
                  title={
                    'Sample frames of the quarantined clip, extracted in ' +
                    'memory and audited — inspect before Approve/Reject.'
                  }
                  onClick={() => void loadPreview()}
                >
                  {preview
                    ? 'Reload preview frames'
                    : 'Load preview frames (audited)'}
                </button>
                {preview ? (
                  <span className="muted">
                    {preview.frames.length} frame(s) sampled across{' '}
                    {formatDurationMs(preview.durationMs)}
                    {preview.skippedOverBudget > 0
                      ? `; ${preview.skippedOverBudget} skipped (over the byte budget)`
                      : ''}
                  </span>
                ) : null}
              </div>
              {preview && preview.frames.length > 0 ? (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.75rem',
                    margin: '0.5rem 0 1rem',
                  }}
                >
                  {preview.frames.map((frame) => (
                    <figure
                      key={frame.timestampMs}
                      style={{ margin: 0, textAlign: 'center' }}
                    >
                      <img
                        src={`data:${frame.mimeType};base64,${frame.imageBase64}`}
                        alt={`Preview frame at ${formatDurationMs(frame.timestampMs)}`}
                        width={frame.width}
                        height={frame.height}
                        style={{
                          maxWidth: '14rem',
                          height: 'auto',
                          display: 'block',
                          border: '1px solid var(--border, #ccc)',
                          borderRadius: '4px',
                        }}
                      />
                      <figcaption className="muted">
                        {formatDurationMs(frame.timestampMs)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
              <div className="toolbar">
                <input
                  type="text"
                  maxLength={500}
                  style={{ minWidth: '18rem' }}
                  placeholder="Screening note (optional, audited)"
                  value={screeningNote}
                  onChange={(e) => setScreeningNote(e.target.value)}
                />
                <button
                  className="primary"
                  // Approval requires an inspection: enabled only once a
                  // preview actually served frames in THIS session. The
                  // server enforces the same rule (recorded real-frame
                  // inspection evidence, fresh) with a controlled 409.
                  disabled={busy || !preview || preview.frames.length === 0}
                  title={
                    !preview || preview.frames.length === 0
                      ? 'Load the preview to enable approval — approval ' +
                        'requires a recorded real-frame inspection.'
                      : 'Release the inspected upload for processing ' +
                        '(audited).'
                  }
                  onClick={() => void screen('APPROVE')}
                >
                  Approve screening
                </button>
                <button
                  disabled={busy}
                  onClick={() => void screen('REJECT')}
                >
                  Reject screening (remove media)
                </button>
                {!preview || preview.frames.length === 0 ? (
                  <span className="muted">
                    Load the preview to enable approval — approval requires
                    a recorded real-frame inspection. Reject stays available
                    without one.
                  </span>
                ) : null}
              </div>
            </>
          ) : null}
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
            <>
              <PickupDetectionPanel
                assetId={data.id}
                durationMs={data.durationMs}
                onGroundTruthSaved={() => {
                  // Refresh the asset AND the shadow comparison in place —
                  // no page reload (the server recomputes verdicts on read).
                  setGroundTruthTick((n) => n + 1);
                  setReload((n) => n + 1);
                }}
              />
              <FusionEvidencePanel
                assetId={data.id}
                refreshKey={groundTruthTick}
              />
            </>
          ) : null}
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
