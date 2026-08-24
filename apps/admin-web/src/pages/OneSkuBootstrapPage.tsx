import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  OneSkuBootstrapReport,
  OneSkuVideoRow,
  Paginated,
  Product,
  ReferenceLibraryStatus,
  VideoArtifact,
  VideoAsset,
  api,
  apiObjectUrl,
  apiUpload,
} from '../api';
import { Page, useDebounced, useLoad } from '../components';
import {
  CROP_WARNING_LABELS,
  FAILURE_REASON_LABELS,
  MANUAL_CROP_REASONS,
  ManualCropDraft,
  ManualCropFieldErrors,
  REFERENCE_ANGLES,
  basketDeltaLabel,
  gateProgress,
  oneSkuReportPath,
  overlayRectStyle,
  validateManualCrop,
} from '../one-sku-bootstrap-utils';
import { FusionEvidencePanel } from './FusionEvidencePanel';
import { PickupDetectionPanel } from './PickupDetectionPanel';
import { mergeProducts, productSearchPaths } from './ReferenceLibraryPage';
import { ACCEPTED_EXTENSIONS, UPLOAD_ATTESTATIONS } from './VideoAssetsPage';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

const fieldErrorStyle = { color: '#c0392b', fontSize: '0.85em' };
const border = '1px solid var(--border, #d8d8e0)';

function WarningBadges({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return <span className="badge ok">clean crop</span>;
  }
  return (
    <>
      {warnings.map((warning) => (
        <span
          key={warning}
          className="badge warn"
          title={CROP_WARNING_LABELS[warning] ?? warning}
          style={{ marginRight: '0.25rem' }}
        >
          {warning}
        </span>
      ))}
    </>
  );
}

/**
 * Manual crop tool: extract ONE frame at a timestamp, preview it with the
 * crop rectangle overlaid, then create the crop through the existing
 * strict endpoint (closed reason enum + integers only — no field exists
 * for free text, paths, or URLs). SKU labeling comes from the clip's
 * ground truth, never from the crop itself.
 */
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState<VideoArtifact | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(() => crypto.randomUUID());
  const [cropKey, setCropKey] = useState(() => crypto.randomUUID());

  // Authenticated blob for the extracted frame preview.
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
    setActionError(null);
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
        setActionError('Frame extracted but not found in artifacts yet — retry.');
        return;
      }
      setFrame(extracted);
      setFrameKey(crypto.randomUUID());
      setNotice(`Frame extracted at ${extracted.timestampMs} ms.`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createCrop(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
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
        'Crop created as operator-reviewed evidence. Its SKU label comes ' +
          'from this clip’s ground truth.',
      );
      onCropCreated?.();
    } catch (err) {
      setActionError(errorMessage(err));
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
    <section style={{ marginTop: '1rem' }}>
      <h3>Manual crop (when the automatic crop is bad)</h3>
      <p className="muted">
        Pick the instant the product is clearly visible, extract that frame,
        then enter the crop box in native pixels — the rectangle previews on
        the frame so you can adjust before saving. Coordinates only; no
        free-text, file paths, or source references are stored.
      </p>
      {actionError ? <div className="error">{actionError}</div> : null}
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
            maxWidth: '32rem',
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
    </section>
  );
}

