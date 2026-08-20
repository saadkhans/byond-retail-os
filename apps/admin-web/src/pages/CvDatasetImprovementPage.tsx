import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  CvDatasetExportManifestResult,
  CvDatasetModelTuningReport,
  CvDatasetPurpose,
  CvDatasetQualityReport,
  CvDatasetRefreshResult,
  CvDatasetRunDetail,
  CvDatasetRunView,
  CvDatasetSplitPlanResult,
  api,
} from '../api';
import { Page, formatDate, useLoad } from '../components';
import {
  buildCreateRunBody,
  datasetReadinessTone,
  formatDatasetAction,
  formatDatasetErrorMessage,
  formatDatasetWarning,
  runStatusTone,
  validateSplitPercents,
} from '../cv-dataset-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

const PURPOSES: CvDatasetPurpose[] = [
  'SKU_CLASSIFICATION',
  'ACTION_RECOGNITION',
  'FALSE_TOUCH_FILTERING',
  'MISSED_EVENT_RECOVERY',
  'CALIBRATION_VALIDATION',
  'MIXED',
];

const MANIFEST_PREVIEW_LIMIT = 4000;

/**
 * Phase 18 — dataset improvement & model tuning (ADVISORY, SHADOW ONLY).
 * Runs turn reviewed/corrected pilot data into training-ready metadata:
 * candidates, quality reports, deterministic splits, and a safe export
 * manifest. Nothing here trains a model, touches baskets/orders/payments/
 * inventory, or carries raw media, source URLs, paths, or credentials.
 */
