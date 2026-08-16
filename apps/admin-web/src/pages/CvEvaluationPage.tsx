import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  EvaluationSummary,
  EvaluationTestRuns,
  api,
} from '../api';
import { Page, useLoad } from '../components';
import {
  formatRate,
  passBadge,
  testTypeLabel,
} from '../cv-evaluation-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/**
 * Phase 11 CV evaluation dashboard: accuracy over ground-truthed clips
 * only, plus the controlled test matrix with per-row fusion reruns.
 * Fused scores are UNCALIBRATED ranking scores — labeled as such.
 */
export function CvEvaluationPage() {
  const [reload, setReload] = useState(0);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const summary = useLoad<EvaluationSummary>(
    () => api('/cv-evaluation/summary'),
    [reload],
  );
  const testRuns = useLoad<EvaluationTestRuns>(
    () => api('/cv-evaluation/test-runs'),
    [reload],
  );

  async function rerun(videoAssetId: string) {
    setBusyAssetId(videoAssetId);
    setActionError(null);
    setNotice(null);
    try {
      await api(`/video-assets/${videoAssetId}/fusion-run`, {
        method: 'POST',
        body: {},
      });
      setNotice(`Fusion rerun complete for ${videoAssetId}.`);
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyAssetId(null);
    }
  }

  const data = summary.data;
  const tiles: { label: string; value: string }[] = data
    ? [
        {
          label: 'Ground-truthed clips',
          value: String(data.totals.groundTruthedClips),
        },
        { label: 'Pickup accuracy', value: formatRate(data.pickupAccuracy) },
        { label: 'Return accuracy', value: formatRate(data.returnAccuracy) },
        {
          label: 'False-touch rejection',
          value: formatRate(data.falseTouchRejection),
        },
        { label: 'SKU top-1', value: formatRate(data.skuTop1Accuracy) },
        { label: 'SKU top-3', value: formatRate(data.skuTop3Accuracy) },
        {
          label: 'VLM agreement (answered)',
          value:
            data.vlmAgreement.vlmAgreementRate === null
              ? '— · 0 answered'
              : `${Math.round(data.vlmAgreement.vlmAgreementRate * 100)}% · ${data.vlmAgreement.agree}/${data.vlmAgreement.vlmAnsweredCount}`,
        },
        {
          label: 'VLM abstention rate',
          value:
            data.vlmAgreement.vlmAbstentionRate === null
              ? '—'
              : `${Math.round(data.vlmAgreement.vlmAbstentionRate * 100)}% · ${data.vlmAgreement.vlmAbstentionCount} abstained`,
        },
        { label: 'Human-review rate', value: formatRate(data.humanReviewRate) },
        {
          label: 'Basket exact match',
          value: formatRate(data.basketExactMatchRate),
        },
      ]
    : [];

  return (
    <Page
      title="CV evaluation"
      error={summary.error ?? testRuns.error}
      loading={summary.loading && !data}
    >
      {data ? (
        <>
          <p className="muted">
            Accuracy counts ONLY clips with saved ground truth
            {data.totals.clipsWithoutRun > 0
              ? ` — ${data.totals.clipsWithoutRun} clip${
                  data.totals.clipsWithoutRun === 1 ? ' has' : 's have'
                } no fusion run and ${
                  data.totals.clipsWithoutRun === 1 ? 'is' : 'are'
                } excluded from accuracy`
              : ''}
            . VLM agreement counts answered verdicts only — abstentions:{' '}
            {data.vlmAgreement.vlmAbstentionCount} · disagreements:{' '}
            {data.vlmAgreement.disagree}.
          </p>
          <div className="cards">
            {tiles.map((tile) => (
              <div key={tile.label} className="card">
                <div className="value">{tile.value}</div>
                <div className="label">{tile.label}</div>
              </div>
            ))}
          </div>

          <h2>Median latency by stage</h2>
          {data.latency.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Median ms</th>
                  <th>Samples</th>
                </tr>
              </thead>
              <tbody>
                {data.latency.map((row) => (
                  <tr key={row.stage}>
                    <td>{row.stage}</td>
                    <td>{Math.round(row.medianMs)}</td>
                    <td>{row.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No fusion runs yet.</p>
          )}

          <h2>Per-SKU breakdown</h2>
          {data.perSku.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Clips</th>
                  <th>Top-1 correct</th>
                  <th>Top-1 rate</th>
                </tr>
              </thead>
              <tbody>
                {data.perSku.map((row) => (
                  <tr key={row.sku}>
                    <td>{row.sku}</td>
                    <td>{row.clips}</td>
                    <td>{row.top1Correct}</td>
                    <td>
                      {row.top1Rate !== null
                        ? `${Math.round(row.top1Rate * 100)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No ground-truthed clips with a SKU yet.</p>
          )}

          <h2>
            Per-SKU confusion — fused top-1 (ground-truthed clips with runs)
          </h2>
          {data.confusion.samples > 0 ? (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>actual ↓ / predicted →</th>
                      {data.confusion.labels.map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.confusion.labels.map((rowLabel, rowIndex) => (
                      <tr key={rowLabel}>
                        <td>{rowLabel}</td>
                        {data.confusion.matrix[rowIndex].map(
                          (cell, columnIndex) => (
                            <td
                              key={`${rowLabel}-${columnIndex}`}
                              className={cell === 0 ? 'muted' : undefined}
                            >
                              {cell === 0 ? '·' : cell}
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                {data.confusion.samples} ground-truthed clip
                {data.confusion.samples === 1 ? '' : 's'} counted.
              </p>
            </>
          ) : (
            <p className="muted">No ground-truthed clips with runs yet.</p>
          )}

          <h2>Per-test-type breakdown</h2>
          {data.perTestType.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Test type</th>
                  <th>Clips</th>
                  <th>Passed</th>
                  <th>Pass rate</th>
                </tr>
              </thead>
              <tbody>
                {data.perTestType.map((row) => (
                  <tr key={row.testType}>
                    <td>{testTypeLabel(row.testType)}</td>
                    <td>{row.clips}</td>
                    <td>{row.passed}</td>
                    <td>
                      {row.passRate !== null
                        ? `${Math.round(row.passRate * 100)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No ground-truthed clips yet.</p>
          )}

          <h2>Controlled test matrix</h2>
          {actionError ? <div className="error">{actionError}</div> : null}
          {notice ? <p className="muted">✓ {notice}</p> : null}
          {(testRuns.data?.rows ?? []).length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Video</th>
                  <th>Test type</th>
                  <th>Ground truth</th>
                  <th>Policy</th>
                  <th>Predicted</th>
                  <th>Fused score (uncalibrated)</th>
                  <th>VLM status</th>
                  <th>Result</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(testRuns.data?.rows ?? []).map((row) => {
                  const badge = passBadge(row.evaluation.pass);
                  return (
                    <tr key={row.videoAssetId}>
                      <td>
                        <Link to={`/video-assets/${row.videoAssetId}`}>
                          {row.originalFilename}
                        </Link>
                      </td>
                      <td>{testTypeLabel(row.testType)}</td>
                      <td>
                        {row.groundTruth.eventKind === 'NONE'
                          ? 'no pickup'
                          : `${row.groundTruth.eventKind} ${
                              row.groundTruth.sku ?? '—'
                            } × ${row.groundTruth.quantity}`}
                      </td>
                      <td>{row.run?.policy ?? '—'}</td>
                      <td>
                        {row.run
                          ? row.run.predictedKind
                            ? `${row.run.predictedKind} ${row.run.predictedSku ?? '(no sku)'}`
                            : 'no event'
                          : 'no run'}
                      </td>
                      <td>
                        {row.run?.fusedTopScore != null
                          ? row.run.fusedTopScore.toFixed(3)
                          : '—'}
                      </td>
                      <td>
                        {row.run
                          ? (row.run.vlmStatus ?? 'not invoked') +
                            (row.run.requiresHumanReview ? ' · review' : '')
                          : '—'}
                      </td>
                      <td>
                        <span
                          className={`badge ${badge.tone}`}
                          title={`expected: ${row.evaluation.expected} · actual: ${row.evaluation.actual}`}
                        >
                          {badge.label}
                        </span>
                      </td>
                      <td>
                        <button
                          disabled={busyAssetId !== null}
                          onClick={() => void rerun(row.videoAssetId)}
                        >
                          {busyAssetId === row.videoAssetId
                            ? 'Rerunning…'
                            : 'Rerun fusion'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              No ground-truthed clips yet — record ground truth on a test
              video to see it here.
            </p>
          )}
          <p className="muted">{data.scoreNote}</p>
        </>
      ) : null}
    </Page>
  );
}