export function OneSkuBootstrapPage() {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [angles, setAngles] = useState<Record<string, boolean>>({});

  // Test-video upload state (same attestation contract as /video-assets).
  const videoInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
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

  const refStatus = useLoad<ReferenceLibraryStatus | null>(
    () =>
      selectedProductId
        ? api(`/catalog/products/${selectedProductId}/reference-images`)
        : Promise.resolve(null),
    [selectedProductId, reload],
  );

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

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
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

  async function uploadTestVideo(event: FormEvent) {
    event.preventDefault();
    const file = videoInput.current?.files?.[0];
    if (!file) {
      setActionError('Choose a test video file first.');
      return;
    }
    if (!allAttested) {
      setActionError(
        'Confirm all four operator attestations first — they are your ' +
          'declarations that this is controlled internal test media.',
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
      if (uploadLocationId) {
        formData.append('locationId', uploadLocationId);
      }
      const asset = await apiUpload<VideoAsset>(
        '/video-assets',
        formData,
        attestationHeaders,
      );
      setSelectedAssetId(asset.id);
      if (videoInput.current) {
        videoInput.current.value = '';
      }
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
      setNotice('Video validated — detection and fusion can run now.');
    });
  }

  const gates = data?.gates ?? null;
  const progress = gates ? gateProgress(gates.items) : null;
  const assetStatus = selectedAsset.data?.status ?? null;
  const panelsReady =
    assetStatus === 'VALIDATED' ||
    assetStatus === 'PROCESSING' ||
    assetStatus === 'READY';

  return (
    <Page
      title="One SKU bootstrap"
      error={report.error ?? products.error}
      loading={products.loading && !products.data}
    >
      <p className="muted">
        Guided shadow-mode workflow: prove out ONE real SKU end to end —
        references, embeddings, inventory, a clean test clip, ground truth,
        review — before scaling to 5+ SKUs. Nothing here blocks the normal
        pages, and nothing writes checkout, order, payment, or inventory
        records.
      </p>
      {actionError ? <div className="error">{actionError}</div> : null}
      {notice ? <p className="muted">✓ {notice}</p> : null}

      <h2>1 · Pick the SKU under test</h2>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search name, SKU, or barcode…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: '16rem' }}
        />
        <select
          value={selectedProductId}
          onChange={(e) => {
            setSelectedProductId(e.target.value);
            setSelectedAssetId('');
            setAngles({});
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

      {selectedProductId && data ? (
        <>
          <h2>
            2 · Readiness — {data.product.sku}{' '}
            {gates?.readyForDatasetImprovement ? (
              <span className="badge ok">READY FOR DATASET IMPROVEMENT</span>
            ) : (
              <span className="badge warn">
                {progress ? `${progress.satisfied}/${progress.total} gates` : '…'}
              </span>
            )}
          </h2>
          <div className="cards">
            <div className="card">
              <div className="value">
                {data.references.referenceCount}/{data.references.minRequired}
              </div>
              <div className="label">
                reference images{' '}
                {data.references.inferenceReady ? '(inference-ready)' : ''}
              </div>
            </div>
            <div className="card">
              <div className="value">{data.references.embeddingCount}</div>
              <div className="label">
                embeddings ({data.references.embeddingModelKey}@
                {data.references.embeddingModelVersion})
              </div>
            </div>
            <div className="card">
              <div className="value">{data.inventory.totalOnHand}</div>
              <div className="label">
                on hand{' '}
                {data.inventory.levels
                  .map((level) => `${level.locationCode}: ${level.quantity}`)
                  .join(' · ') || '(not stocked)'}
              </div>
            </div>
            <div className="card">
              <div className="value">{data.counts.totalClips}</div>
              <div className="label">ground-truthed test clips</div>
            </div>
            <div className="card">
              <div className="value">
                {data.counts.reviewedPickupExamples}/
                {data.counts.reviewedReturnExamples}/
                {data.counts.reviewedFalseTouchExamples}
              </div>
              <div className="label">
                reviewed pickup / return / false-touch examples
              </div>
            </div>
          </div>

          <h2>3 · Reference images</h2>
          <p className="muted">
            Capture the checklist below with the REAL product (tick as you
            go — guidance only, images are not angle-labeled). Upload at
            least {data.references.minRequired}; {data.references.recommended}
            + recommended. Then rebuild embeddings so retrieval actually uses
            them. Manage or delete images in the{' '}
            <Link to="/reference-library">Reference library</Link>.
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
          <div className="toolbar">
            <input
              ref={referenceInput}
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
            {refStatus.data ? (
              <span className="muted">
                {refStatus.data.referenceCount} image(s),{' '}
                {refStatus.data.embeddingCount} embedded
              </span>
            ) : null}
          </div>

          <h2>4 · Test clips for this SKU</h2>
          {data.videos.length === 0 ? (
            <p className="muted">
              No ground-truthed clips yet — upload one below, then set its
              ground truth to {data.product.sku}.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Video</th>
                  <th>Expected</th>
                  <th>Δ basket</th>
                  <th>Predicted</th>
                  <th>Match</th>
                  <th>Crop quality</th>
                  <th>Review</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.videos.map((row) => (
                  <tr key={row.videoAssetId}>
                    <td>
                      <Link to={`/video-assets/${row.videoAssetId}`}>
                        {row.originalFilename}
                      </Link>
                    </td>
                    <td>
                      {row.eventKind}
                      {row.expectedSku ? ` · ${row.expectedSku}` : ''}
                      {row.testType ? (
                        <span className="muted"> ({row.testType})</span>
                      ) : null}
                    </td>
                    <td>{basketDeltaLabel(row.expectedBasketDelta)}</td>
                    <td>{row.predictedSku ?? '—'}</td>
                    <td>
                      {row.predictionMatchesExpected === null ? (
                        <span className="muted">no run</span>
                      ) : row.predictionMatchesExpected ? (
                        <span className="badge ok">correct</span>
                      ) : (
                        <span className="badge down">incorrect</span>
                      )}
                    </td>
                    <td>
                      {row.fusion ? (
                        <WarningBadges warnings={row.fusion.cropWarnings} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {row.reviewed ? (
                        <span className="badge ok">
                          reviewed{row.reviewDecision ? ` (${row.reviewDecision})` : ''}
                        </span>
                      ) : row.needsReview ? (
                        <span className="badge warn">needs review</span>
                      ) : (
                        <span className="badge warn">pending</span>
                      )}
                    </td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() => setSelectedAssetId(row.videoAssetId)}
                      >
                        Work on this clip
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>5 · Upload a new test video</h2>
          <form className="toolbar" style={{ flexWrap: 'wrap' }} onSubmit={(e) => void uploadTestVideo(e)}>
            <input ref={videoInput} type="file" accept={ACCEPTED_EXTENSIONS} />
            <select
              value={uploadLocationId}
              onChange={(e) => setUploadLocationId(e.target.value)}
              title="Store context so fusion can validate the SKU is stocked"
            >
              <option value="">— store context (recommended) —</option>
              {data.inventory.levels.map((level) => (
                <option key={level.locationId} value={level.locationId}>
                  {level.locationName} ({level.locationCode})
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
            <button className="primary" type="submit" disabled={busy || !allAttested}>
              {busy ? 'Working…' : 'Upload test video'}
            </button>
          </form>
          <p className="muted">
            Record the product clearly visible BEFORE the pickup, keep the
            hand off the label at the pickup instant, and fill most of the
            frame with the scene — the pipeline's crop should not end up
            mostly table or background.
          </p>

          {selectedAssetId ? (
            <>
              <h2>6 · Selected clip workflow</h2>
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
                  <button disabled={busy} onClick={() => setReload((n) => n + 1)}>
                    Refresh
                  </button>
                </div>
              ) : null}
              {selectedRow?.fusion ? (
                <p>
                  Latest crop quality:{' '}
                  <WarningBadges warnings={selectedRow.fusion.cropWarnings} />
                  {selectedRow.fusion.selectedCrop ? (
                    <span className="muted">
                      {' '}
                      sharpness{' '}
                      {selectedRow.fusion.selectedCrop.sharpness.toFixed(1)},
                      occlusion{' '}
                      {Math.round(selectedRow.fusion.selectedCrop.occlusion * 100)}
                      %, box {selectedRow.fusion.selectedCrop.box.width}×
                      {selectedRow.fusion.selectedCrop.box.height}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {panelsReady ? (
                <>
                  <PickupDetectionPanel
                    assetId={selectedAssetId}
                    durationMs={selectedAsset.data?.durationMs ?? null}
                    defaultProductId={selectedProductId}
                    onGroundTruthSaved={() => setReload((n) => n + 1)}
                  />
                  <FusionEvidencePanel assetId={selectedAssetId} refreshKey={reload} />
                  <ManualCropTool
                    assetId={selectedAssetId}
                    durationMs={selectedAsset.data?.durationMs ?? null}
                    onCropCreated={() => setReload((n) => n + 1)}
                  />
                </>
              ) : (
                <p className="muted">
                  Detection, fusion, ground truth, and manual crops unlock
                  once the clip is screened and validated.
                </p>
              )}
            </>
          ) : null}

          <h2>7 · Quality gates</h2>
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
          {gates?.readyForDatasetImprovement ? (
            <p>
              <span className="badge ok">Ready for dataset improvement</span>{' '}
              — create a run on the{' '}
              <Link to="/cv-dataset-improvement">Dataset improvement</Link>{' '}
              page (corrections flow through the existing reviewed pilot
              evaluation records).
            </p>
          ) : null}

          <h2>8 · One-SKU report</h2>
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
        </>
      ) : selectedProductId && report.loading ? (
        <p className="muted">Loading readiness…</p>
      ) : null}
    </Page>
  );
}
