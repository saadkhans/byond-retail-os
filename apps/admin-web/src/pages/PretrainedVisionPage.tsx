import { FormEvent, useState } from 'react';
import {
  Paginated,
  PlanogramRackView,
  PretrainedComparisonReport,
  PretrainedProviderStatus,
  Product,
  Store,
  VideoAsset,
  api,
  pretrainedEvaluatePath,
} from '../api';
import { Page, useLoad } from '../components';

/**
 * Phase 19 — Pretrained Vision Evaluation (shadow-only lab surface).
 *
 * Compares LOCAL pretrained provider evidence (object/product detection,
 * hand signals, SKU embedding retrieval) side by side against the
 * classical fallback for an uploaded clip, with optional
 * planogram-aware SKU narrowing. Everything here is evidence: nothing
 * on this page can touch checkout, order, payment, settlement, or
 * inventory state. The API additionally requires the video-asset read
 * boundary — without it the page shows the access message.
 *
 * SAFETY: only classified codes, SKUs, normalized numbers, and ids are
 * rendered — never file paths, model paths, stream URLs, raw OCR text,
 * barcode values, provider logs, or raw media.
 */

const AVAILABILITY_BADGE: Record<string, string> = {
  READY: 'ok',
  DISABLED: '',
  UNAVAILABLE: 'warn',
};

const IMPROVEMENT_LABELS: Record<string, string> = {
  PRODUCT_DETECTED: 'Product detected',
  HAND_COVERED_PRODUCT: 'Hand covered product',
  CROP_IMPROVED: 'Crop improved',
  SKU_CANDIDATE_CHANGED: 'SKU candidate changed',
  DETECTION_COVERAGE_IMPROVED: 'Detector covered more frames than classical',
  HAND_CONTACT_OBSERVED: 'Hand contact observed by detector',
  PRETRAINED_GATE_NOT_APPROVED:
    'Pretrained output is advisory until gates are approved',
  STILL_NEEDS_REVIEW: 'Still needs review',
  NO_IMPROVEMENT_OVER_CLASSICAL: 'No improvement over classical fallback',
};

