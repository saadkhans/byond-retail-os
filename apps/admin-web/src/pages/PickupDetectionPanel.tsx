import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  GroundTruthEventKind,
  GroundTruthView,
  Paginated,
  PickupDetectionState,
  Product,
  api,
  apiObjectUrl,
} from '../api';
import { useLoad } from '../components';
import {
  GroundTruthFieldErrors,
  canReview,
  confidencePercent,
  detectionHeadline,
  formatMs,
  jobInFlight,
  jobStatusLabel,
  markerPercent,
  validateGroundTruth,
} from '../pickup-detection-utils';

/**
 * Ground-truth capture for one test video: what ACTUALLY happens in the
 * clip, entered by the operator who staged it. The validation dashboard
 * scores detections against these rows.
 */
function GroundTruthForm({
  assetId,
  products,
  durationMs,
  onSaved,
}: {
  assetId: string;
  products: Product[];
  durationMs: number | null;
  onSaved?: () => void;
}) {
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<GroundTruthFieldErrors>({});
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<GroundTruthEventKind>('PICKUP');
  const [productId, setProductId] = useState('');
  const [timestampMs, setTimestampMs] = useState('');
  const [quantity, setQuantity] = useState('1');

  const existing = useLoad<GroundTruthView | null>(
    () => api(`/video-assets/${assetId}/ground-truth`),
    [assetId, reload],
  );

  useEffect(() => {
    const truth = existing.data;
    if (truth) {
      setKind(truth.eventKind);
      setProductId(truth.productId ?? '');
      setTimestampMs(
        truth.actualTimestampMs !== null ? String(truth.actualTimestampMs) : '',
      );
      setQuantity(String(truth.quantity));
    }
  }, [existing.data?.videoAssetId, existing.data?.updatedAt]);

  async function save(event: FormEvent) {
    // Plain form submit — no stale closure: every value is read from
    // CURRENT state right here, at click time.
    event.preventDefault();
    setApiError(null);
    setSavedNotice(null);
    const validated = validateGroundTruth({
      eventKind: kind,
      productId,
      timestampMs,
      quantity,
      durationMs,
    });
    if (!validated.ok) {
      // Visible inline errors — a click is NEVER silently ignored.
      setFieldErrors(validated.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      // `payload.productId` is the canonical product id (the option VALUE),
      // and `actualTimestampMs`/`quantity` are validated numbers.
      const saved = await api<GroundTruthView>(
        `/video-assets/${assetId}/ground-truth`,
        { method: 'PUT', body: validated.payload },
      );
      setSavedNotice(
        `Saved: ${saved.eventKind}${saved.sku ? ` · ${saved.sku}` : ''}` +
          `${saved.actualTimestampMs !== null ? ` @ ${saved.actualTimestampMs} ms` : ''} × ${saved.quantity}`,
      );
      setReload((n) => n + 1);
      onSaved?.();
    } catch (err) {
      // Non-2xx surfaces verbatim; the button re-enables below.
      setApiError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setSaving(false);
    }
  }

  const fieldErrorStyle = { color: '#c0392b', fontSize: '0.85em' };

  return (
    <div style={{ margin: '0.75rem 0' }}>
      <h3 style={{ marginBottom: '0.25rem' }}>Ground truth (what really happens)</h3>
      {apiError ? <div className="error">{apiError}</div> : null}
      {savedNotice ? (
        <p className="muted" style={{ color: '#1e7e34' }}>
          ✓ {savedNotice}
        </p>
      ) : null}
      <form className="toolbar" onSubmit={(e) => void save(e)} style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as GroundTruthEventKind)}
        >
          <option value="PICKUP">Pickup</option>
          <option value="RETURN">Return</option>
          <option value="NONE">No pickup in this clip</option>
        </select>
        {kind !== 'NONE' ? (
          <>
            <span>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                <option value="">Actual product…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} ({product.sku})
                  </option>
                ))}
              </select>
              {fieldErrors.productId ? (
                <div style={fieldErrorStyle}>{fieldErrors.productId}</div>
              ) : null}
            </span>
            <span>
              <input
                type="number"
                min={0}
                step={1}
                style={{ width: '10rem' }}
                placeholder="Actual instant (ms)"
                value={timestampMs}
                onChange={(e) => setTimestampMs(e.target.value)}
              />
              {fieldErrors.timestampMs ? (
                <div style={fieldErrorStyle}>{fieldErrors.timestampMs}</div>
              ) : null}
            </span>
            <span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                style={{ width: '6rem' }}
                title="Number of products taken"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {fieldErrors.quantity ? (
                <div style={fieldErrorStyle}>{fieldErrors.quantity}</div>
              ) : null}
            </span>
          </>
        ) : null}
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save ground truth'}
        </button>
        {existing.data ? (
          <span className="muted">
            saved: {existing.data.eventKind}
            {existing.data.sku ? ` · ${existing.data.sku}` : ''}
            {existing.data.actualTimestampMs !== null
              ? ` @ ${existing.data.actualTimestampMs} ms`
              : ''}
          </span>
        ) : (
          <span className="muted">not recorded yet</span>
        )}
      </form>
    </div>
  );
}