export function CvDatasetImprovementPage() {
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<CvDatasetPurpose>('MIXED');
  const [trainPercent, setTrainPercent] = useState('70');
  const [validationPercent, setValidationPercent] = useState('20');
  const [testPercent, setTestPercent] = useState('10');
  const [minPerSku, setMinPerSku] = useState('5');
  const [minPerAction, setMinPerAction] = useState('5');
  const [sourceEvaluationRunId, setSourceEvaluationRunId] = useState('');
  const [sourceTestProtocolId, setSourceTestProtocolId] = useState('');
  const [sourceCalibrationProfileId, setSourceCalibrationProfileId] =
    useState('');
  const [notes, setNotes] = useState('');

  const runs = useLoad<CvDatasetRunView[]>(
    () => api('/cv-dataset-improvement-runs'),
    [tick],
  );

  async function createRun() {
    const splitError = validateSplitPercents(
      Number(trainPercent),
      Number(validationPercent),
      Number(testPercent),
    );
    if (splitError) {
      setFormError(splitError);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api('/cv-dataset-improvement-runs', {
        method: 'POST',
        body: buildCreateRunBody({
          name,
          purpose,
          trainPercentText: trainPercent,
          validationPercentText: validationPercent,
          testPercentText: testPercent,
          minPerSkuText: minPerSku,
          minPerActionText: minPerAction,
          sourceEvaluationRunId,
          sourceTestProtocolId,
          sourceCalibrationProfileId,
          notes,
        }),
      });
      setName('');
      setNotes('');
      setSourceEvaluationRunId('');
      setSourceTestProtocolId('');
      setSourceCalibrationProfileId('');
      setTick((n) => n + 1);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="Dataset improvement (shadow)"
      error={runs.error}
      loading={runs.loading && !runs.data}
    >
      <p className="muted">
        Turn reviewed and corrected pilot data into training-ready metadata:
        eligible candidates, quality reports, deterministic splits, and a safe
        export manifest. Advisory only — nothing here trains a model, touches
        orders, payments, or inventory, or carries raw media, URLs, paths, or
        credentials.
      </p>

      <h2>Create run</h2>
      {formError ? <div className="error">{formError}</div> : null}
      <div className="form-row">
        <input
          placeholder="Run name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          value={purpose}
          onChange={(e) => setPurpose(e.target.value as CvDatasetPurpose)}
        >
          {PURPOSES.map((option) => (
            <option key={option} value={option}>
              Purpose: {option}
            </option>
          ))}
        </select>
        <input
          placeholder="Train %"
          inputMode="numeric"
          value={trainPercent}
          onChange={(e) => setTrainPercent(e.target.value)}
        />
        <input
          placeholder="Validation %"
          inputMode="numeric"
          value={validationPercent}
          onChange={(e) => setValidationPercent(e.target.value)}
        />
        <input
          placeholder="Test %"
          inputMode="numeric"
          value={testPercent}
          onChange={(e) => setTestPercent(e.target.value)}
        />
        <input
          placeholder="Min examples per SKU"
          inputMode="numeric"
          value={minPerSku}
          onChange={(e) => setMinPerSku(e.target.value)}
        />
        <input
          placeholder="Min examples per action"
          inputMode="numeric"
          value={minPerAction}
          onChange={(e) => setMinPerAction(e.target.value)}
        />
        <input
          placeholder="Evaluation run id (optional)"
          value={sourceEvaluationRunId}
          onChange={(e) => setSourceEvaluationRunId(e.target.value)}
        />
        <input
          placeholder="Test protocol id (optional)"
          value={sourceTestProtocolId}
          onChange={(e) => setSourceTestProtocolId(e.target.value)}
        />
        <input
          placeholder="Calibration profile id (optional)"
          value={sourceCalibrationProfileId}
          onChange={(e) => setSourceCalibrationProfileId(e.target.value)}
        />
        <textarea
          placeholder="Notes (optional, screened — no URLs or paths)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <button
          className="primary"
          disabled={busy || !name.trim()}
          onClick={() => void createRun()}
        >
          Create run
        </button>
      </div>

      <h2>Runs ({(runs.data ?? []).length})</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Purpose</th>
            <th>Splits</th>
            <th>Minimums (SKU / action)</th>
            <th>Exported</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {(runs.data ?? []).map((run) => (
            <tr key={run.id}>
              <td>
                <Link to={`/cv-dataset-improvement/${run.id}`}>{run.name}</Link>
              </td>
              <td>
                <span className={`badge ${runStatusTone(run.status)}`}>
                  {run.status}
                </span>
              </td>
              <td>{run.purpose}</td>
              <td>
                {run.trainSplitPercent}/{run.validationSplitPercent}/
                {run.testSplitPercent}
              </td>
              <td>
                {run.minReviewedExamplesPerSku} /{' '}
                {run.minReviewedExamplesPerAction}
              </td>
              <td>{formatDate(run.exportedAt)}</td>
              <td>{formatDate(run.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(runs.data ?? []).length === 0 ? (
        <p className="muted">No dataset improvement runs yet.</p>
      ) : null}
    </Page>
  );
}

export function CvDatasetImprovementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] =
    useState<CvDatasetRefreshResult | null>(null);
  const [splitPlan, setSplitPlan] = useState<CvDatasetSplitPlanResult | null>(
    null,
  );
  const [manifestResult, setManifestResult] =
    useState<CvDatasetExportManifestResult | null>(null);
  const [copied, setCopied] = useState(false);

  const detail = useLoad<CvDatasetRunDetail>(
    () => api(`/cv-dataset-improvement-runs/${id}`),
    [id, tick],
  );
  const quality = useLoad<CvDatasetQualityReport>(
    () => api(`/cv-dataset-improvement-runs/${id}/quality-report`),
    [id, tick],
  );
  const tuning = useLoad<CvDatasetModelTuningReport>(
    () => api(`/cv-dataset-improvement-runs/${id}/model-tuning-report`),
    [id, tick],
  );

  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      setTick((n) => n + 1);
    } catch (err) {
      setActionError(formatDatasetErrorMessage(errorMessage(err)));
    } finally {
      setBusy(false);
    }
  }

  function downloadManifest(result: CvDatasetExportManifestResult) {
    const blob = new Blob([JSON.stringify(result.manifest, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cv-dataset-manifest-${id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyManifest(result: CvDatasetExportManifestResult) {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(result.manifest, null, 2),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError('Clipboard unavailable — use Download instead.');
    }
  }

  const run = detail.data ?? null;
  const manifestPreview = manifestResult
    ? JSON.stringify(manifestResult.manifest, null, 2)
    : null;

  return (
    <Page
      title="Dataset improvement run (shadow)"
      error={detail.error}
      loading={detail.loading && !detail.data}
    >
      {actionError ? <div className="error">{actionError}</div> : null}
      {run ? (
        <div className="detail">
          <div>
            <span className={`badge ${runStatusTone(run.status)}`}>
              {run.status}
            </span>{' '}
            <strong>{run.name}</strong>{' '}
            <span className="muted">{run.purpose}</span>
          </div>
          <p>
            <Link to="/cv-dataset-improvement">← All runs</Link>
          </p>
          <p className="muted">
            Splits {run.trainSplitPercent}/{run.validationSplitPercent}/
            {run.testSplitPercent} · minimums {run.minReviewedExamplesPerSku}{' '}
            per SKU, {run.minReviewedExamplesPerAction} per action · created{' '}
            {formatDate(run.createdAt)}
            {run.exportedAt ? ` · exported ${formatDate(run.exportedAt)}` : ''}
            {run.archivedAt ? ` · archived ${formatDate(run.archivedAt)}` : ''}
            {run.notes ? ` · ${run.notes}` : ''}
          </p>
          <p className="muted">
            Sources:{' '}
            {run.sourceEvaluationRunId ? (
              <Link to={`/pilot-evaluations/${run.sourceEvaluationRunId}`}>
                evaluation run
              </Link>
            ) : (
              'no evaluation run'
            )}
            {' · '}
            {run.sourceTestProtocolId ? (
              <Link to={`/cv-test-protocols/${run.sourceTestProtocolId}`}>
                test protocol
              </Link>
            ) : (
              'no test protocol'
            )}
            {' · '}
            {run.sourceCalibrationProfileId ? (
              <Link to="/camera-calibration">calibration profile</Link>
            ) : (
              'no calibration profile'
            )}
          </p>

          <div className="form-row">
            <button
              disabled={
                busy || run.status === 'ARCHIVED' || run.status === 'EXPORTED'
              }
              onClick={() =>
                void action(async () => {
                  setRefreshResult(
                    await api<CvDatasetRefreshResult>(
                      `/cv-dataset-improvement-runs/${id}/candidates/refresh`,
                      { method: 'POST' },
                    ),
                  );
                })
              }
            >
              Refresh candidates
            </button>
            <button
              disabled={
                busy || run.status === 'ARCHIVED' || run.status === 'EXPORTED'
              }
              onClick={() =>
                void action(async () => {
                  setSplitPlan(
                    await api<CvDatasetSplitPlanResult>(
                      `/cv-dataset-improvement-runs/${id}/plan-splits`,
                      { method: 'POST' },
                    ),
                  );
                })
              }
            >
              Plan splits
            </button>
            {run.status === 'DRAFT' ? (
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    api(`/cv-dataset-improvement-runs/${id}/status`, {
                      method: 'POST',
                      body: { status: 'READY' },
                    }),
                  )
                }
              >
                Mark READY
              </button>
            ) : null}
            {run.status === 'READY' || run.status === 'EXPORTED' ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    setManifestResult(
                      await api<CvDatasetExportManifestResult>(
                        `/cv-dataset-improvement-runs/${id}/export-manifest`,
                        { method: 'POST' },
                      ),
                    );
                  })
                }
              >
                Export manifest
              </button>
            ) : null}
            {run.status !== 'ARCHIVED' ? (
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    api(`/cv-dataset-improvement-runs/${id}/status`, {
                      method: 'POST',
                      body: { status: 'ARCHIVED' },
                    }),
                  )
                }
              >
                Archive
              </button>
            ) : null}
          </div>
          {run.status === 'EXPORTED' ? (
            <p className="muted">
              This run is exported and frozen — candidates and splits can no
              longer change. Re-exporting reproduces the same dataset;
              start a new run to build a different one.
            </p>
          ) : null}

          <h2>Candidates</h2>
          <p>
            Total {run.candidateSummary.total} · eligible{' '}
            {run.candidateSummary.eligible} · excluded{' '}
            {run.candidateSummary.excluded}
          </p>
          <p className="muted">
            By split — train {run.candidateSummary.bySplit.TRAIN} · validation{' '}
            {run.candidateSummary.bySplit.VALIDATION} · test{' '}
            {run.candidateSummary.bySplit.TEST} · holdout{' '}
            {run.candidateSummary.bySplit.HOLDOUT} · unplanned{' '}
            {run.candidateSummary.bySplit.UNPLANNED}
          </p>
          {refreshResult ? (
            <p className="muted">
              Last refresh: {refreshResult.total} candidates (
              {refreshResult.eligible} eligible, {refreshResult.excluded}{' '}
              excluded). Only reviewed/corrected examples are eligible —
              pending and unreviewed data is excluded by design.
            </p>
          ) : (
            <p className="muted">
              Candidates come only from reviewed/corrected pilot data — use
              Refresh candidates to (re)build them from the linked sources.
            </p>
          )}

          <h2>Quality report</h2>
          {quality.data ? (
            <>
              <p>
                <span
                  className={`badge ${datasetReadinessTone(quality.data.readiness)}`}
                >
                  {quality.data.readiness}
                </span>{' '}
                <span className="muted">
                  {quality.data.totalEligibleExamples} eligible ·{' '}
                  {quality.data.totalExcludedExamples} excluded · missed events{' '}
                  {quality.data.missedEventCount} · false touches{' '}
                  {quality.data.falseTouchCount}
                </span>
              </p>
              {quality.data.examplesBySku.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Examples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quality.data.examplesBySku.map((row) => (
                      <tr key={row.sku}>
                        <td>{row.sku}</td>
                        <td>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">No SKU-labelled examples yet.</p>
              )}
              {quality.data.examplesByAction.length > 0 ? (
                <p className="muted">
                  By action:{' '}
                  {quality.data.examplesByAction
                    .map((row) => `${row.action} ${row.count}`)
                    .join(' · ')}
                </p>
              ) : null}
              {quality.data.examplesBySourceType.length > 0 ? (
                <p className="muted">
                  By source:{' '}
                  {quality.data.examplesBySourceType
                    .map((row) => `${row.sourceType} ${row.count}`)
                    .join(' · ')}
                </p>
              ) : null}
              {quality.data.examplesByScenarioType.length > 0 ? (
                <p className="muted">
                  By scenario:{' '}
                  {quality.data.examplesByScenarioType
                    .map((row) => `${row.scenarioType} ${row.count}`)
                    .join(' · ')}
                </p>
              ) : null}
              {quality.data.lowCoverageSkus.length > 0 ? (
                <p className="muted">
                  Low-coverage SKUs (examples/min · independent groups):{' '}
                  {quality.data.lowCoverageSkus
                    .map(
                      (row) =>
                        `${row.sku} (${row.count}/${row.minimum} · ${row.groups} groups)`,
                    )
                    .join(' · ')}
                </p>
              ) : null}
              {quality.data.lowCoverageActions.length > 0 ? (
                <p className="muted">
                  Low-coverage actions (examples/min · independent groups):{' '}
                  {quality.data.lowCoverageActions
                    .map(
                      (row) =>
                        `${row.action} (${row.count}/${row.minimum} · ${row.groups} groups)`,
                    )
                    .join(' · ')}
                </p>
              ) : null}
              {quality.data.confusionPairs &&
              (quality.data.confusionPairs.action.length > 0 ||
                quality.data.confusionPairs.sku.length > 0) ? (
                <table>
                  <thead>
                    <tr>
                      <th>Confusion</th>
                      <th>Predicted</th>
                      <th>Expected</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quality.data.confusionPairs.action.map((pair) => (
                      <tr key={`a-${pair.predicted}-${pair.expected}`}>
                        <td>action</td>
                        <td>{pair.predicted}</td>
                        <td>{pair.expected}</td>
                        <td>{pair.count}</td>
                      </tr>
                    ))}
                    {quality.data.confusionPairs.sku.map((pair) => (
                      <tr key={`s-${pair.predicted}-${pair.expected}`}>
                        <td>sku</td>
                        <td>{pair.predicted}</td>
                        <td>{pair.expected}</td>
                        <td>{pair.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">Confusion pairs: unknown yet.</p>
              )}
              {[...quality.data.imbalanceWarnings, ...quality.data.leakageWarnings]
                .length > 0 ? (
                <ul>
                  {[
                    ...quality.data.imbalanceWarnings,
                    ...quality.data.leakageWarnings,
                  ].map((warning) => (
                    <li key={warning} className="muted">
                      {formatDatasetWarning(warning)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No imbalance or leakage warnings.</p>
              )}
              {quality.data.recommendedNextActions.length > 0 ? (
                <>
                  <p>Recommended next actions:</p>
                  <ul>
                    {quality.data.recommendedNextActions.map((next) => (
                      <li key={next}>{formatDatasetAction(next)}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : quality.error ? (
            <p className="muted">Quality report unavailable.</p>
          ) : (
            <p className="muted">Loading…</p>
          )}

          <h2>Split plan</h2>
          {splitPlan ? (
            <>
              <p>
                train {splitPlan.splitSummary.TRAIN} · validation{' '}
                {splitPlan.splitSummary.VALIDATION} · test{' '}
                {splitPlan.splitSummary.TEST} · holdout{' '}
                {splitPlan.splitSummary.HOLDOUT} · {splitPlan.groupCount}{' '}
                session groups
              </p>
              {splitPlan.warnings.length > 0 ? (
                <ul>
                  {splitPlan.warnings.map((warning) => (
                    <li key={warning} className="muted">
                      {formatDatasetWarning(warning)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No split warnings.</p>
              )}
            </>
          ) : (
            <p className="muted">
              Splits are deterministic (stable per run and example) and keep
              examples from one live session together. Use Plan splits above.
            </p>
          )}

          <h2>Export manifest</h2>
          {manifestResult && manifestPreview ? (
            <>
              <p className="muted">
                v{manifestResult.manifestVersion} · {manifestResult.rowCount}{' '}
                rows · generated {formatDate(manifestResult.generatedAt)} —
                metadata and safe IDs only, no raw media, URLs, paths, or
                credentials.
              </p>
              <div className="form-row">
                <button
                  className="primary"
                  onClick={() => downloadManifest(manifestResult)}
                >
                  Download JSON
                </button>
                <button onClick={() => void copyManifest(manifestResult)}>
                  {copied ? 'Copied!' : 'Copy JSON'}
                </button>
              </div>
              <pre
                style={{
                  maxHeight: '20rem',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {manifestPreview.length > MANIFEST_PREVIEW_LIMIT
                  ? `${manifestPreview.slice(0, MANIFEST_PREVIEW_LIMIT)}\n… (truncated preview — download for the full manifest)`
                  : manifestPreview}
              </pre>
            </>
          ) : (
            <p className="muted">
              {run.status === 'DRAFT'
                ? 'Mark the run READY, then export the manifest.'
                : 'Use Export manifest above to generate the offline training package.'}
            </p>
          )}

          <h2>Model tuning recommendation</h2>
          {tuning.data ? (
            <>
              <p>
                Task: <strong>{tuning.data.recommendedModelTask}</strong> ·
                dataset{' '}
                <span
                  className={`badge ${datasetReadinessTone(tuning.data.datasetReadiness)}`}
                >
                  {tuning.data.datasetReadiness}
                </span>{' '}
                · tuning{' '}
                <span
                  className={`badge ${datasetReadinessTone(tuning.data.tuningReadiness)}`}
                >
                  {tuning.data.tuningReadiness}
                </span>
              </p>
              <p className="muted">
                Coverage: {tuning.data.classCoverageSummary.skuClasses} SKU
                classes ({tuning.data.classCoverageSummary.belowMinimumSkus}{' '}
                below minimum) ·{' '}
                {tuning.data.classCoverageSummary.actionClasses} action classes
                ({tuning.data.classCoverageSummary.belowMinimumActions} below
                minimum)
              </p>
              {tuning.data.warnings.length > 0 ? (
                <ul>
                  {tuning.data.warnings.map((warning) => (
                    <li key={warning} className="muted">
                      {formatDatasetWarning(warning)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {tuning.data.likelyConfusionPairs.length > 0 ? (
                <p className="muted">
                  Likely confusion:{' '}
                  {tuning.data.likelyConfusionPairs
                    .map(
                      (pair) =>
                        `${pair.predicted} vs ${pair.expected} (${pair.count})`,
                    )
                    .join(' · ')}
                </p>
              ) : (
                <p className="muted">Likely confusion pairs: unknown yet.</p>
              )}
              {tuning.data.suggestedCollectionPlan.length > 0 ? (
                <>
                  <p>Suggested collection plan:</p>
                  <ul>
                    {tuning.data.suggestedCollectionPlan.map((item) => (
                      <li key={item} className="muted">
                        {item}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {tuning.data.suggestedEvaluationMetrics.length > 0 ? (
                <p className="muted">
                  Suggested evaluation metrics:{' '}
                  {tuning.data.suggestedEvaluationMetrics.join(' · ')}
                </p>
              ) : null}
              <p className="muted">
                Holdout: {tuning.data.suggestedHoldoutPlan.holdoutCount}{' '}
                examples — {tuning.data.suggestedHoldoutPlan.note}
              </p>
              <p className="muted">
                Threshold review{' '}
                {tuning.data.recommendedThresholdReview.suggested
                  ? 'suggested'
                  : 'not needed yet'}{' '}
                — {tuning.data.recommendedThresholdReview.note}
              </p>
              {tuning.data.recommendedNextActions.length > 0 ? (
                <ul>
                  {tuning.data.recommendedNextActions.map((next) => (
                    <li key={next}>{formatDatasetAction(next)}</li>
                  ))}
                </ul>
              ) : null}
              <p className="muted">{tuning.data.advisory}</p>
            </>
          ) : tuning.error ? (
            <p className="muted">Model tuning report unavailable.</p>
          ) : (
            <p className="muted">Loading…</p>
          )}

          <p className="muted">
            Shadow mode — dataset improvement is advisory metadata only. It
            never trains a model, creates checkout sessions, orders, payments,
            or inventory movements, and never stores or exports raw media,
            stream URLs, file paths, credentials, or model weights.
          </p>
        </div>
      ) : null}
    </Page>
  );
}
