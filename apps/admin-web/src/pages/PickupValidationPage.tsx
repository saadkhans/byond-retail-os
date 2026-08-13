import { Link } from 'react-router-dom';
import { ValidationSummary, api } from '../api';
import { Page, useLoad } from '../components';
import { formatMs } from '../pickup-detection-utils';

const OUTCOME_LABEL: Record<string, { label: string; tone: string }> = {
  correct: { label: 'ACCEPTED', tone: 'ok' },
  incorrect: { label: 'INCORRECT', tone: 'down' },
  quantity_mismatch: { label: 'QUANTITY MISMATCH', tone: 'warn' },
  missed: { label: 'REJECTED (unknown)', tone: 'warn' },
  false_pickup: { label: 'FALSE PICKUP', tone: 'down' },
  true_negative: { label: 'TRUE NEGATIVE', tone: 'ok' },
  not_detected: { label: 'NOT DETECTED', tone: 'warn' },
  unscored: { label: 'UNSCORED (return)', tone: '' },
};

/**
 * Validation-results dashboard: every reviewed test video (ground truth +
 * finished detection attempt) scored actual-vs-predicted, with FP/FN
 * totals and the per-SKU confusion matrix once 50 pickup videos are
 * reviewed. Match scores are raw HSV+NCC numbers — deliberately NOT
 * presented as probabilities.
 */
export function PickupValidationPage() {
  const summary = useLoad<ValidationSummary>(
    () => api('/pickup-validation/summary'),
    [],
  );
  const data = summary.data;

  return (
    <Page
      title="Pickup validation"
      error={summary.error}
      loading={summary.loading}
    >
      {data ? (
        <>
          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
            <span className="muted">Reviewed: {data.totals.reviewed}</span>
            <span className="badge ok">correct {data.totals.correct}</span>
            <span className="badge down">
              incorrect {data.totals.incorrect}
            </span>
            <span className="badge warn">unknown {data.totals.missed}</span>
            <span className="badge down">
              false positives {data.totals.falsePositives}
            </span>
            <span className="badge warn">
              false negatives {data.totals.falseNegatives}
            </span>
            <span className="badge ok">
              true negatives {data.totals.trueNegatives}
            </span>
            <span className="muted">
              not detected {data.totals.notDetected} · unscored returns{' '}
              {data.totals.unscored}
            </span>
          </div>

          <table>
            <thead>
              <tr>
                <th>Video</th>
                <th>Actual</th>
                <th>Predicted</th>
                <th>Match score</th>
                <th>Timestamp error</th>
                <th>Outcome</th>
                <th>Fusion v2</th>
                <th>Top 3 candidates</th>
                <th>Processing</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const outcome = OUTCOME_LABEL[row.outcome] ?? {
                  label: row.outcome,
                  tone: '',
                };
                return (
                  <tr key={row.videoAssetId}>
                    <td>
                      <Link to={`/video-assets/${row.videoAssetId}`}>
                        {row.originalFilename}
                      </Link>
                    </td>
                    <td>
                      {row.actualEventKind === 'NONE'
                        ? 'no pickup'
                        : `${row.actualSku ?? '—'}${
                            row.actualEventKind === 'RETURN' ? ' (return)' : ''
                          }`}
                    </td>
                    <td>{row.predictedSku ?? (row.jobErrorCode ? `— (${row.jobErrorCode})` : 'UNKNOWN')}</td>
                    <td>
                      {row.matchScore !== null
                        ? `${Math.round(row.matchScore * 100)}%`
                        : '—'}
                    </td>
                    <td>
                      {row.timestampErrorMs !== null
                        ? formatMs(row.timestampErrorMs)
                        : '—'}
                    </td>
                    <td>
                      <span className={`badge ${outcome.tone}`}>
                        {outcome.label}
                      </span>
                    </td>
                    <td>
                      {row.fusionTopSku !== null || row.fusionPolicy !== null ? (
                        <>
                          {row.fusionTopSku ?? 'UNKNOWN'}
                          {row.fusionTopScore !== null
                            ? ` ${Math.round(row.fusionTopScore * 100)}%`
                            : ''}
                          {row.fusionVerdict ? (
                            <>
                              {' '}
                              <span
                                className={`badge ${
                                  row.fusionVerdict === 'correct'
                                    ? 'ok'
                                    : row.fusionVerdict === 'incorrect'
                                      ? 'down'
                                      : 'warn'
                                }`}
                              >
                                {row.fusionVerdict}
                              </span>
                            </>
                          ) : null}
                          {row.fusionPolicy ? (
                            <div className="muted">{row.fusionPolicy}</div>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {row.topCandidates
                        .map(
                          (candidate) =>
                            `${candidate.sku} ${
                              candidate.score !== null
                                ? Math.round(candidate.score * 100)
                                : '—'
                            }%`,
                        )
                        .join(' · ') || '—'}
                    </td>
                    <td>
                      {row.processingMs !== null
                        ? `${(row.processingMs / 1000).toFixed(1)} s`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h2>Confusion matrix (by SKU)</h2>
          {data.confusionMatrix.unlocked && data.confusionMatrix.matrix ? (
            <table>
              <thead>
                <tr>
                  <th>actual \ predicted</th>
                  {data.confusionMatrix.skus.map((sku) => (
                    <th key={sku}>{sku}</th>
                  ))}
                  <th>UNKNOWN</th>
                </tr>
              </thead>
              <tbody>
                {data.confusionMatrix.skus.map((sku, rowIndex) => (
                  <tr key={sku}>
                    <td>
                      <strong>{sku}</strong>
                    </td>
                    {data.confusionMatrix.matrix![rowIndex].map(
                      (count, colIndex) => (
                        <td
                          key={colIndex}
                          style={
                            colIndex === rowIndex && count > 0
                              ? { fontWeight: 600 }
                              : undefined
                          }
                        >
                          {count}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              Unlocks at {data.confusionMatrix.minReviewed} reviewed pickup
              videos — currently {data.confusionMatrix.reviewedCount}. Keep
              uploading labelled test clips.
            </p>
          )}
        </>
      ) : null}
    </Page>
  );
}
