import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  apiUpload,
  ClipLabReport,
  GroundTruthEventKind,
  Paginated,
  PlanogramRackView,
  Product,
  ScreeningPreview,
  Store,
  Unit,
  VideoAsset,
} from '../api';
import { frameCoverageLabel, marginLabel, percentLabel } from '../clip-lab-utils';
import { Page, useLoad } from '../components';
import { UPLOAD_ATTESTATIONS } from './VideoAssetsPage';

/**
 * Phase 22 — Clip Lab: ONE place to test a clip. Upload with the store
 * and rack bound up front (mandatory fields marked *), approve the
 * quarantine screening on real frames, run the whole shadow analysis
 * with one click, and read one consolidated, review-required result.
 * Nothing here touches checkout, orders, inventory, or payments.
 */

const STEP_LABELS: Record<string, string> = {
  SCREENING: 'Screened',
  VALIDATE: 'Validated',
  DETECTION: 'Detection',
  FUSION: 'Fusion',
  PRETRAINED: 'Pretrained',
};

const STEP_BADGE: Record<string, string> = {
  OK: 'ok',
  SKIPPED: '',
  NOT_RUN: '',
  FAILED: 'warn',
  BLOCKED: 'warn',
};

const MATCH_LABELS: Record<string, string> = {
  MATCH: 'Expected in this cell',
  ADJACENT_MATCH: 'Found in neighboring cell',
  RACK_MATCH: 'Expected on this rack',
  OUT_OF_PLANOGRAM: 'Possible misplaced product',
  UNKNOWN_CELL: 'Cell mapping uncertain',
  PLANOGRAM_NOT_CONFIGURED: 'Planogram not configured',
};

const COORDINATE_SOURCE_LABELS: Record<string, string> = {
  OPERATOR: 'operator supplied',
  DETECTOR: 'from detector',
  NONE: 'no coordinates',
};

const BINDING_SOURCE_LABELS: Record<string, string> = {
  REQUEST: 'from this request',
  ASSET: 'bound at upload',
  NONE: 'no rack bound',
};

/** Operator-friendly labels for the classified codes the report carries. */
export const WHY_LABELS: Record<string, string> = {
  PRODUCT_DETECTED: 'Product detected',
  HAND_COVERED_PRODUCT: 'Hand covered product',
  CROP_IMPROVED: 'Crop improved',
  SKU_CANDIDATE_CHANGED: 'SKU candidate changed',
  DETECTION_COVERAGE_IMPROVED: 'Detector covered more frames than classical',
  HAND_CONTACT_OBSERVED: 'Hand contact observed by detector',
  PRETRAINED_GATE_NOT_APPROVED: 'Pretrained output is advisory until gates are approved',
  STILL_NEEDS_REVIEW: 'Still needs review',
  NO_IMPROVEMENT_OVER_CLASSICAL: 'No improvement over classical fallback',
  DETECTOR_CLASSICAL_ACTION_DISAGREEMENT: 'Detector and classical disagree on the action',
  ACTION_UNRESOLVED: 'Action could not be resolved',
  PRODUCT_COUNT_DECREASED: 'Product count decreased on shelf',
  PRODUCT_COUNT_INCREASED: 'Product count increased on shelf',
  EVENT_PRODUCT_LOCALIZED: 'Event product localized',
  PRODUCT_TRACK_LOST: 'A tracked product vanished from its position',
  PRODUCT_TRACK_APPEARED: 'A product appeared at a new position',
  PRODUCT_RELOCATED: 'A product was moved on the shelf (no take)',
  PERSON_PRESENCE_CONTACT_PROXY: 'Person presence used as contact proxy (model cannot see hands)',
  DETECTOR_ONLY_EVENT: 'Event proposed by detector only (classical found none)',
  EVENT_OUTSIDE_RACK_REGION: 'Event outside the rack region',
  HAND_ROLE_UNSUPPORTED_BY_MODEL: 'Model cannot see hands',
  PERSON_DETECTED: 'Person detected',
  LOCAL_DETECTOR_OUTPUT: 'Real local inference',
  PLANOGRAM_SCOPED_CANDIDATES: 'Candidates scoped to the bound planogram',
  SCREENING_SCREENING_APPROVAL_REQUIRED: 'Screening approval required before analysis',
  DETECTION_NO_MOTION_EVENT: 'Classical v1 found no motion event (fusion v2 fallback used)',
  DETECTION_MISSING_UNIT_BINDING: 'Classical detection skipped — no unit bound to this clip',
  DETECTION_MISSING_LOCATION_CONTEXT: 'Classical detection needs a store and a unit bound to the clip',
};