const MATCH_LABELS: Record<string, string> = {
  MATCH: 'Expected in this cell',
  ADJACENT_MATCH: 'Found in neighboring cell',
  RACK_MATCH: 'Elsewhere on this rack',
  OUT_OF_PLANOGRAM: 'Possible misplaced product',
  UNKNOWN_CELL: 'Cell mapping uncertain',
  PLANOGRAM_NOT_CONFIGURED: 'Planogram not configured',
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

function ProviderChips({ providers }: { providers: PretrainedProviderStatus[] }) {
  return (
    <div className="toolbar" style={{ flexWrap: 'wrap' }}>
      {providers.map((provider) => (
        <span
          key={provider.provider}
          className={`badge ${AVAILABILITY_BADGE[provider.availability] ?? ''}`}
          title={provider.reasonCode ?? ''}
        >
          {provider.provider} · {provider.availability}
          {provider.stubMode ? ' (lab stub)' : ''}
          {provider.runtime
            ? ` · model ${provider.runtime.modelId}` +
              (provider.runtime.device ? ` (${provider.runtime.device})` : '')
            : ''}
        </span>
      ))}
    </div>
  );
}

function PlanogramEditor({
  stores,
  products,
  onPublished,
}: {
  stores: Store[];
  products: Product[];
  onPublished: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const [rackCode, setRackCode] = useState('');
  const [rows, setRows] = useState('4');
  const [columns, setColumns] = useState('4');
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const productBySku = new Map(
    products.map((product) => [product.sku.toUpperCase(), product.id]),
  );

  async function publish(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setErrorText(null);
    // CSV rows: row,column,SKU  (row/column are 1-based for operators).
    const cells: {
      rowIndex: number;
      columnIndex: number;
      productId: string;
    }[] = [];
    for (const line of csv.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [rowRaw, colRaw, skuRaw] = trimmed.split(',').map((v) => v.trim());
      const rowIndex = Number(rowRaw) - 1;
      const columnIndex = Number(colRaw) - 1;
      const productId = productBySku.get((skuRaw ?? '').toUpperCase());
      if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)) {
        setErrorText(`Bad row/column in line: "${trimmed}"`);
        return;
      }
      if (!productId) {
        setErrorText(`Unknown SKU in line: "${trimmed}"`);
        return;
      }
      cells.push({ rowIndex, columnIndex, productId });
    }
    if (!cells.length) {
      setErrorText('Add at least one line: row,column,SKU');
      return;
    }
    setBusy(true);
    try {
      await api('/planograms/racks', {
        method: 'POST',
        body: {
          locationId,
          rackCode,
          rows: Number(rows),
          columns: Number(columns),
          cells,
        },
      });
      setMessage('Planogram published (a re-publish creates a new version).');
      onPublished();
    } catch (err) {
      setErrorText(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="toolbar" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }} onSubmit={(e) => void publish(e)}>
      <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
        <option value="">— store —</option>
        {stores.map((store) => (
          <option key={store.id} value={store.id}>
            {store.name} ({store.code})
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="rack code (e.g. R1)"
        style={{ width: '9rem' }}
        value={rackCode}
        onChange={(e) => setRackCode(e.target.value)}
      />
      <label>
        Rows{' '}
        <input type="text" style={{ width: '3rem' }} value={rows} onChange={(e) => setRows(e.target.value)} />
      </label>
      <label>
        Columns{' '}
        <input type="text" style={{ width: '3rem' }} value={columns} onChange={(e) => setColumns(e.target.value)} />
      </label>
      <textarea
        placeholder={'One assignment per line: row,column,SKU\ne.g. 2,3,SKU-LIME-GREEN'}
        style={{ width: 'min(28rem, 100%)', minHeight: '5rem' }}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      <button className="primary" type="submit" disabled={busy || !locationId || !rackCode}>
        {busy ? 'Publishing…' : 'Publish planogram'}
      </button>
      {message ? <p className="muted">✓ {message}</p> : null}
      {errorText ? <div className="error">{errorText}</div> : null}
    </form>
  );
}

export function PretrainedVisionPage() {
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [rackCode, setRackCode] = useState('');
  const [locationId, setLocationId] = useState('');
  const [rackX, setRackX] = useState('');
  const [rackY, setRackY] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [report, setReport] = useState<PretrainedComparisonReport | null>(null);
  const [rackReload, setRackReload] = useState(0);

  const providers = useLoad<{ providers: PretrainedProviderStatus[] }>(
    () => api('/pretrained-vision/providers'),
    [],
  );
  const clips = useLoad<Paginated<VideoAsset>>(
    () => api('/video-assets?take=50'),
    [],
  );
  const stores = useLoad<Paginated<Store>>(() => api('/stores?take=100'), []);
  const products = useLoad<Paginated<Product>>(
    () => api('/catalog/products?take=100&status=ACTIVE'),
    [],
  );
  const racks = useLoad<PlanogramRackView[]>(
    () => api('/planograms/racks'),
    [rackReload],
  );

  async function evaluate() {
    if (!selectedAssetId) {
      return;
    }
    setBusy(true);
    setErrorText(null);
    try {
      const parsed = (value: string) => {
        const num = Number(value);
        return value.trim() !== '' && Number.isFinite(num) ? num : undefined;
      };
      const result = await api<PretrainedComparisonReport>(
        pretrainedEvaluatePath(selectedAssetId),
        {
          method: 'POST',
          body: {
            ...(locationId ? { locationId } : {}),
            ...(rackCode ? { rackCode } : {}),
            ...(parsed(rackX) !== undefined ? { normalizedRackX: parsed(rackX) } : {}),
            ...(parsed(rackY) !== undefined ? { normalizedRackY: parsed(rackY) } : {}),
          },
        },
      );
      setReport(result);
    } catch (err) {
      setErrorText(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const planogram = report?.planogram ?? null;

  return (
    <Page
      title="Pretrained vision evaluation"
      error={providers.error ?? clips.error}
      loading={providers.loading && !providers.data}
    >
      <p className="muted">
        Shadow-only lab: compare LOCAL pretrained providers (detection,
        hand signals, SKU embeddings) against the classical fallback for
        an uploaded clip, with optional planogram-aware SKU narrowing.
        Nothing here writes checkout, order, payment, settlement, or
        inventory records.
      </p>

      <section>
        <h3>Providers</h3>
        {providers.data ? (
          <ProviderChips providers={providers.data.providers} />
        ) : null}
      </section>

      <section>
        <h3>Evaluate a clip</h3>
        {errorText ? <div className="error">{errorText}</div> : null}
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <select
            value={selectedAssetId}
            onChange={(e) => setSelectedAssetId(e.target.value)}
          >
            <option value="">— clip —</option>
            {(clips.data?.items ?? [])
              .filter((clip) => !clip.deletedAt)
              .map((clip) => (
                <option key={clip.id} value={clip.id}>
                  {clip.originalFilename}
                </option>
              ))}
          </select>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">— store (for planogram) —</option>
            {(stores.data?.items ?? []).map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="rack code"
            style={{ width: '7rem' }}
            value={rackCode}
            onChange={(e) => setRackCode(e.target.value)}
          />
          <input
            type="text"
            placeholder="x 0..1"
            style={{ width: '5rem' }}
            title="Normalized horizontal position inside the rack"
            value={rackX}
            onChange={(e) => setRackX(e.target.value)}
          />
          <input
            type="text"
            placeholder="y 0..1"
            style={{ width: '5rem' }}
            title="Normalized vertical position inside the rack"
            value={rackY}
            onChange={(e) => setRackY(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || !selectedAssetId}
            onClick={() => void evaluate()}
          >
            {busy ? 'Evaluating…' : 'Run side-by-side evaluation'}
          </button>
        </div>
      </section>

      {report ? (
        <>
          <section>
            <h3>Comparison</h3>
            <dl className="detail">
              <dt>Classical fallback</dt>
              <dd>
                {report.classical
                  ? `${report.classical.topSku ?? 'UNKNOWN'} · ${report.classical.action} ` +
                    `(ranking score ${report.classical.topScore?.toFixed(2) ?? '—'})`
                  : '— no fusion run yet'}
              </dd>
              {report.runs
                .filter((run) => run.provider !== 'CLASSICAL')
                .map((run) => (
                  <div key={run.provider} style={{ display: 'contents' }}>
                    <dt>{run.provider}</dt>
                    <dd>
                      {run.evidence.availability !== 'READY'
                        ? `unavailable (${run.evidence.reasonCode ?? 'not enabled'})`
                        : (run.evidence.features
                            ? `${run.evidence.features.actionCandidate}` +
                              (run.evidence.detections.length
                                ? ' · product detected'
                                : '')
                            : run.evidence.embeddingCandidates.length
                              ? `top SKU ${run.evidence.embeddingCandidates[0].sku}`
                              : run.evidence.handSignal?.handPresent
                                ? 'hand near shelf zone'
                                : 'no signal') +
                          (run.synthetic ? ' · lab stub' : ' · real local inference')}
                    </dd>
                  </div>
                ))}
              <dt>Embedding candidates</dt>
              <dd>
                {report.embeddingCandidates.length
                  ? report.embeddingCandidates
                      .map(
                        (candidate) =>
                          `${candidate.sku} (${candidate.similarity.toFixed(2)})`,
                      )
                      .join(' · ')
                  : '— none'}
              </dd>
              <dt>Hand signal</dt>
              <dd>
                {report.handSignal?.handPresent
                  ? `hand present · contact ${report.handSignal.contactDurationMs ?? '—'} ms`
                  : '— none detected'}
              </dd>
              <dt>Fusion suggestion (advisory)</dt>
              <dd>
                {report.fusionSuggestion.sku ?? 'UNKNOWN'} ·{' '}
                {report.fusionSuggestion.action}
                {report.fusionSuggestion.reviewRequired ? (
                  <span className="badge warn" style={{ marginLeft: '0.5rem' }}>
                    Still needs review
                  </span>
                ) : null}
              </dd>
              <dt>Ground truth</dt>
              <dd>
                {report.groundTruth
                  ? `${report.groundTruth.eventKind}${report.groundTruth.sku ? ` · ${report.groundTruth.sku}` : ''}`
                  : '— not set'}
              </dd>
              <dt>Operator correction</dt>
              <dd>
                {report.operatorCorrection
                  ? `${report.operatorCorrection.verdict} → ${report.operatorCorrection.expectedAction}` +
                    (report.operatorCorrection.expectedSku
                      ? ` · ${report.operatorCorrection.expectedSku}`
                      : '')
                  : '— none yet'}
              </dd>
              <dt>Summary</dt>
              <dd>
                {report.improvementNotes
                  .map((note) => IMPROVEMENT_LABELS[note] ?? note)
                  .join(' · ')}
              </dd>
            </dl>
          </section>

          <section>
            <h3>Planogram</h3>
            {planogram && planogram.configured ? (
              <dl className="detail">
                <dt>Detected cell</dt>
                <dd>
                  {planogram.cell
                    ? `${planogram.rackCode} · ${planogram.cell.cellCode} ` +
                      `(confidence ${planogram.cell.confidence.toFixed(2)})`
                    : 'Cell mapping uncertain'}
                </dd>
                <dt>Expected in this cell</dt>
                <dd>
                  {planogram.planogramCandidateSkus.join(', ') || '— none'}
                </dd>
                <dt>Neighboring cells</dt>
                <dd>
                  {planogram.adjacentCellCandidateSkus.join(', ') || '— none'}
                </dd>
                <dt>Visual vs planogram</dt>
                <dd>
                  {MATCH_LABELS[planogram.planogramMatchStatus] ??
                    planogram.planogramMatchStatus}
                  {planogram.reviewRequired ? (
                    <span className="badge warn" style={{ marginLeft: '0.5rem' }}>
                      Still needs review
                    </span>
                  ) : null}
                </dd>
              </dl>
            ) : (
              <p className="muted">
                Planogram not configured for this rack — SKU candidates use
                the full catalog. Publish a layout below to narrow them.
              </p>
            )}
          </section>
        </>
      ) : null}

      <section>
        <h3>Planogram layouts</h3>
        <p className="muted">
          Planograms are a SOFT evidence prior: expected SKUs get a small
          score boost, disagreement flags review — a SKU is never rejected
          for being outside its expected cell.
        </p>
        {(racks.data ?? []).map((rack) => (
          <p key={rack.rackId} className="muted">
            <span className="badge">{rack.rackCode}</span> v{rack.version} ·{' '}
            {rack.rows}×{rack.columns} · {rack.cells.length} assignment(s)
          </p>
        ))}
        <PlanogramEditor
          stores={stores.data?.items ?? []}
          products={products.data?.items ?? []}
          onPublished={() => setRackReload((n) => n + 1)}
        />
      </section>
    </Page>
  );
}