/**
 * Automatic pickup-detection result surface on the video-asset page:
 * player + timeline marker, product identification (or UNKNOWN_PRODUCT),
 * match score, event window, job status, ground-truth capture, and the
 * correct/incorrect/manual correction review controls (wired to the
 * vision-event review contract).
 */
export function PickupDetectionPanel({
  assetId,
  durationMs,
  onGroundTruthSaved,
}: {
  assetId: string;
  durationMs: number | null;
  onGroundTruthSaved?: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [overrideProductId, setOverrideProductId] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  const state = useLoad<PickupDetectionState>(
    () => api(`/video-assets/${assetId}/pickup-detection`),
    [assetId, tick],
  );
  const data = state.data;

  // Poll while an attempt is in flight — or while the automatic worker has
  // not created one yet (it scans every few seconds after validation).
  useEffect(() => {
    if (!data || !data.enabled) {
      return;
    }
    if (data.job && !jobInFlight(data.job.status)) {
      return;
    }
    const timer = setInterval(() => setTick((n) => n + 1), 2500);
    return () => clearInterval(timer);
  }, [data?.enabled, data?.job?.status, data?.job?.id]);

  // Media for the player (authenticated blob — see apiObjectUrl).
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void apiObjectUrl(`/video-assets/${assetId}/media`).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revoked = url;
      setMediaUrl(url);
    });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [assetId]);

  // Crop thumbnail once a detection exists.
  const cropArtifactId = data?.detection?.cropArtifactId ?? null;
  useEffect(() => {
    if (!cropArtifactId) {
      setThumbUrl(null);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    void apiObjectUrl(
      `/video-assets/${assetId}/artifacts/${cropArtifactId}/image`,
    ).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revoked = url;
      setThumbUrl(url);
    });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [assetId, cropArtifactId]);

  const products = useLoad<Paginated<Product>>(
    () => api<Paginated<Product>>('/catalog/products?take=100'),
    [],
  );

  async function run(options: { force?: boolean } = {}) {
    setBusy(true);
    setActionError(null);
    try {
      // force only on the explicit "Re-run detection" action — the plain
      // run stays idempotent (a retry replays the successful attempt).
      await api(
        `/video-assets/${assetId}/pickup-detection/run${
          options.force ? '?force=true' : ''
        }`,
        {
          method: 'POST',
          body: {},
        },
      );
      setTick((n) => n + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusy(false);
    }
  }

  async function review(
    decision: 'APPROVE' | 'REJECT' | 'OVERRIDE',
    extra: Record<string, unknown> = {},
  ) {
    if (!data?.detection) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api(`/vision-events/${data.detection.visionEventId}/review`, {
        method: 'POST',
        body: { decision, ...extra },
      });
      setTick((n) => n + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusy(false);
    }
  }

  function seek(ms: number) {
    const video = videoRef.current;
    if (video) {
      video.currentTime = ms / 1000;
      void video.play().catch(() => undefined);
      video.pause();
    }
  }

  if (state.loading) {
    return <p className="muted">Loading pickup detection…</p>;
  }
  if (state.error) {
    return <div className="error">{state.error}</div>;
  }
  if (!data) {
    return null;
  }

  const detection = data.detection;
  const job = data.job;

  return (
    <div style={{ margin: '1rem 0' }}>
      <h2>Automatic pickup detection</h2>
      {!data.enabled ? (
        <p className="muted">
          Pickup detection is disabled on this deployment
          (PICKUP_DETECTION_ENABLED).
        </p>
      ) : null}
      {actionError ? <div className="error">{actionError}</div> : null}

      {job ? (
        <div className="toolbar">
          <span className={`badge ${
            job.status === 'SUCCEEDED'
              ? 'ok'
              : job.status === 'FAILED'
                ? 'down'
                : 'warn'
          }`}>
            {jobStatusLabel(job.status)}
          </span>
          <span className="muted">
            attempt {job.attempts} · adapter {job.adapterKey ?? '—'}
          </span>
          {jobInFlight(job.status) ? (
            <span className="muted">analyzing…</span>
          ) : null}
          <button
            disabled={busy || jobInFlight(job.status)}
            onClick={() => void run({ force: true })}
          >
            Re-run detection
          </button>
        </div>
      ) : (
        <div className="toolbar">
          <span className="muted">No detection attempt yet.</span>
          <button disabled={busy || !data.enabled} onClick={() => void run()}>
            Run detection
          </button>
        </div>
      )}

      {job?.status === 'FAILED' ? (
        <div className="error">
          Detection failed{job.errorCode ? ` (${job.errorCode})` : ''}:{' '}
          {job.errorMessage ?? 'no further detail'}
        </div>
      ) : null}

      <GroundTruthForm
        assetId={assetId}
        products={products.data?.items ?? []}
        durationMs={durationMs}
        onSaved={onGroundTruthSaved}
      />

      {mediaUrl ? (
        <div style={{ maxWidth: '40rem' }}>
          <video
            ref={videoRef}
            src={mediaUrl}
            controls
            style={{ width: '100%', borderRadius: 4 }}
          />
          {detection && durationMs ? (
            <div
              title="Pickup timeline — the marker is the detected peak"
              style={{
                position: 'relative',
                height: 14,
                background: 'var(--border, #d8d8e0)',
                borderRadius: 7,
                margin: '0.4rem 0',
                cursor: 'pointer',
              }}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const fraction = (event.clientX - rect.left) / rect.width;
                seek(fraction * durationMs);
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: `${markerPercent(detection.eventStartMs, durationMs)}%`,
                  width: `${Math.max(
                    1,
                    markerPercent(detection.eventEndMs, durationMs) -
                      markerPercent(detection.eventStartMs, durationMs),
                  )}%`,
                  top: 0,
                  bottom: 0,
                  background: 'rgba(90, 120, 255, 0.35)',
                  borderRadius: 7,
                }}
              />
              <div
                title={`Pickup peak at ${formatMs(detection.eventPeakMs)}`}
                style={{
                  position: 'absolute',
                  left: `calc(${markerPercent(detection.eventPeakMs, durationMs)}% - 2px)`,
                  width: 4,
                  top: -3,
                  bottom: -3,
                  background: '#e0483c',
                  borderRadius: 2,
                }}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="muted">
          The clip preview is unavailable (media not viewable for this asset
          or missing permission).
        </p>
      )}

      {detection ? (
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            alignItems: 'flex-start',
            border: '1px solid var(--border, #d8d8e0)',
            borderRadius: 6,
            padding: '0.75rem',
            maxWidth: '40rem',
          }}
        >
          {thumbUrl ? (
            <img
              src={thumbUrl}
              alt="Detected product crop"
              style={{ width: '8rem', height: 'auto', borderRadius: 4 }}
            />
          ) : (
            <div className="muted" style={{ width: '8rem' }}>
              (no crop image)
            </div>
          )}
          <div style={{ flex: 1 }}>
            <p style={{ marginTop: 0 }}>
              <strong>{detectionHeadline(data)}</strong>
            </p>
            <dl style={{ margin: 0 }}>
              <dt title="Raw HSV-histogram + NCC similarity — not a calibrated probability">
                Match score
              </dt>
              <dd>{confidencePercent(detection.confidence)}</dd>
              <dt>Event window</dt>
              <dd>
                start {formatMs(detection.eventStartMs)} · peak{' '}
                <button
                  style={{ padding: '0 0.4rem' }}
                  onClick={() => seek(detection.eventPeakMs)}
                >
                  {formatMs(detection.eventPeakMs)}
                </button>{' '}
                · end {formatMs(detection.eventEndMs)}
              </dd>
              <dt>Bounding box</dt>
              <dd>
                {detection.boundingBox.width}×{detection.boundingBox.height} @ (
                {detection.boundingBox.x}, {detection.boundingBox.y})
              </dd>
              <dt>Top candidates</dt>
              <dd>
                {detection.candidates.length > 0 ? (
                  <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
                    {detection.candidates.slice(0, 5).map((candidate) => (
                      <li key={candidate.sku}>
                        {candidate.productName} ({candidate.sku}) —{' '}
                        {candidate.score !== null
                          ? `${Math.round(candidate.score * 100)}%`
                          : '—'}
                      </li>
                    ))}
                  </ol>
                ) : (
                  '—'
                )}
              </dd>
              <dt>Method</dt>
              <dd>
                {detection.modelKey} v{detection.modelVersion}
              </dd>
              <dt>Review</dt>
              <dd>
                {detection.review
                  ? `${detection.review.decision}${
                      detection.review.reason
                        ? ` — ${detection.review.reason}`
                        : ''
                    }`
                  : detection.visionEventStatus}
              </dd>
            </dl>
            {canReview(data) ? (
              <div className="toolbar" style={{ marginTop: '0.5rem' }}>
                <button
                  className="primary"
                  disabled={busy || detection.result === 'UNKNOWN_PRODUCT'}
                  title={
                    detection.result === 'UNKNOWN_PRODUCT'
                      ? 'Nothing was claimed — use the correction picker instead'
                      : 'Confirm the identification is correct'
                  }
                  onClick={() =>
                    void review('APPROVE', {
                      reason: 'Pickup detection confirmed correct',
                    })
                  }
                >
                  Correct
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void review('REJECT', {
                      reason: 'Pickup detection marked incorrect',
                    })
                  }
                >
                  Incorrect
                </button>
                <select
                  value={overrideProductId}
                  onChange={(e) => setOverrideProductId(e.target.value)}
                >
                  <option value="">Correct product…</option>
                  {(products.data?.items ?? []).map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({product.sku})
                    </option>
                  ))}
                </select>
                <button
                  disabled={busy || !overrideProductId}
                  onClick={() =>
                    void review('OVERRIDE', {
                      productId: overrideProductId,
                      quantity: 1,
                      reason: 'Manual product correction from pickup review',
                    })
                  }
                >
                  Apply correction
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