const DETECTION_STATUS_LABELS: Record<string, string> = {
  OK: 'classical event found',
  FAILED: 'classical detection failed',
  SKIPPED: 'skipped (no unit bound)',
  NOT_RUN: 'not run yet',
};

const VLM_VERDICT_LABELS: Record<string, string> = {
  MATCH: 'match',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
  AMBIGUOUS: 'ambiguous',
};

const VLM_SUPPORT_LABELS: Record<string, string> = {
  STRONG: 'strong visual support',
  WEAK: 'weak visual support',
  NONE: 'no visual support',
  CONTRADICTS: 'visual evidence contradicts',
};

/** Units of one store — "GET /units?locationId=…" (paginated). */
function useStoreUnits(locationId: string) {
  return useLoad<Paginated<Unit>>(
    () =>
      locationId
        ? api(`/units?locationId=${encodeURIComponent(locationId)}&take=100`)
        : Promise.resolve({ items: [], total: 0, skip: 0, take: 0 } as Paginated<Unit>),
    [locationId],
  );
}

function labelFor(code: string, labels: Record<string, string>): string {
  return labels[code] ?? code;
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Request failed';
}

function parseRegion(values: { rx: string; ry: string; rw: string; rh: string }) {
  const all = [values.rx, values.ry, values.rw, values.rh].map((v) => v.trim());
  if (all.every((v) => v === '')) {
    return { region: null, error: null };
  }
  if (all.some((v) => v === '')) {
    return { region: null, error: 'Rack region needs all four values (or leave all blank).' };
  }
  const [x, y, width, height] = all.map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    return { region: null, error: 'Rack region values must be numbers between 0 and 1.' };
  }
  if (width < 0.01 || height < 0.01 || x + width > 1.0005 || y + height > 1.0005) {
    return { region: null, error: 'Rack region must be a rectangle inside the frame.' };
  }
  return { region: { x, y, width, height }, error: null };
}

// ------------------------------------------------------------ upload

