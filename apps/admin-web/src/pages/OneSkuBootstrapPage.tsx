import { CSSProperties, FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  CvTestScenario,
  GroundTruthView,
  OneSkuBootstrapReport,
  OneSkuVideoRow,
  Paginated,
  Product,
  Store,
  VideoArtifact,
  VideoAsset,
  api,
  apiObjectUrl,
  apiUpload,
} from '../api';
import { Page, useDebounced, useLoad } from '../components';
import { TEST_TYPE_LABEL } from '../cv-evaluation-utils';
import {
  CROP_WARNING_LABELS,
  EXCLUDED_REASON_LABELS,
  FAILURE_REASON_LABELS,
  MANUAL_CROP_REASONS,
  ManualCropDraft,
  ManualCropFieldErrors,
  REFERENCE_ANGLES,
  basketDeltaLabel,
  deriveStatusHeader,
  gateProgress,
  nextBestAction,
  oneSkuEvaluationRunPath,
  oneSkuReportPath,
  oneSkuReviewPath,
  overlayRectStyle,
  validateManualCrop,
} from '../one-sku-bootstrap-utils';
import {
  GroundTruthFieldErrors,
  validateGroundTruth,
} from '../pickup-detection-utils';
import { mergeProducts, productSearchPaths } from './ReferenceLibraryPage';
import { ACCEPTED_EXTENSIONS, UPLOAD_ATTESTATIONS } from './VideoAssetsPage';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

const fieldErrorStyle = { color: '#c0392b', fontSize: '0.85em' };
const border = '1px solid var(--border, #d8d8e0)';
const stepCard: CSSProperties = {
  border,
  borderRadius: 8,
  padding: '0.9rem 1.1rem',
  margin: '0.9rem 0',
};

function StepHeading({ n, title }: { n: number; title: string }) {
  return (
    <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', margin: '0 0 0.5rem' }}>
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '1.7rem',
          height: '1.7rem',
          borderRadius: '50%',
          background: 'var(--accent, #4c6ef5)',
          color: '#fff',
          fontSize: '0.95rem',
        }}
      >
        {n}
      </span>
      {title}
    </h2>
  );
}

function WarningBadges({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return <span className="badge ok">clean crop</span>;
  }
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.3rem' }}>
      {warnings.map((warning) => (
        <span key={warning} className="badge warn">
          {CROP_WARNING_LABELS[warning] ?? warning}{' '}
          <span style={{ opacity: 0.65, fontSize: '0.8em' }}>{warning}</span>
        </span>
      ))}
    </span>
  );
}

/** Static first-SKU standard operating procedure — the counts MATCH the
 *  Phase 18 per-action minimum (5) so bootstrap-ready means
 *  dataset-ready, not a smoke test. */
function SopPanel() {
  return (
    <aside style={{ ...stepCard, background: 'var(--panel, rgba(76,110,245,0.06))' }}>
      <strong>First SKU SOP</strong>
      <ol style={{ margin: '0.4rem 0 0 1.2rem', lineHeight: 1.7 }}>
        <li>Upload 8–12 reference images (all angles below)</li>
        <li>Record 5 pickup videos</li>
        <li>Record 5 return videos</li>
        <li>Record 5 false-touch videos (touch, no removal)</li>
        <li>Review every result (correct / wrong SKU / wrong action / false touch)</li>
        <li>Send reviewed examples to Dataset Improvement</li>
      </ol>
      <p className="muted" style={{ margin: '0.4rem 0 0' }}>
        Fewer clips make a smoke test only — the page will not claim
        dataset-ready below these minimums.
      </p>
    </aside>
  );
}

/** Safe per-clip summary — ONLY classified fields from the bootstrap
 *  report (never raw fusion evidence, OCR/barcode text, or VLM
 *  provider/environment details). */
