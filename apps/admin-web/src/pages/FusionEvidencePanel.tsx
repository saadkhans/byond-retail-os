import { useState } from 'react';
import { ApiError, VlmReadiness, api } from '../api';
import { useLoad } from '../components';
import { formatMs } from '../pickup-detection-utils';

/** Loosely-typed mirror of the server's FusionEvidence JSON. */
interface FusionEvidenceResponse {
  runId: string;
  pipelineVersion: string;
  policy: string;
  fusedTopSku: string | null;
  fusedTopScore: number | null;
  scoreMargin: number | null;
  processingMs: number;
  createdAt: string;
  evidence: {
    stages: { stage: string; adapterKey: string; version: string; ms: number }[];
    detector: {
      adapterKey: string;
      warnings: string[];
      events: {
        kind: string;
        startMs: number;
        peakMs: number;
        endMs: number;
        trackId: string;
        shelfZoneId: string;
        box: { x: number; y: number; width: number; height: number };
      }[];
      tracks: { trackId: string; label: string; points: unknown[] }[];
      yoloReady: boolean;
    };
    crops: {
      phase: string;
      timestampMs: number;
      quality: { sharpness: number; occlusion: number; brightness: number };
      selected: boolean;
    }[];
    barcode: { results: { value: string; format: string }[]; matchedSku: string | null };
    ocr: { rawText: string; normalizedText: string; languages: string[]; perProduct: { sku: string; score: number }[] };
    retrieval: { modelKey: string; modelVersion: string; indexed: number; candidates: { sku: string; score: number }[] };
    classical: { candidates: { sku: string; score: number }[] };
    context: { candidates: { sku: string; score: number; detail?: string }[] };
    fused: {
      rank: number;
      sku: string;
      productName: string;
      fusedScore: number;
      scoreMargin: number;
      signals: { source: string; score: number; detail?: string }[];
    }[];
    inventoryValidation: { sku: string; verdict: string; onHandQuantity: number | null }[];
    vlm: {
      invoked: boolean;
      reason: string;
      provider?: string;
      mode?: string;
      status: string | null;
      verdict?: string | null;
      selectedSku?: string | null;
      visualSupport?: string | null;
      ocrSupport?: string | null;
      barcodeSupport?: string | null;
      reasonCodes?: string[];
      contradictions?: string[];
      requiresHumanReview?: boolean | null;
      modelKey: string | null;
      latencyMs: number | null;
      /** Legacy rows (pre-strict-schema) only. */
      choice?: string | null;
      confidence?: number | null;
    };
    policy: { result: string; reason: string };
    shadow: {
      classicalV1: { predictedSku: string | null; matchScore: number | null; peakMs: number | null } | null;
      groundTruth: { sku: string | null; eventKind: string; actualTimestampMs: number | null } | null;
      v1Verdict: string | null;
      v2Verdict: string | null;
    };
  };
}

function policyTone(policy: string): string {
  if (policy === 'AUTO_PROPOSE') return 'ok';
  if (policy === 'FAILED' || policy === 'UNKNOWN_PRODUCT') return 'down';
  return 'warn';
}

function candidateList(items: { sku: string; score: number; detail?: string }[]) {
  if (items.length === 0) return <span className="muted">—</span>;
  return (
    <span>
      {items
        .slice(0, 5)
        .map((item) => `${item.sku} ${(item.score * 100).toFixed(0)}%`)
        .join(' · ')}
    </span>
  );
}

/**
 * pickup-fusion-v2 SHADOW evidence panel (requirement 14): every stage's
 * output and timing, the fused candidates with per-signal breakdown, the
 * VLM exchange, the policy decision, and the v1-vs-v2-vs-ground-truth
 * shadow comparison. Fused scores are labeled UNCALIBRATED on purpose.
 */