function UploadSection({ onUploaded }: { onUploaded: (asset: VideoAsset) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [rackCode, setRackCode] = useState('');
  const [region, setRegion] = useState({ rx: '', ry: '', rw: '', rh: '' });
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stores = useLoad<Paginated<Store>>(() => api('/stores?take=100'), []);
  const racks = useLoad<{ racks: PlanogramRackView[] } | PlanogramRackView[]>(
    () =>
      locationId
        ? api(`/planograms/racks?locationId=${encodeURIComponent(locationId)}`)
        : Promise.resolve([]),
    [locationId],
  );
  const rackList: PlanogramRackView[] = Array.isArray(racks.data)
    ? racks.data
    : (racks.data?.racks ?? []);
  const units = useStoreUnits(locationId);
  const unitList = units.data?.items ?? [];
  const allAttested = UPLOAD_ATTESTATIONS.every(({ field }) => attested[field]);
  const regionParsed = parseRegion(region);
  const ready = Boolean(
    fileName && locationId && unitId && rackCode && allAttested && !regionParsed.error,
  );

  useEffect(() => {
    setRackCode('');
    setUnitId('');
  }, [locationId]);

  // A store with exactly one unit needs no choice — pre-select it.
  useEffect(() => {
    if (!unitId && unitList.length === 1) {
      setUnitId(unitList[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitList.length]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file || !ready) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const headers: Record<string, string> = {};
      for (const { field, header } of UPLOAD_ATTESTATIONS) {
        formData.append(field, 'true');
        headers[header] = 'true';
      }
      formData.append('locationId', locationId);
      formData.append('unitId', unitId);
      formData.append('planogramRackCode', rackCode);
      if (regionParsed.region) {
        formData.append('rackFrameRegion', JSON.stringify(regionParsed.region));
      }
      const asset = await apiUpload<VideoAsset>('/video-assets', formData, headers);
      onUploaded(asset);
      setFileName('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="detail">
      <h3>1. Upload a clip</h3>
      <p className="muted">
        Fields marked * are required. The store and rack are bound to the clip so every later
        stage scopes its SKU candidates to that planogram.
      </p>
      <form onSubmit={submit}>
        <div className="toolbar">
          <label>
            Clip file *{' '}
            <input
              ref={fileInput}
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')}
            />
          </label>
          <label>
            Store *{' '}
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">— store —</option>
              {(stores.data?.items ?? []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name} ({store.code})
                </option>
              ))}
            </select>
          </label>
          <label>
            Unit *{' '}
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={!locationId}>
              <option value="">{locationId ? '— unit —' : 'pick a store first'}</option>
              {unitList.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name} ({unit.code})
                </option>
              ))}
            </select>
          </label>
          <label>
            Rack *{' '}
            <select
              value={rackCode}
              onChange={(e) => setRackCode(e.target.value)}
              disabled={!locationId}
            >
              <option value="">{locationId ? '— rack —' : 'pick a store first'}</option>
              {rackList.map((rack) => (
                <option key={rack.rackId} value={rack.rackCode}>
                  {rack.rackCode} · {rack.rows}×{rack.columns} v{rack.version}
                </option>
              ))}
            </select>
          </label>
        </div>
        {locationId && !racks.loading && rackList.length === 0 ? (
          <p className="error">
            No ACTIVE planogram rack at this store. Publish one on the{' '}
            <Link to="/pretrained-vision">Pretrained vision</Link> page first.
          </p>
        ) : null}
        {locationId && !units.loading && unitList.length === 0 ? (
          <p className="error">
            This store has no retail unit. Add one on the <Link to="/units">Units</Link> page —
            classical detection records its pickup event on a unit.
          </p>
        ) : null}
        <div className="toolbar">
          <span className="muted">Rack region in frame (optional — leave blank if the rack fills the frame)</span>
          {(['rx', 'ry', 'rw', 'rh'] as const).map((key) => (
            <input
              key={key}
              placeholder={key}
              style={{ width: '4.5em' }}
              value={region[key]}
              onChange={(e) => setRegion({ ...region, [key]: e.target.value })}
            />
          ))}
        </div>
        {regionParsed.error ? <p className="error">{regionParsed.error}</p> : null}
        <div>
          <p className="muted">Operator attestations * (declarations recorded with the clip)</p>
          {UPLOAD_ATTESTATIONS.map(({ field, label, title }) => (
            <label key={field} title={title} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={Boolean(attested[field])}
                onChange={(e) => setAttested({ ...attested, [field]: e.target.checked })}
              />{' '}
              {label}
            </label>
          ))}
        </div>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" type="submit" disabled={busy || !ready}>
          {busy ? 'Uploading…' : 'Upload clip'}
        </button>
        {!ready && !busy ? (
          <span className="muted"> Complete every * field to enable upload.</span>
        ) : null}
      </form>
    </section>
  );
}

// ---------------------------------------------------------- screening