function CropQualityCard({
  row,
  onManualCrop,
}: {
  row: OneSkuVideoRow;
  onManualCrop: () => void;
}) {
  const fusion = row.fusion;
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  const cropArtifactId = fusion?.cropArtifactId ?? null;

  useEffect(() => {
    if (!cropArtifactId) {
      setCropUrl(null);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    void apiObjectUrl(
      `/video-assets/${row.videoAssetId}/artifacts/${cropArtifactId}/image`,
    ).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      revoked = url;
      setCropUrl(url);
    });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [row.videoAssetId, cropArtifactId]);

  if (!fusion) {
    return (
      <p className="muted">
        No fusion run yet — run the shadow analysis to see crop quality.
      </p>
    );
  }
  const crop = fusion.selectedCrop;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-start' }}>
      <div style={{ minWidth: '9rem' }}>
        {cropUrl ? (
          <img
            src={cropUrl}
            alt="Selected crop"
            style={{ maxWidth: '9rem', maxHeight: '9rem', border, borderRadius: 6 }}
          />
        ) : (
          <div
            style={{
              width: '9rem',
              height: '6rem',
              border,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            className="muted"
          >
            no crop image
          </div>
        )}
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          {fusion.cropSource === 'OPERATOR'
            ? 'operator-selected crop'
            : 'automatic crop'}
        </p>
        {fusion.cropSource === 'OPERATOR' && !fusion.cropEvidenceConnected ? (
          <p style={{ margin: '0.25rem 0 0' }}>
            <span className="badge warn">not connected to evidence</span>{' '}
            <span className="muted">
              record a correction below to bind this crop into the reviewed
              evidence — until then it cannot satisfy the crop gate
            </span>
          </p>
        ) : null}
      </div>
      <dl className="detail" style={{ flex: 1, minWidth: '16rem' }}>
        <dt>Quality</dt>
        <dd>
          <WarningBadges warnings={fusion.cropWarnings} />
        </dd>
        {crop ? (
          <>
            <dt>Bounding box</dt>
            <dd>
              {crop.box.width}×{crop.box.height} @ ({crop.box.x}, {crop.box.y}) ·{' '}
              {crop.timestampMs} ms
            </dd>
            <dt>Metrics</dt>
            <dd>
              {crop.qualityKnown
                ? `sharpness ${crop.sharpness.toFixed(1)} · occlusion ${Math.round(crop.occlusion * 100)}% · brightness ${Math.round(crop.brightness)}`
                : 'visually confirmed by operator (no pixel metrics)'}
            </dd>
          </>
        ) : null}
        <dt>Top prediction</dt>
        <dd>
          {fusion.topSku ?? 'UNKNOWN'}
          {fusion.topScore !== null ? ` (${Math.round(fusion.topScore * 100)}%)` : ''}{' '}
          · {fusion.policy}
        </dd>
        <dt>VLM verdict</dt>
        <dd>
          {fusion.vlmInvoked
            ? `${fusion.vlmVerdict ?? fusion.vlmStatus ?? '—'}` +
              (fusion.vlmVisualSupport ? ` · visual ${fusion.vlmVisualSupport}` : '') +
              (fusion.vlmReasonCodes.length ? ` · ${fusion.vlmReasonCodes.join(', ')}` : '') +
              (fusion.vlmRequiresHumanReview ? ' · needs human review' : '')
            : 'not invoked'}
        </dd>
      </dl>
      <button onClick={onManualCrop}>Draw a manual crop instead</button>
    </div>
  );
}

/** Ground truth for the SELECTED clip — expected SKU is pinned to the
 *  bootstrap SKU (spec: chosen automatically). */
function BootstrapGroundTruthForm({
  assetId,
  product,
  durationMs,
  onSaved,
}: {
  assetId: string;
  product: { id: string; sku: string };
  durationMs: number | null;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<'PICKUP' | 'RETURN' | 'NONE'>('PICKUP');
  const [timestampMs, setTimestampMs] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [testType, setTestType] = useState('');
  const [saving, setSaving] = useState(false);
  const [apiErrorText, setApiErrorText] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<GroundTruthFieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const existing = useLoad<GroundTruthView | null>(
    () => api(`/video-assets/${assetId}/ground-truth`),
    [assetId, reload],
  );
  useEffect(() => {
    const truth = existing.data;
    if (truth) {
      setKind(truth.eventKind);
      setTimestampMs(
        truth.actualTimestampMs !== null ? String(truth.actualTimestampMs) : '',
      );
      setQuantity(String(truth.quantity));
      setTestType(truth.testType ?? '');
    }
  }, [existing.data?.videoAssetId, existing.data?.updatedAt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setApiErrorText(null);
    setNotice(null);
    const validated = validateGroundTruth({
      eventKind: kind,
      productId: kind === 'NONE' ? '' : product.id,
      timestampMs,
      quantity,
      durationMs,
    });
    if (!validated.ok) {
      setFieldErrors(validated.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      await api(`/video-assets/${assetId}/ground-truth`, {
        method: 'PUT',
        body: { ...validated.payload, ...(testType ? { testType } : {}) },
      });
      setNotice(`Ground truth saved (${kind}${kind === 'NONE' ? '' : ` · ${product.sku}`}).`);
      setReload((n) => n + 1);
      onSaved();
    } catch (err) {
      setApiErrorText(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 0.25rem' }}>Ground truth (what really happens)</h3>
      {apiErrorText ? <div className="error">{apiErrorText}</div> : null}
      {notice ? <p className="muted">✓ {notice}</p> : null}
      <form className="toolbar" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }} onSubmit={(e) => void save(e)}>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="PICKUP">Pickup</option>
          <option value="RETURN">Return</option>
          <option value="NONE">False touch / nothing removed</option>
        </select>
        {kind !== 'NONE' ? (
          <>
            <span className="badge">{product.sku}</span>
            <label>
              Instant (ms){' '}
              <input
                type="text"
                style={{ width: '6rem' }}
                value={timestampMs}
                onChange={(e) => setTimestampMs(e.target.value)}
              />
              {fieldErrors.timestampMs ? (
                <div style={fieldErrorStyle}>{fieldErrors.timestampMs}</div>
              ) : null}
            </label>
            <label>
              Qty{' '}
              <input
                type="text"
                style={{ width: '3rem' }}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {fieldErrors.quantity ? (
                <div style={fieldErrorStyle}>{fieldErrors.quantity}</div>
              ) : null}
            </label>
          </>
        ) : null}
        <select value={testType} onChange={(e) => setTestType(e.target.value)}>
          <option value="">— scenario label (optional) —</option>
          {(Object.keys(TEST_TYPE_LABEL) as CvTestScenario[]).map((scenario) => (
            <option key={scenario} value={scenario}>
              {TEST_TYPE_LABEL[scenario]}
            </option>
          ))}
        </select>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save ground truth'}
        </button>
      </form>
    </div>
  );
}

/**
 * RECORD-ONLY corrections: each button posts a bootstrap review through
 * the one-sku-bootstrap API, which appends a Phase 15 pilot review on the
 * clip's imported shadow journey event. This page NEVER uses the
 * vision-event review endpoint (whose approve/override path can mutate
 * checkout basket lines), and excluded clips are refused server-side.
 *
 * The primary action is DERIVED from the prediction-vs-ground-truth
 * comparison (Codex P1): CORRECT is offered only when SKU AND action
 * both match; a right-SKU/wrong-action prediction records WRONG_ACTION
 * with the corrected action — never a mislabeling CORRECT.
 */
function CorrectionPanel({
  row,
  productId,
  products,
  onRecorded,
}: {
  row: OneSkuVideoRow;
  productId: string;
  products: Product[];
  onRecorded: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [correctedProductId, setCorrectedProductId] = useState(productId);
  const [actionErrorText, setActionErrorText] = useState<string | null>(null);

  const isNone = row.eventKind === 'NONE';
  const gtAction = row.eventKind === 'RETURN' ? 'RETURN' : 'PICKUP';
  const predictedAction = row.fusion?.detectedKind ?? null;
  const skuMatches =
    row.predictedSku !== null && row.predictedSku === row.expectedSku;
  const actionMatches =
    predictedAction !== null && predictedAction === row.eventKind;
  const bothMatch = !isNone && skuMatches && actionMatches;
  const wrongActionOnly = !isNone && skuMatches && !actionMatches;
  const wrongSkuOnly = !isNone && !skuMatches && actionMatches;
  const bothWrong = !isNone && !skuMatches && !actionMatches;

  async function record(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setActionErrorText(null);
    try {
      await api(oneSkuReviewPath(productId, row.videoAssetId), {
        method: 'POST',
        body,
      });
      onRecorded(message);
    } catch (err) {
      setActionErrorText(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 0.25rem' }}>Correct / approve evidence</h3>
      {actionErrorText ? <div className="error">{actionErrorText}</div> : null}
      {row.bootstrapReviewVerdict ? (
        <p className="muted">
          Latest bootstrap review:{' '}
          <span className={row.bootstrapReviewEligible ? 'badge ok' : 'badge warn'}>
            {row.bootstrapReviewVerdict}
            {row.bootstrapReviewEligible ? '' : ' (not dataset-eligible)'}
          </span>{' '}
          (a changed mind appends a newer review)
        </p>
      ) : null}
      {!isNone ? (
        <p className="muted">
          Prediction: {row.predictedSku ?? 'UNKNOWN'}
          {predictedAction ? ` · ${predictedAction}` : ''} — ground truth:{' '}
          {row.expectedSku} · {gtAction}
        </p>
      ) : null}
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        {bothMatch ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void record(
                { verdict: 'CORRECT', expectedAction: gtAction },
                'Recorded: prediction confirmed correct (SKU and action match).',
              )
            }
          >
            Confirm correct
          </button>
        ) : null}
        {wrongActionOnly ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void record(
                { verdict: 'WRONG_ACTION', expectedAction: gtAction },
                `Recorded: wrong action — corrected to ${gtAction}.`,
              )
            }
          >
            Record wrong action (corrected: {gtAction})
          </button>
        ) : null}
        {wrongSkuOnly || bothWrong ? (
          <>
            <select
              value={correctedProductId}
              onChange={(e) => setCorrectedProductId(e.target.value)}
              title="The product that was ACTUALLY handled"
            >
              {products.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.sku}
                </option>
              ))}
            </select>
            {wrongSkuOnly ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void record(
                    {
                      verdict: 'WRONG_SKU',
                      expectedAction: gtAction,
                      expectedProductId: correctedProductId,
                    },
                    'Recorded: wrong SKU, corrected label saved.',
                  )
                }
              >
                Record wrong SKU
              </button>
            ) : (
              // Both labels wrong: Phase 18's WRONG_ACTION path corrects
              // BOTH when the corrected product rides along — WRONG_SKU
              // would keep the detector's known-wrong action.
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void record(
                    {
                      verdict: 'WRONG_ACTION',
                      expectedAction: gtAction,
                      expectedProductId: correctedProductId,
                    },
                    `Recorded: wrong SKU AND action — corrected to ${gtAction} with the corrected product.`,
                  )
                }
              >
                Record wrong SKU + action (corrected: {gtAction})
              </button>
            )}
          </>
        ) : null}
        <button
          className={isNone ? 'primary' : undefined}
          disabled={busy}
          onClick={() =>
            void record(
              { verdict: 'FALSE_TOUCH', expectedAction: 'NO_OP' },
              'Recorded: false touch — nothing was removed.',
            )
          }
        >
          False touch / nothing removed
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void record(
              { verdict: 'UNCERTAIN', expectedAction: 'UNKNOWN' },
              'Recorded: uncertain — excluded from the dataset (recapture recommended).',
            )
          }
        >
          Uncertain
        </button>
      </div>
      {bothWrong ? (
        <p className="muted">
          Both SKU and action differ from ground truth — the wrong SKU +
          action correction fixes BOTH labels for the dataset (Phase 18
          takes the corrected product and the corrected action together).
        </p>
      ) : null}
      <p className="muted">
        Corrections append pilot-review records only (the Phase 18 dataset
        source) — no basket, order, payment, or inventory change ever
        results from them.
      </p>
    </div>
  );
}