export function FusionEvidencePanel({
  assetId,
  refreshKey = 0,
}: {
  assetId: string;
  /** Bump to refetch (e.g. after ground truth changes) — the server
   *  recomputes shadow verdicts against current truth on every read. */
  refreshKey?: number;
}) {
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = useLoad<{ run: FusionEvidenceResponse | null }>(
    () => api(`/video-assets/${assetId}/fusion-evidence`),
    [assetId, tick, refreshKey],
  );
  const readiness = useLoad<VlmReadiness>(
    () => api('/pickup-fusion/vlm-readiness'),
    [tick],
  );

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api(`/video-assets/${assetId}/fusion-run`, { method: 'POST', body: {} });
      setTick((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
    } finally {
      setBusy(false);
    }
  }

  const data = latest.data?.run ?? null;
  const evidence = data?.evidence;

  return (
    <div style={{ margin: '1rem 0' }}>
      <h2>Fusion v2 (shadow mode)</h2>
      <p className="muted">
        pickup-fusion-v2 runs ALONGSIDE pickup-classical-v1 — it records
        evidence only and never touches events, inventory, sessions, or
        billing. Fused scores are ranking values, not calibrated
        probabilities.
      </p>
      <div className="toolbar">
        <button className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Running…' : data ? 'Run fusion again' : 'Run fusion (shadow)'}
        </button>
        {data ? (
          <>
            <span className={`badge ${policyTone(data.policy)}`}>{data.policy}</span>
            <span className="muted">
              {data.pipelineVersion} · {formatMs(data.processingMs)} total
            </span>
          </>
        ) : (
          <span className="muted">No fusion run yet.</span>
        )}
      </div>
      {error ? <div className="error">{error}</div> : null}
      {latest.error ? <div className="error">{latest.error}</div> : null}

      {readiness.data ? (
        <p className="muted">
          Local VLM:{' '}
          <span className={`badge ${readiness.data.ready ? 'ok' : 'warn'}`}>
            {readiness.data.ready
              ? 'READY'
              : (readiness.data.classification ?? 'NOT READY')}
          </span>{' '}
          provider {readiness.data.provider} · mode {readiness.data.mode} ·
          model {readiness.data.model ?? '—'} @ {readiness.data.baseUrl ?? '—'} ·
          timeout {readiness.data.timeoutMs} ms ·
          server {readiness.data.serverReachable ? 'reachable' : 'UNREACHABLE'} ·
          model {readiness.data.modelAvailable ? 'installed' : 'NOT INSTALLED'}
          {readiness.data.ready
            ? readiness.data.lastInference
              ? ` · last inference ${readiness.data.lastInference.status} in ${
                  readiness.data.lastInference.latencyMs ?? '—'
                } ms`
              : ' · not warmed up yet — first inference may be slow (cold model load)'
            : ''}
          {!readiness.data.serverReachable && readiness.data.provider === 'local'
            ? ' — start Ollama (`ollama serve`) and pull a vision model to activate'
            : ''}
          {readiness.data.serverReachable && !readiness.data.modelAvailable
            ? ` — available: ${readiness.data.availableModels.join(', ') || 'none'}`
            : ''}
        </p>
      ) : null}

      {data && evidence ? (
        <div style={{ border: '1px solid var(--border, #d8d8e0)', borderRadius: 6, padding: '0.75rem' }}>
          <p style={{ marginTop: 0 }}>
            <strong>
              {data.fusedTopSku
                ? `Fused top candidate: ${data.fusedTopSku} — fused score ${(data.fusedTopScore ?? 0).toFixed(3)} (uncalibrated), margin ${(data.scoreMargin ?? 0).toFixed(3)}`
                : 'No fused candidate'}
            </strong>{' '}
            <span className="muted">— policy: {evidence.policy.reason}</span>
          </p>

          <h3>Detector timeline</h3>
          <p className="muted">
            adapter {evidence.detector.adapterKey} · YOLO ready:{' '}
            {evidence.detector.yoloReady ? 'yes' : 'no (classical fallback)'}
            {evidence.detector.warnings.length > 0
              ? ` · warnings: ${evidence.detector.warnings.join(', ')}`
              : ''}
          </p>
          {evidence.detector.events.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Kind</th><th>Start</th><th>Peak</th><th>End</th><th>Track</th><th>Zone</th><th>Box</th>
                </tr>
              </thead>
              <tbody>
                {evidence.detector.events.map((event, index) => (
                  <tr key={index}>
                    <td>{event.kind}</td>
                    <td>{formatMs(event.startMs)}</td>
                    <td>{formatMs(event.peakMs)}</td>
                    <td>{formatMs(event.endMs)}</td>
                    <td>{event.trackId}</td>
                    <td>{event.shelfZoneId}</td>
                    <td>
                      {event.box.width}×{event.box.height} @ ({event.box.x}, {event.box.y})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No events proposed.</p>
          )}
          <p className="muted">
            {evidence.detector.tracks.length} track(s):{' '}
            {evidence.detector.tracks
              .map((track) => `${track.trackId}(${track.points.length}pt)`)
              .join(', ') || '—'}
          </p>

          <h3>Selected crops</h3>
          <table>
            <thead>
              <tr><th>Phase</th><th>Time</th><th>Sharpness</th><th>Occlusion</th><th>Brightness</th><th>Selected</th></tr>
            </thead>
            <tbody>
              {evidence.crops.map((crop, index) => (
                <tr key={index}>
                  <td>{crop.phase}</td>
                  <td>{formatMs(crop.timestampMs)}</td>
                  <td>{crop.quality.sharpness}</td>
                  <td>{Math.round(crop.quality.occlusion * 100)}%</td>
                  <td>{crop.quality.brightness}</td>
                  <td>{crop.selected ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Signals</h3>
          <dl>
            <dt>Barcode</dt>
            <dd>
              {evidence.barcode.results.length > 0
                ? evidence.barcode.results
                    .map((result) => `${result.value} (${result.format})`)
                    .join(', ') +
                  (evidence.barcode.matchedSku
                    ? ` → ${evidence.barcode.matchedSku}`
                    : ' (no catalog match)')
                : 'none detected'}
            </dd>
            <dt>OCR ({evidence.ocr.languages.join('+') || 'unavailable'})</dt>
            <dd>
              {evidence.ocr.normalizedText
                ? `"${evidence.ocr.normalizedText.slice(0, 120)}" — `
                : 'no text — '}
              {candidateList(evidence.ocr.perProduct)}
            </dd>
            <dt>
              Embeddings ({evidence.retrieval.modelKey}@{evidence.retrieval.modelVersion},{' '}
              {evidence.retrieval.indexed} indexed)
            </dt>
            <dd>{candidateList(evidence.retrieval.candidates)}</dd>
            <dt>Classical HSV+NCC</dt>
            <dd>{candidateList(evidence.classical.candidates)}</dd>
            <dt>Context (inventory/unit/zone)</dt>
            <dd>{candidateList(evidence.context.candidates)}</dd>
          </dl>

          <h3>Fused candidates (top {evidence.fused.length}, uncalibrated)</h3>
          <table>
            <thead>
              <tr><th>#</th><th>SKU</th><th>Fused</th><th>Margin</th><th>Signals</th></tr>
            </thead>
            <tbody>
              {evidence.fused.map((candidate) => (
                <tr key={candidate.sku}>
                  <td>{candidate.rank}</td>
                  <td>{candidate.sku}</td>
                  <td>{candidate.fusedScore.toFixed(3)}</td>
                  <td>{candidate.scoreMargin.toFixed(3)}</td>
                  <td className="muted">
                    {candidate.signals
                      .map((signal) => `${signal.source}:${signal.score.toFixed(2)}`)
                      .join(' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Inventory validation</h3>
          <p className="muted">
            {evidence.inventoryValidation
              .map(
                (validation) =>
                  `${validation.sku}: ${validation.verdict}${
                    validation.onHandQuantity !== null
                      ? ` (${validation.onHandQuantity})`
                      : ''
                  }`,
              )
              .join(' · ') || '—'}
          </p>

          <h3>VLM verifier</h3>
          <p className="muted">
            {`${evidence.vlm.provider ?? 'local'} · ${evidence.vlm.mode ?? 'UNCERTAIN_ONLY'} — `}
            {evidence.vlm.invoked ? (
              <>
                invoked ({evidence.vlm.reason}) →{' '}
                <span
                  className={`badge ${
                    evidence.vlm.status === 'VERDICT' ? 'ok' : 'warn'
                  }`}
                >
                  {evidence.vlm.status}
                </span>
                {evidence.vlm.modelKey ? ` · model ${evidence.vlm.modelKey}` : ''}
                {evidence.vlm.latencyMs !== null
                  ? ` · ${evidence.vlm.latencyMs} ms`
                  : ''}
              </>
            ) : (
              `not invoked (${evidence.vlm.reason})`
            )}
          </p>
          {evidence.vlm.verdict ? (
            <table>
              <thead>
                <tr>
                  <th>Verdict</th><th>Selected SKU</th><th>Visual</th>
                  <th>OCR</th><th>Barcode</th><th>Review flag</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <span
                      className={`badge ${
                        evidence.vlm.verdict === 'MATCH' ? 'ok' : 'warn'
                      }`}
                    >
                      {evidence.vlm.verdict}
                    </span>
                  </td>
                  <td>{evidence.vlm.selectedSku ?? '—'}</td>
                  <td>{evidence.vlm.visualSupport ?? '—'}</td>
                  <td>{evidence.vlm.ocrSupport ?? '—'}</td>
                  <td>{evidence.vlm.barcodeSupport ?? '—'}</td>
                  <td>
                    {evidence.vlm.requiresHumanReview === null ||
                    evidence.vlm.requiresHumanReview === undefined
                      ? '—'
                      : evidence.vlm.requiresHumanReview
                        ? 'requires human review'
                        : 'no'}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : null}
          {evidence.vlm.verdict ? (
            <p className="muted">
              Reason codes:{' '}
              {(evidence.vlm.reasonCodes ?? []).join(', ') || '—'} ·
              Contradictions:{' '}
              {(evidence.vlm.contradictions ?? []).join(', ') || 'none'}
            </p>
          ) : null}
          {!evidence.vlm.verdict && evidence.vlm.choice ? (
            <p className="muted">
              Legacy verdict (pre-strict schema): choice {evidence.vlm.choice}
              {typeof evidence.vlm.confidence === 'number'
                ? ` · confidence ${evidence.vlm.confidence.toFixed(2)}`
                : ''}
            </p>
          ) : null}
          {evidence.vlm.invoked ? (
            <p className="muted">
              Policy outcome: {data.policy} — {evidence.policy.reason}
            </p>
          ) : null}

          <h3>Shadow comparison</h3>
          <table>
            <thead>
              <tr><th></th><th>Predicted</th><th>Score</th><th>Verdict vs ground truth</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>classical-v1</td>
                <td>{evidence.shadow.classicalV1?.predictedSku ?? 'UNKNOWN'}</td>
                <td>
                  {evidence.shadow.classicalV1?.matchScore !== null &&
                  evidence.shadow.classicalV1 !== null
                    ? `${Math.round((evidence.shadow.classicalV1.matchScore ?? 0) * 100)}%`
                    : '—'}
                </td>
                <td>{evidence.shadow.v1Verdict ?? 'no ground truth'}</td>
              </tr>
              <tr>
                <td>fusion-v2</td>
                <td>{data.fusedTopSku ?? 'UNKNOWN'}</td>
                <td>{data.fusedTopScore !== null ? data.fusedTopScore.toFixed(3) : '—'}</td>
                <td>{evidence.shadow.v2Verdict ?? 'no ground truth'}</td>
              </tr>
            </tbody>
          </table>

          <h3>Per-stage processing time</h3>
          <p className="muted">
            {evidence.stages
              .map((stage) => `${stage.stage}(${stage.adapterKey}@${stage.version}): ${stage.ms} ms`)
              .join(' · ')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