function ScreeningSection({ asset, onChanged }: { asset: VideoAsset; onChanged: () => void }) {
  const [preview, setPreview] = useState<ScreeningPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (asset.status !== 'QUARANTINED') {
    return null;
  }
  async function loadPreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(
        await api<ScreeningPreview>(`/video-assets/${asset.id}/screening-preview`, {
          method: 'POST',
          body: {},
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: 'APPROVE' | 'REJECT') {
    setBusy(true);
    setError(null);
    try {
      await api(`/video-assets/${asset.id}/screening`, { method: 'POST', body: { decision } });
      setPreview(null);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="detail">
      <h3>2. Approve screening *</h3>
      <p className="muted">
        The clip is quarantined until you inspect real frames and approve it. Analysis cannot run
        before this human decision.
      </p>
      <div className="toolbar">
        <button type="button" onClick={() => void loadPreview()} disabled={busy}>
          Show frames
        </button>
        <button
          className="primary"
          type="button"
          onClick={() => void decide('APPROVE')}
          disabled={busy || !preview || preview.frames.length === 0}
        >
          Approve
        </button>
        <button type="button" onClick={() => void decide('REJECT')} disabled={busy}>
          Reject
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {preview ? (
        <div className="toolbar">
          {preview.frames.map((frame) => (
            <img
              key={frame.timestampMs}
              alt={`frame at ${frame.timestampMs} ms`}
              width={160}
              src={`data:${frame.mimeType};base64,${frame.imageBase64}`}
            />
          ))}
          {preview.frames.length === 0 ? <span className="muted">No frames decoded.</span> : null}
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------- result

function ResultSection({ report }: { report: ClipLabReport }) {
  const suggestion = report.suggestion;
  const planogram = report.planogram;
  return (
    <section className="detail">
      <h3>4. Result</h3>
      <div className="toolbar">
        {report.steps.map((step) => (
          <span
            key={step.step}
            className={`badge ${STEP_BADGE[step.status] ?? ''}`}
            title={step.reasonCode ?? ''}
          >
            {labelFor(step.step, STEP_LABELS)} · {step.status}
            {step.reasonCode ? ` (${step.reasonCode})` : ''}
          </span>
        ))}
      </div>
      <dl>
        <dt>Suggestion (advisory)</dt>
        <dd>
          {suggestion ? (
            <>
              {suggestion.sku ?? 'UNKNOWN'} · {suggestion.action}{' '}
              <span className="badge warn">Still needs review</span>
            </>
          ) : (
            <span className="muted">— not available yet</span>
          )}
        </dd>
        <dt>Planogram cell</dt>
        <dd>
          {planogram && planogram.configured ? (
            <>
              {planogram.rackCode} · {planogram.cell ?? 'no cell'} (
              {labelFor(planogram.coordinateSource, COORDINATE_SOURCE_LABELS)},{' '}
              {labelFor(planogram.bindingSource, BINDING_SOURCE_LABELS)}) ·{' '}
              {labelFor(planogram.matchStatus, MATCH_LABELS)}
              {planogram.expectedSkus.length ? ` · expected ${planogram.expectedSkus.join(', ')}` : ''}
            </>
          ) : (
            <span className="muted">Planogram not configured for this clip</span>
          )}
        </dd>
        <dt>Top candidates</dt>
        <dd>
          {report.candidates.scoped ? (
            <span className="badge ok">scoped to planogram</span>
          ) : (
            <span className="badge warn">full catalog</span>
          )}{' '}
          {report.candidates.items.length === 0 ? (
            <span className="muted">— none</span>
          ) : (
            report.candidates.items
              .map((row) => `${row.sku} (${row.score.toFixed(3)})`)
              .join(' · ')
          )}
          {report.candidates.excludedProductCount > 0
            ? ` · ${report.candidates.excludedProductCount} product(s) excluded by the planogram`
            : ''}
        </dd>
        <dt>Ground truth</dt>
        <dd>
          {report.asset.groundTruth
            ? `${report.asset.groundTruth.eventKind} · ${report.asset.groundTruth.sku ?? '—'}`
            : 'not saved yet'}
        </dd>
        <dt>Why</dt>
        <dd>
          <ul>
            {report.why.map((code) => (
              <li key={code}>{labelFor(code, WHY_LABELS)}</li>
            ))}
          </ul>
        </dd>
        <dt>Providers</dt>
        <dd>
          {report.providers.map((provider) => (
            <span key={provider.provider} className="badge" title={provider.reasonCode ?? ''}>
              {provider.provider} · {provider.availability}
              {provider.modelId ? ` · model ${provider.modelId}` : ''}
            </span>
          ))}
        </dd>
      </dl>
      <ConfidenceSummary report={report} />
      <p className="muted">
        Details: <Link to={report.links.videoAssetPage}>clip page</Link> ·{' '}
        <Link to={report.links.pretrainedPage}>pretrained vision</Link>
      </p>
    </section>
  );
}

/**
 * Confidence summary — one row per stage, each stage's own 0..1 signal
 * shown as a percentage for readability. Percentages come ONLY from the
 * pure helper (never inline arithmetic here); they are uncalibrated
 * ranking signals and the footnote says so. Overall is the review gate.
 */
function ConfidenceSummary({ report }: { report: ClipLabReport }) {
  const c = report.confidence;
  const detectionStep = report.steps.find((step) => step.step === 'DETECTION');
  const detectionNote = detectionStep?.reasonCode
    ? labelFor(`DETECTION_${detectionStep.reasonCode}`, WHY_LABELS)
    : labelFor(c.detection.status, DETECTION_STATUS_LABELS);
  const vlmText = c.vlm
    ? [
        c.vlm.verdict ? labelFor(c.vlm.verdict, VLM_VERDICT_LABELS) : null,
        c.vlm.sku ? `→ ${c.vlm.sku}` : null,
        c.vlm.support ? labelFor(c.vlm.support, VLM_SUPPORT_LABELS) : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  const rows: { signal: string; confidence: string; note: string | JSX.Element }[] = [
    {
      signal: 'Classical detection',
      confidence: percentLabel(c.detection.score),
      note: detectionNote,
    },
    {
      signal: c.detector.provider ? `Local detector (${c.detector.provider})` : 'Local detector',
      confidence: percentLabel(c.detector.topDetection),
      note: frameCoverageLabel(c.detector.productFrames, c.detector.sampledFrames),
    },
    {
      signal: 'Fused top candidate',
      confidence: percentLabel(c.fusionTop?.score ?? null),
      note: c.fusionTop ? `${c.fusionTop.sku} · margin ${marginLabel(c.fusionTop.margin)}` : '—',
    },
    {
      signal: 'Planogram cell',
      confidence: percentLabel(c.planogramCell?.confidence ?? null),
      note: c.planogramCell
        ? `${c.planogramCell.cell} · ${labelFor(report.planogram?.matchStatus ?? '', MATCH_LABELS)}`
        : '—',
    },
    {
      signal: 'VLM verifier',
      confidence: '—',
      note: vlmText || (c.vlm?.status ? c.vlm.status : 'not invoked'),
    },
    {
      signal: 'Overall',
      confidence: '—',
      note: <span className="badge warn">Still needs review</span>,
    },
  ];
  return (
    <div className="confidence-summary">
      <h4>Confidence summary</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Signal</th>
              <th className="num">Confidence</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.signal}>
                <td>{row.signal}</td>
                <td className="num">{row.confidence}</td>
                <td>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Percentages are uncalibrated ranking signals until calibration lands; they are{' '}
        <strong>not probabilities</strong>.
      </p>
    </div>
  );
}

// ------------------------------------------------------------- page

export function ClipLabPage() {
  const [selectedId, setSelectedId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<ClipLabReport | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [truthKind, setTruthKind] = useState<GroundTruthEventKind>('PICKUP');
  const [truthProduct, setTruthProduct] = useState('');
  const [truthMs, setTruthMs] = useState('');
  const [truthNotice, setTruthNotice] = useState<string | null>(null);
  const assets = useLoad<Paginated<VideoAsset>>(() => api('/video-assets?take=50'), [refresh]);
  const products = useLoad<Paginated<Product>>(
    () => api('/catalog/products?take=100&status=ACTIVE'),
    [],
  );
  const selected = (assets.data?.items ?? []).find((asset) => asset.id === selectedId) ?? null;
  const [bindUnitId, setBindUnitId] = useState('');
  const [bindNotice, setBindNotice] = useState<string | null>(null);
  const selectedStoreUnits = useStoreUnits(selected && !selected.unitId ? (selected.locationId ?? '') : '');
  const selectedUnitList = selectedStoreUnits.data?.items ?? [];

  async function bindUnit() {
    if (!selectedId || !bindUnitId) return;
    setBindNotice(null);
    try {
      await api(`/video-assets/${selectedId}/binding`, { method: 'PATCH', body: { unitId: bindUnitId } });
      setBindNotice('Unit bound.');
      setBindUnitId('');
      setRefresh((n) => n + 1);
    } catch (err) {
      setBindNotice(errorText(err));
    }
  }

  useEffect(() => {
    setReport(null);
    if (!selectedId) return;
    void api<ClipLabReport>(`/video-assets/${selectedId}/lab-report`)
      .then(setReport)
      .catch(() => setReport(null));
  }, [selectedId, refresh]);

  async function runAll() {
    if (!selectedId) return;
    setRunning(true);
    setRunError(null);
    try {
      setReport(await api<ClipLabReport>(`/video-assets/${selectedId}/lab-run`, { method: 'POST', body: {} }));
      setRefresh((n) => n + 1);
    } catch (err) {
      setRunError(errorText(err));
    } finally {
      setRunning(false);
    }
  }

  async function saveTruth(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setTruthNotice(null);
    try {
      await api(`/video-assets/${selectedId}/ground-truth`, {
        method: 'PUT',
        body: {
          eventKind: truthKind,
          ...(truthProduct ? { productId: truthProduct } : {}),
          ...(truthMs.trim() ? { actualTimestampMs: Number(truthMs) } : {}),
        },
      });
      setTruthNotice('Ground truth saved.');
      setRefresh((n) => n + 1);
    } catch (err) {
      setTruthNotice(errorText(err));
    }
  }

  return (
    <Page title="Clip Lab" error={assets.error}>
      <p className="muted">
        One place to test a clip against the planogram: upload with the store and rack bound,
        approve screening, run the full shadow analysis, read one result. Everything is advisory
        and review-required — nothing here touches checkout, orders, or inventory.
      </p>
      <UploadSection
        onUploaded={(asset) => {
          setSelectedId(asset.id);
          setRefresh((n) => n + 1);
        }}
      />
      <section className="detail">
        <h3>3. Run the analysis</h3>
        <div className="toolbar">
          <label>
            Clip *{' '}
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              <option value="">— clip —</option>
              {(assets.data?.items ?? []).map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.originalFilename} · {asset.status}
                  {asset.planogramRackCode ? ` · ${asset.planogramRackCode}` : ' · no rack bound'}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            type="button"
            onClick={() => void runAll()}
            disabled={!selectedId || running || selected?.status === 'QUARANTINED'}
          >
            {running ? 'Running…' : 'Run full analysis'}
          </button>
        </div>
        {selected && !selected.planogramRackCode ? (
          <p className="error">
            This clip has no rack bound — candidates will use the full catalog. Re-upload it
            through Clip Lab or bind it on the clip page.
          </p>
        ) : null}
        {selected && !selected.unitId ? (
          <div className="notice warn">
            <p>This clip has no unit bound — classical detection is skipped.</p>
            {selected.locationId ? (
              <div className="toolbar">
                <label>
                  Unit{' '}
                  <select value={bindUnitId} onChange={(e) => setBindUnitId(e.target.value)}>
                    <option value="">— unit —</option>
                    {selectedUnitList.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name} ({unit.code})
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" onClick={() => void bindUnit()} disabled={!bindUnitId}>
                  Bind unit
                </button>
                {bindNotice ? <span className="muted">{bindNotice}</span> : null}
              </div>
            ) : (
              <p className="muted">Bind a store on the clip page first.</p>
            )}
          </div>
        ) : null}
        {selected?.status === 'QUARANTINED' ? (
          <p className="muted">Approve screening below first.</p>
        ) : null}
        {runError ? <p className="error">{runError}</p> : null}
        {selected ? (
          <form onSubmit={saveTruth} className="toolbar">
            <span className="muted">Ground truth (optional):</span>
            <select value={truthKind} onChange={(e) => setTruthKind(e.target.value as GroundTruthEventKind)}>
              <option value="PICKUP">Pickup</option>
              <option value="RETURN">Return</option>
              <option value="NONE">No event</option>
            </select>
            <select value={truthProduct} onChange={(e) => setTruthProduct(e.target.value)}>
              <option value="">— product —</option>
              {(products.data?.items ?? []).map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.sku})
                </option>
              ))}
            </select>
            <input
              placeholder="event ms"
              style={{ width: '7em' }}
              value={truthMs}
              onChange={(e) => setTruthMs(e.target.value)}
            />
            <button type="submit">Save ground truth</button>
            {truthNotice ? <span className="muted">{truthNotice}</span> : null}
          </form>
        ) : null}
      </section>
      {selected ? (
        <ScreeningSection asset={selected} onChanged={() => setRefresh((n) => n + 1)} />
      ) : null}
      {report ? <ResultSection report={report} /> : null}
    </Page>
  );
}