/** Manual crop tool (unchanged endpoint contract: integers + closed
 *  reason enum + required idempotency key — no free text). */
function ManualCropTool({
  assetId,
  durationMs,
  onCropCreated,
}: {
  assetId: string;
  durationMs: number | null;
  onCropCreated?: () => void;
}) {
  const [draft, setDraft] = useState<ManualCropDraft>({
    timestampMs: '',
    x: '',
    y: '',
    width: '',
    height: '',
    reason: 'PRODUCT_PICKUP',
  });
  const [errors, setErrors] = useState<ManualCropFieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [actionErrorText, setActionErrorText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState<VideoArtifact | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(() => crypto.randomUUID());
  const [cropKey, setCropKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!frame) {
      setFrameUrl(null);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    void apiObjectUrl(`/video-assets/${assetId}/artifacts/${frame.id}/image`).then(
      (url) => {
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        revoked = url;
        setFrameUrl(url);
      },
    );
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [assetId, frame?.id]);

  function setField(field: keyof ManualCropDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function extractFrame() {
    setActionErrorText(null);
    setNotice(null);
    const validated = validateManualCrop(
      { ...draft, x: '0', y: '0', width: '1', height: '1' },
      durationMs,
    );
    if (!validated.ok) {
      setErrors({ timestampMs: validated.errors.timestampMs });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api(`/video-assets/${assetId}/extract-frames`, {
        method: 'POST',
        body: {
          timestampMs: validated.payload.timestampMs,
          idempotencyKey: frameKey,
        },
      });
      const artifacts = await api<VideoArtifact[]>(
        `/video-assets/${assetId}/artifacts`,
      );
      const extracted = artifacts
        .filter(
          (artifact) =>
            artifact.artifactType === 'FRAME' &&
            artifact.timestampMs === validated.payload.timestampMs,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!extracted) {
        setActionErrorText('Frame extracted but not found in artifacts yet — retry.');
        return;
      }
      setFrame(extracted);
      setFrameKey(crypto.randomUUID());
      setNotice(`Frame extracted at ${extracted.timestampMs} ms.`);
    } catch (err) {
      setActionErrorText(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createCrop(event: FormEvent) {
    event.preventDefault();
    setActionErrorText(null);
    setNotice(null);
    const validated = validateManualCrop(draft, durationMs);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api(`/video-assets/${assetId}/crops`, {
        method: 'POST',
        body: { ...validated.payload, idempotencyKey: cropKey },
      });
      setCropKey(crypto.randomUUID());
      setNotice(
        'Manual crop saved — the report now uses it as this clip’s ' +
          'operator-selected evidence (SKU label comes from ground truth).',
      );
      onCropCreated?.();
    } catch (err) {
      setActionErrorText(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const cropValidated = validateManualCrop(draft, durationMs);
  const overlay =
    frame && cropValidated.ok
      ? overlayRectStyle(cropValidated.payload, {
          width: frame.width,
          height: frame.height,
        })
      : null;

  return (
    <div>
      <h3 style={{ margin: '0 0 0.25rem' }}>Manual crop</h3>
      <p className="muted">
        Pick the instant the product is clearly visible, extract that frame,
        then enter the crop box in native pixels — the rectangle previews on
        the frame. Coordinates only; no free text, file paths, or source
        references are stored. Saving replaces the automatic crop as this
        clip’s evidence.
      </p>
      {actionErrorText ? <div className="error">{actionErrorText}</div> : null}
      {notice ? <p className="muted">✓ {notice}</p> : null}
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <label>
          Frame at ms{' '}
          <input
            type="text"
            style={{ width: '6rem' }}
            value={draft.timestampMs}
            onChange={(e) => setField('timestampMs', e.target.value)}
          />
        </label>
        <button disabled={busy} onClick={() => void extractFrame()}>
          {busy ? 'Working…' : 'Extract frame'}
        </button>
        {errors.timestampMs ? (
          <span style={fieldErrorStyle}>{errors.timestampMs}</span>
        ) : null}
      </div>
      {frame && frameUrl ? (
        <div
          style={{
            position: 'relative',
            display: 'inline-block',
            maxWidth: 'min(32rem, 100%)',
            border,
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <img
            src={frameUrl}
            alt={`Frame at ${frame.timestampMs} ms`}
            style={{ display: 'block', maxWidth: '100%' }}
          />
          {overlay ? (
            <div
              style={{
                position: 'absolute',
                ...overlay,
                border: '2px solid #e74c3c',
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.25)',
                pointerEvents: 'none',
              }}
            />
          ) : null}
          <p className="muted" style={{ margin: '0.25rem 0.5rem' }}>
            {frame.width}×{frame.height} px @ {frame.timestampMs} ms
          </p>
        </div>
      ) : null}
      <form
        className="toolbar"
        style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
        onSubmit={(e) => void createCrop(e)}
      >
        {(['x', 'y', 'width', 'height'] as const).map((field) => (
          <label key={field}>
            {field}{' '}
            <input
              type="text"
              style={{ width: '5rem' }}
              value={draft[field]}
              onChange={(e) => setField(field, e.target.value)}
            />
            {errors[field] ? (
              <div style={fieldErrorStyle}>{errors[field]}</div>
            ) : null}
          </label>
        ))}
        <label>
          Reason{' '}
          <select
            value={draft.reason}
            onChange={(e) => setField('reason', e.target.value)}
          >
            {MANUAL_CROP_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : 'Create crop'}
        </button>
      </form>
    </div>
  );
}

export function OneSkuBootstrapPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionErrorText, setActionErrorText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [angles, setAngles] = useState<Record<string, boolean>>({});
  const [manualCropOpen, setManualCropOpen] = useState(false);

  const videoInput = useRef<HTMLInputElement>(null);
  const [uploadLocationId, setUploadLocationId] = useState('');
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  const allAttested = UPLOAD_ATTESTATIONS.every(({ field }) => attested[field]);

  const products = useLoad<Product[]>(async () => {
    const query = debouncedSearch.trim();
    if (!query) {
      const page = await api<Paginated<Product>>(
        '/catalog/products?take=100&status=ACTIVE',
      );
      return page.items;
    }
    const pages = await Promise.all(
      productSearchPaths(query).map((path) => api<Paginated<Product>>(path)),
    );
    return mergeProducts(pages);
  }, [debouncedSearch]);

  const report = useLoad<OneSkuBootstrapReport | null>(
    () =>
      selectedProductId
        ? api(oneSkuReportPath(selectedProductId))
        : Promise.resolve(null),
    [selectedProductId, reload],
  );

  // Store context is REQUIRED for bootstrap clips (Codex P1): without a
  // location the shadow journey cannot open and the clip can never be
  // corrected into the evaluation run.
  const stores = useLoad<Paginated<Store>>(() => api('/stores?take=100'), []);

  const selectedAsset = useLoad<VideoAsset | null>(
    () =>
      selectedAssetId
        ? api(`/video-assets/${selectedAssetId}`)
        : Promise.resolve(null),
    [selectedAssetId, reload],
  );

  const data = report.data ?? null;
  const selectedRow: OneSkuVideoRow | null =
    data?.videos.find((row) => row.videoAssetId === selectedAssetId) ?? null;
  const chips = data ? deriveStatusHeader(data) : null;
  const action = data ? nextBestAction(data) : null;
  const gates = data?.gates ?? null;
  const progress = gates ? gateProgress(gates.items) : null;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setActionErrorText(null);
    setNotice(null);
    try {
      await work();
      setReload((n) => n + 1);
    } catch (err) {
      setActionErrorText(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadReferences(files: FileList | null) {
    if (!files || files.length === 0 || !selectedProductId) {
      return;
    }
    let uploaded = 0;
    await run(async () => {
      try {
        for (const file of Array.from(files)) {
          const formData = new FormData();
          formData.append('file', file);
          await apiUpload(
            `/catalog/products/${selectedProductId}/reference-images`,
            formData,
          );
          uploaded += 1;
        }
        setNotice(`${uploaded} reference image(s) uploaded.`);
      } catch (err) {
        throw err instanceof ApiError && uploaded > 0
          ? new ApiError(err.status, `${err.message} (after ${uploaded} uploaded)`)
          : err;
      }
    });
  }

  async function reindex(rebuild: boolean) {
    await run(async () => {
      const result = await api<{ indexed: number; total: number }>(
        '/pickup-fusion/reference-index/reindex',
        { method: 'POST', body: { rebuild } },
      );
      setNotice(
        `${rebuild ? 'Rebuilt' : 'Re-indexed'}: ${result.indexed} vector(s), ` +
          `${result.total} image(s) total.`,
      );
    });
  }

  /** Attestations are declarations about ONE specific clip: whenever the
   *  selected file changes (before submit, after a failed upload, any
   *  time), every checkbox resets and must be re-confirmed (Codex P1). */
  function onFileSelectionChange() {
    setAttested({});
    setActionErrorText(null);
    setNotice(null);
  }

  async function uploadTestVideo(event: FormEvent) {
    event.preventDefault();
    const file = videoInput.current?.files?.[0];
    if (!file) {
      setActionErrorText('Choose a test video file first.');
      return;
    }
    if (!uploadLocationId) {
      setActionErrorText(
        'Select the store context first — a bootstrap clip without a store ' +
          'cannot be corrected or linked to the evaluation run.',
      );
      return;
    }
    if (!allAttested) {
      setActionErrorText(
        'Confirm all four operator attestations first — they are your ' +
          'declarations for THIS clip.',
      );
      return;
    }
    await run(async () => {
      const formData = new FormData();
      formData.append('file', file);
      const attestationHeaders: Record<string, string> = {};
      for (const { field, header } of UPLOAD_ATTESTATIONS) {
        formData.append(field, 'true');
        attestationHeaders[header] = 'true';
      }
      formData.append('locationId', uploadLocationId);
      const asset = await apiUpload<VideoAsset>(
        '/video-assets',
        formData,
        attestationHeaders,
      );
      setSelectedAssetId(asset.id);
      if (videoInput.current) {
        videoInput.current.value = '';
      }
      // Attestations are PER CLIP: every upload needs a fresh, explicit
      // confirmation (Codex P1) — clear them along with the file.
      setAttested({});
      setNotice(
        'Test video uploaded (quarantined). Complete the audited screening ' +
          'decision on the video page, then validate it here.',
      );
    });
  }

  async function validateAsset() {
    await run(async () => {
      await api(`/video-assets/${selectedAssetId}/validate`, {
        method: 'POST',
        body: {},
      });
      setNotice('Video validated — run the shadow analysis below.');
    });
  }

  async function runAnalysis() {
    await run(async () => {
      await api(`/video-assets/${selectedAssetId}/pickup-detection/run`, {
        method: 'POST',
        body: {},
      });
      await api(`/video-assets/${selectedAssetId}/fusion-run`, {
        method: 'POST',
        body: {},
      });
      setNotice(
        'Shadow analysis started (detection + fusion). Refresh in a few ' +
          'seconds to see results.',
      );
    });
  }

  async function ensureEvaluationRun() {
    await run(async () => {
      const result = await api<{ evaluationRunId: string; created: boolean }>(
        oneSkuEvaluationRunPath(selectedProductId),
        { method: 'POST', body: {} },
      );
      setNotice(
        result.created
          ? 'Bootstrap evaluation run created — corrections now feed it.'
          : 'Bootstrap evaluation run already linked.',
      );
    });
  }

  const assetStatus = selectedAsset.data?.status ?? null;
  const analysisReady =
    assetStatus === 'VALIDATED' ||
    assetStatus === 'PROCESSING' ||
    assetStatus === 'READY';
  const selectedProduct = data
    ? { id: data.product.id, sku: data.product.sku }
    : null;

  return (
    <Page
      title="One SKU bootstrap"
      error={report.error ?? products.error}
      loading={products.loading && !products.data}
    >
      <p className="muted">
        Guided shadow-mode workflow: prove out ONE real SKU end to end
        before scaling to 5+. Nothing here blocks the normal pages, and
        nothing writes checkout, order, payment, or inventory records.
      </p>
      {actionErrorText ? <div className="error">{actionErrorText}</div> : null}
      {notice ? <p className="muted">✓ {notice}</p> : null}

      <section style={stepCard}>
        <StepHeading n={1} title="Select SKU" />
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            type="search"
            placeholder="Search name, SKU, or barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: 'min(16rem, 100%)' }}
          />
          <select
            value={selectedProductId}
            onChange={(e) => {
              setSelectedProductId(e.target.value);
              setSelectedAssetId('');
              setAngles({});
              setManualCropOpen(false);
            }}
          >
            <option value="">— choose a SKU —</option>
            {(products.data ?? []).map((product) => (
              <option key={product.id} value={product.id}>
                {product.sku} — {product.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      {selectedProductId && data && selectedProduct ? (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.4rem',
              alignItems: 'center',
              margin: '0.5rem 0',
            }}
          >
            {(chips ?? []).map((chip) => (
              <span key={chip.key} className={`badge ${chip.tone}`} title={chip.detail}>
                {chip.label}: {chip.detail}
              </span>
            ))}
            {progress ? (
              <span className="muted">
                {progress.satisfied}/{progress.total} gates
              </span>
            ) : null}
          </div>
          {action ? (
            <p
              style={{
                ...stepCard,
                margin: '0.5rem 0',
                borderLeft: '4px solid var(--accent, #4c6ef5)',
              }}
            >
              <strong>Next:</strong> {action.label}
            </p>
          ) : null}

          <SopPanel />

          <section style={stepCard}>
            <StepHeading n={2} title="Reference readiness" />
            <p className="muted">
              {data.references.referenceCount}/{data.references.minRequired}{' '}
              images ({data.references.recommended}+ recommended) ·{' '}
              {data.references.embeddingCount} embedded ·{' '}
              {data.references.inferenceReady ? (
                <span className="badge ok">inference-ready</span>
              ) : (
                <span className="badge warn">below minimum</span>
              )}{' '}
              · manage in the <Link to="/reference-library">Reference library</Link>
            </p>
            <div className="toolbar" style={{ flexWrap: 'wrap' }}>
              {REFERENCE_ANGLES.map(({ key, label }) => (
                <label
                  key={key}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                >
                  <input
                    type="checkbox"
                    checked={angles[key] ?? false}
                    onChange={(e) =>
                      setAngles((current) => ({
                        ...current,
                        [key]: e.target.checked,
                      }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="toolbar" style={{ flexWrap: 'wrap' }}>
              <input
                type="file"
                accept="image/png,image/jpeg"
                multiple
                onChange={(e) => {
                  void uploadReferences(e.target.files);
                  e.target.value = '';
                }}
              />
              <button disabled={busy} onClick={() => void reindex(false)}>
                Re-index embeddings
              </button>
              <button disabled={busy} onClick={() => void reindex(true)}>
                Rebuild embeddings
              </button>
            </div>
          </section>

          <section style={stepCard}>
            <StepHeading n={3} title="Inventory readiness" />
            {data.inventory.stocked ? (
              <p>
                <span className="badge ok">stocked</span>{' '}
                {data.inventory.detailsVisible ? (
                  data.inventory.levels
                    .map((level) => `${level.locationName} (${level.locationCode}): ${level.quantity}`)
                    .join(' · ')
                ) : (
                  <span className="muted">
                    Inventory details hidden — inventory permission required.
                    The readiness check above still runs server-side, so the
                    bootstrap can continue.
                  </span>
                )}
              </p>
            ) : (
              <p>
                <span className="badge warn">not stocked</span>{' '}
                <span className="muted">
                  Add stock on the <Link to="/inventory">Inventory</Link> page so
                  fusion’s store check can validate the SKU (CV never mutates
                  inventory).
                </span>
              </p>
            )}
          </section>

          <section style={stepCard}>
            <StepHeading n={4} title="Upload test video" />
            <form
              className="toolbar"
              style={{ flexWrap: 'wrap' }}
              onSubmit={(e) => void uploadTestVideo(e)}
            >
              <input
                ref={videoInput}
                type="file"
                accept={ACCEPTED_EXTENSIONS}
                onChange={onFileSelectionChange}
              />
              <select
                value={uploadLocationId}
                onChange={(e) => setUploadLocationId(e.target.value)}
                title="REQUIRED: the store this clip was staged in — without it the clip cannot be corrected or linked to the evaluation run"
              >
                <option value="">— store context (required) —</option>
                {(stores.data?.items ?? []).map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name} ({store.code})
                    {data.inventory.levels.some(
                      (level) => level.locationId === store.id,
                    )
                      ? ' · stocked'
                      : ''}
                  </option>
                ))}
              </select>
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
                disabled={busy || !allAttested || !uploadLocationId}
              >
                {busy ? 'Working…' : 'Upload test video'}
              </button>
            </form>
            <p className="muted">
              Attestations are per clip — they reset after every upload AND
              whenever you pick a different file. Store context is required:
              without it the clip cannot become dataset evidence. Keep the
              product clearly visible BEFORE the pickup and fill the frame
              with the scene, not the table.
            </p>

            {data.videos.filter((row) => row.excludedReason === null).length >
            0 ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Video</th>
                      <th>Expected</th>
                      <th>Δ basket</th>
                      <th>Predicted</th>
                      <th>Match</th>
                      <th>Crop</th>
                      <th>Review</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.videos
                      .filter((row) => row.excludedReason === null)
                      .map((row) => (
                        <tr key={row.videoAssetId}>
                          <td>
                            <Link to={`/video-assets/${row.videoAssetId}`}>
                              {row.originalFilename}
                            </Link>
                          </td>
                          <td>
                            {row.eventKind}
                            {row.expectedSku ? ` · ${row.expectedSku}` : ''}
                          </td>
                          <td>{basketDeltaLabel(row.expectedBasketDelta)}</td>
                          <td>{row.predictedSku ?? '—'}</td>
                          <td>
                            {row.missedPositiveEvent ? (
                              <span className="badge down">missed event</span>
                            ) : row.predictionMatchesExpected === null ? (
                              <span className="muted">no run</span>
                            ) : row.predictionMatchesExpected ? (
                              <span className="badge ok">correct</span>
                            ) : (
                              <span className="badge down">incorrect</span>
                            )}
                          </td>
                          <td>
                            {row.fusion ? (
                              row.fusion.cropSource === 'OPERATOR' &&
                              !row.fusion.cropEvidenceConnected ? (
                                <span className="badge warn">
                                  manual crop not connected
                                </span>
                              ) : row.fusion.cropWarnings.length === 0 ? (
                                <span className="badge ok">clean</span>
                              ) : (
                                <span className="badge warn">
                                  {row.fusion.cropWarnings.length} warning(s)
                                </span>
                              )
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>
                            {row.reviewed ? (
                              <span className="badge ok">
                                reviewed
                                {row.bootstrapReviewVerdict
                                  ? ` (${row.bootstrapReviewVerdict})`
                                  : ''}
                              </span>
                            ) : row.staleReview ? (
                              <span className="badge warn">
                                needs fresh review
                              </span>
                            ) : row.bootstrapReviewVerdict &&
                              !row.bootstrapReviewEligible ? (
                              <span className="badge warn">
                                {row.bootstrapReviewVerdict} · not dataset-eligible
                              </span>
                            ) : (
                              <span className="badge warn">
                                {row.missedPositiveEvent
                                  ? 'needs correction'
                                  : 'needs review'}
                              </span>
                            )}
                          </td>
                          <td>
                            <button
                              disabled={busy}
                              onClick={() => {
                                setSelectedAssetId(row.videoAssetId);
                                setManualCropOpen(false);
                              }}
                            >
                              Open
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">
                No bootstrap-safe ground-truthed clips yet — upload one and
                set its ground truth below.
              </p>
            )}
            {data.counts.excludedClips > 0 ? (
              <details style={{ marginTop: '0.5rem' }}>
                <summary>
                  Excluded from bootstrap ({data.counts.excludedClips}) — these
                  never count toward or block readiness
                </summary>
                <table className="table">
                  <tbody>
                    {data.videos
                      .filter((row) => row.excludedReason !== null)
                      .map((row) => (
                        <tr key={row.videoAssetId}>
                          <td>
                            <Link to={`/video-assets/${row.videoAssetId}`}>
                              {row.originalFilename}
                            </Link>
                          </td>
                          <td>
                            <span className="badge down">
                              {row.excludedReason === 'SESSION_BOUND'
                                ? 'session-bound'
                                : 'no store context'}
                            </span>
                          </td>
                          <td className="muted">
                            {EXCLUDED_REASON_LABELS[row.excludedReason ?? ''] ??
                              ''}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </section>

          {selectedAssetId ? (
            <section style={stepCard}>
              <StepHeading n={5} title="Review crop quality" />
              {selectedAsset.data ? (
                <div className="toolbar" style={{ flexWrap: 'wrap' }}>
                  <span>
                    {selectedAsset.data.originalFilename} —{' '}
                    <span className="badge">{selectedAsset.data.status}</span>
                  </span>
                  {assetStatus === 'QUARANTINED' || assetStatus === 'PENDING_MEDIA' ? (
                    <Link to={`/video-assets/${selectedAssetId}`}>
                      Complete the audited screening decision on the video page →
                    </Link>
                  ) : null}
                  {assetStatus === 'UPLOADED' ? (
                    <button className="primary" disabled={busy} onClick={() => void validateAsset()}>
                      Validate video
                    </button>
                  ) : null}
                  {analysisReady ? (
                    <button className="primary" disabled={busy} onClick={() => void runAnalysis()}>
                      Run shadow analysis
                    </button>
                  ) : null}
                  <button disabled={busy} onClick={() => setReload((n) => n + 1)}>
                    Refresh
                  </button>
                </div>
              ) : null}
              {analysisReady ? (
                <BootstrapGroundTruthForm
                  assetId={selectedAssetId}
                  product={selectedProduct}
                  durationMs={selectedAsset.data?.durationMs ?? null}
                  onSaved={() => setReload((n) => n + 1)}
                />
              ) : (
                <p className="muted">
                  Ground truth, analysis, and corrections unlock once the clip
                  is screened and validated.
                </p>
              )}
              {selectedRow ? (
                <CropQualityCard
                  row={selectedRow}
                  onManualCrop={() => setManualCropOpen(true)}
                />
              ) : null}
              {manualCropOpen && analysisReady ? (
                <ManualCropTool
                  assetId={selectedAssetId}
                  durationMs={selectedAsset.data?.durationMs ?? null}
                  onCropCreated={() => setReload((n) => n + 1)}
                />
              ) : null}
            </section>
          ) : null}

          {selectedRow && selectedRow.excludedReason === null ? (
            <section style={stepCard}>
              <StepHeading n={6} title="Correct / approve eligible evidence" />
              <CorrectionPanel
                row={selectedRow}
                productId={selectedProductId}
                products={products.data ?? []}
                onRecorded={(message) => {
                  setNotice(message);
                  setReload((n) => n + 1);
                }}
              />
            </section>
          ) : selectedRow?.excludedReason ? (
            <section style={stepCard}>
              <StepHeading n={6} title="Correct / approve eligible evidence" />
              <p>
                <span className="badge down">excluded from bootstrap</span>{' '}
                <span className="muted">
                  {EXCLUDED_REASON_LABELS[selectedRow.excludedReason] ?? ''}
                </span>
              </p>
            </section>
          ) : null}

          <section style={stepCard}>
            <StepHeading n={7} title="Send to dataset improvement" />
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <tbody>
                  {(gates?.items ?? []).map((item) => (
                    <tr key={item.key}>
                      <td>
                        {item.satisfied ? (
                          <span className="badge ok">✓</span>
                        ) : (
                          <span className={item.required ? 'badge down' : 'badge warn'}>
                            ✗
                          </span>
                        )}
                      </td>
                      <td>
                        {item.label}
                        {!item.required ? (
                          <span className="muted"> (recommended)</span>
                        ) : null}
                      </td>
                      <td className="muted">{item.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="toolbar" style={{ flexWrap: 'wrap' }}>
              {data.linkedEvaluationRun ? (
                <span>
                  Linked run: <strong>{data.linkedEvaluationRun.name}</strong>{' '}
                  <span className="badge">{data.linkedEvaluationRun.status}</span>{' '}
                  <span className="muted">
                    {data.linkedEvaluationRun.reviewCount} review(s)
                  </span>
                </span>
              ) : (
                <button disabled={busy} onClick={() => void ensureEvaluationRun()}>
                  Create bootstrap evaluation run
                </button>
              )}
              {data.linkedEvaluationRun ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    navigate(
                      `/cv-dataset-improvement?sourceEvaluationRunId=${encodeURIComponent(
                        data.linkedEvaluationRun?.evaluationRunId ?? '',
                      )}`,
                    )
                  }
                >
                  Send reviewed examples to Dataset Improvement →
                </button>
              ) : null}
            </div>
            {gates?.readyForDatasetImprovement ? (
              <p>
                <span className="badge ok">Ready for dataset improvement</span>{' '}
                — create a run sourced from the linked evaluation run and
                refresh its candidates there.
              </p>
            ) : null}
            <dl className="detail">
              <dt>Latest top prediction</dt>
              <dd>
                {data.latest
                  ? `${data.latest.predictedSku ?? 'UNKNOWN'} ` +
                    `(${data.latest.topScore !== null ? Math.round(data.latest.topScore * 100) : '—'}% · ` +
                    `${data.latest.policy})`
                  : '— no fusion run yet'}
              </dd>
              <dt>Latest VLM verdict</dt>
              <dd>
                {data.latest?.vlmVerdict ??
                  (data.latest?.vlmStatus ? data.latest.vlmStatus : '— not invoked')}
              </dd>
              <dt>Common failure reasons</dt>
              <dd>
                {data.failureReasons.length === 0
                  ? '— none observed'
                  : data.failureReasons
                      .map(
                        (entry) =>
                          `${FAILURE_REASON_LABELS[entry.reason] ?? entry.reason} ×${entry.count}`,
                      )
                      .join(' · ')}
              </dd>
            </dl>
            <p className="muted">{data.scoreNote}</p>
          </section>
        </>
      ) : selectedProductId && report.loading ? (
        <p className="muted">Loading readiness…</p>
      ) : null}
    </Page>
  );
}
