import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, InferenceJob, Paginated } from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const JOB_STATUSES = ['', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

const JOB_TYPES = [
  '',
  'TRACKING_EVENT',
  'SHELF_AUDIT',
  'PRODUCT_RECOGNITION',
  'OCR_REVIEW',
  'VLM_REVIEW',
  'EXIT_RECONCILIATION',
];

const EVENT_TYPES = [
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'PRODUCT_TRANSFER',
  'CART_INSERTION',
  'EXIT_RECONCILIATION',
];

const EVIDENCE_QUALITIES = ['', 'LOW', 'MEDIUM', 'HIGH'];

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

export function InferenceJobsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [jobType, setJobType] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const [newJobType, setNewJobType] = useState('PRODUCT_RECOGNITION');
  const [newPriority, setNewPriority] = useState('100');
  const [newSessionId, setNewSessionId] = useState('');
  const [newLocationId, setNewLocationId] = useState('');
  const [newUnitId, setNewUnitId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data, error, loading } = useLoad<Paginated<InferenceJob>>(
    () =>
      api(
        `/inference/jobs?skip=${skip}&take=${take}` +
          (status ? `&status=${status}` : '') +
          (jobType ? `&jobType=${jobType}` : ''),
      ),
    [status, jobType, skip],
  );

  async function createJob(event: FormEvent) {
    event.preventDefault();
    const priority = Number(newPriority);
    if (!Number.isInteger(priority)) {
      setCreateError('Priority must be a whole number.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const job = await api<InferenceJob>('/inference/jobs', {
        method: 'POST',
        body: {
          jobType: newJobType,
          priority,
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          ...(newLocationId ? { locationId: newLocationId } : {}),
          ...(newUnitId ? { unitId: newUnitId } : {}),
          idempotencyKey: crypto.randomUUID(),
        },
      });
      navigate(`/inference/${job.id}`);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Page title="Inference jobs" error={error} loading={loading}>
      <form className="toolbar" onSubmit={(e) => void createJob(e)}>
        <select
          value={newJobType}
          onChange={(e) => setNewJobType(e.target.value)}
        >
          {JOB_TYPES.filter(Boolean).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          type="number"
          step={1}
          style={{ width: '6rem' }}
          title="Priority (higher runs first)"
          value={newPriority}
          onChange={(e) => setNewPriority(e.target.value)}
        />
        <input
          type="text"
          placeholder="Checkout session id (optional)"
          style={{ minWidth: '14rem' }}
          value={newSessionId}
          onChange={(e) => setNewSessionId(e.target.value)}
        />
        <input
          type="text"
          placeholder="Store id (needed to convert)"
          style={{ minWidth: '12rem' }}
          title="Converting a result to a CV event requires the job to carry a store and a unit"
          value={newLocationId}
          onChange={(e) => setNewLocationId(e.target.value)}
        />
        <input
          type="text"
          placeholder="Unit id (needed to convert)"
          style={{ minWidth: '12rem' }}
          title="Converting a result to a CV event requires the job to carry a store and a unit"
          value={newUnitId}
          onChange={(e) => setNewUnitId(e.target.value)}
        />
        <button className="primary" type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'New simulated job'}
        </button>
      </form>
      {createError ? <div className="error">{createError}</div> : null}
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setSkip(0);
            setStatus(e.target.value);
          }}
        >
          {JOB_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value || 'Any status'}
            </option>
          ))}
        </select>
        <select
          value={jobType}
          onChange={(e) => {
            setSkip(0);
            setJobType(e.target.value);
          }}
        >
          {JOB_TYPES.map((value) => (
            <option key={value} value={value}>
              {value || 'Any type'}
            </option>
          ))}
        </select>
        <span className="muted">{data?.total ?? 0} total</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Type</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Requested</th>
            <th>Session</th>
            <th>Adapter</th>
            <th>CV event</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((job) => (
            <tr key={job.id}>
              <td>
                <Link to={`/inference/${job.id}`}>{job.id}</Link>
              </td>
              <td>{job.jobType}</td>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td>{job.priority}</td>
              <td>{formatDate(job.requestedAt)}</td>
              <td>
                {job.sessionId ? (
                  <Link to={`/checkout-sessions/${job.sessionId}`}>
                    {job.sessionId}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{job.adapterKey ?? '—'}</td>
              <td>
                {job.visionEventId ? (
                  <Link to={`/vision-events/${job.visionEventId}`}>yes</Link>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - take))}>
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

/** MVP simulated-completion form: up to three detection rows. */
const EMPTY_DETECTIONS = [
  { sku: '', confidence: '', label: '' },
  { sku: '', confidence: '', label: '' },
  { sku: '', confidence: '', label: '' },
];

export function InferenceJobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [eventType, setEventType] = useState('PRODUCT_PICKUP');
  const [quantityDelta, setQuantityDelta] = useState('1');
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString());
  const [evidenceQuality, setEvidenceQuality] = useState('');
  const [detections, setDetections] = useState(EMPTY_DETECTIONS);
  const [errorCode, setErrorCode] = useState('');

  const { data, error, loading } = useLoad<InferenceJob>(
    () => api(`/inference/jobs/${id}`),
    [id, reload],
  );

  function setDetection(
    index: number,
    field: 'sku' | 'confidence' | 'label',
    value: string,
  ) {
    setDetections((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/inference/jobs/${id}${path}`, {
        method: 'POST',
        ...(body !== undefined ? { body } : {}),
      });
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function complete(event: FormEvent) {
    event.preventDefault();
    const delta = Number(quantityDelta);
    if (!Number.isInteger(delta) || delta === 0) {
      setActionError('Quantity delta must be a nonzero whole number.');
      return;
    }
    if (Number.isNaN(Date.parse(occurredAt))) {
      setActionError('Occurred-at must be an ISO 8601 timestamp.');
      return;
    }
    const rows = detections.filter((row) => row.sku.trim());
    const basketAffecting = [
      'PRODUCT_PICKUP',
      'CART_INSERTION',
      'PRODUCT_RETURN',
    ].includes(eventType);
    if (!rows.length && basketAffecting) {
      setActionError(
        'Add at least one detection (SKU + confidence) for a basket-' +
          'affecting event type.',
      );
      return;
    }
    const parsed = rows.map((row) => ({
      sku: row.sku.trim(),
      confidence: Number(row.confidence),
      ...(row.label.trim() ? { label: row.label.trim() } : {}),
    }));
    if (parsed.some((row) => !(row.confidence >= 0 && row.confidence <= 1))) {
      setActionError('Each confidence must be a number between 0 and 1.');
      return;
    }
    await act('/complete', {
      eventType,
      quantityDelta: delta,
      occurredAt,
      detections: parsed,
      ...(evidenceQuality ? { evidenceQuality } : {}),
    });
    setDetections(EMPTY_DETECTIONS);
  }

  async function fail(event: FormEvent) {
    event.preventDefault();
    if (!errorCode.trim()) {
      setActionError('Enter an error code (e.g. LOW_CONFIDENCE).');
      return;
    }
    await act('/fail', { errorCode: errorCode.trim().toUpperCase() });
    setErrorCode('');
  }

  const queued = data?.status === 'QUEUED';
  const running = data?.status === 'RUNNING';
  const convertible = data?.status === 'SUCCEEDED' && !data.visionEventId;

  return (
    <Page title="Inference job" error={error} loading={loading}>
      {data ? (
        <div className="detail">
          {actionError ? <div className="error">{actionError}</div> : null}
          {queued || running || convertible ? (
            <div className="toolbar">
              {queued ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void act('/start', {})}
                >
                  Start (simulated)
                </button>
              ) : null}
              {convertible ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void act('/to-vision-event')}
                >
                  Convert to CV event
                </button>
              ) : null}
            </div>
          ) : null}
          {running ? (
            <form className="toolbar" onSubmit={(e) => void complete(e)}>
              <select
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
              >
                {EVENT_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <input
                type="number"
                step={1}
                style={{ width: '6rem' }}
                title="Quantity delta (negative only for PRODUCT_RETURN)"
                value={quantityDelta}
                onChange={(e) => setQuantityDelta(e.target.value)}
              />
              <input
                type="text"
                style={{ minWidth: '15rem' }}
                title="When the interaction happened per the source (ISO 8601) — not when inference ran"
                placeholder="Occurred at (ISO 8601)"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
              />
              <select
                value={evidenceQuality}
                onChange={(e) => setEvidenceQuality(e.target.value)}
              >
                {EVIDENCE_QUALITIES.map((value) => (
                  <option key={value} value={value}>
                    {value || 'Evidence quality…'}
                  </option>
                ))}
              </select>
              <button className="primary" type="submit" disabled={busy}>
                Complete (simulated)
              </button>
            </form>
          ) : null}
          {running ? (
            <>
              {detections.map((row, index) => (
                <div className="toolbar" key={index}>
                  <input
                    type="text"
                    placeholder={`Detection ${index + 1} SKU${index === 0 ? '' : ' (optional)'}`}
                    style={{ minWidth: '12rem' }}
                    value={row.sku}
                    onChange={(e) => setDetection(index, 'sku', e.target.value)}
                  />
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    placeholder="Confidence 0–1"
                    style={{ width: '9rem' }}
                    value={row.confidence}
                    onChange={(e) =>
                      setDetection(index, 'confidence', e.target.value)
                    }
                  />
                  <input
                    type="text"
                    placeholder="Label (optional)"
                    style={{ minWidth: '12rem' }}
                    value={row.label}
                    onChange={(e) => setDetection(index, 'label', e.target.value)}
                  />
                </div>
              ))}
            </>
          ) : null}
          {queued || running ? (
            <form className="toolbar" onSubmit={(e) => void fail(e)}>
              <input
                type="text"
                placeholder="Error code (e.g. LOW_CONFIDENCE)"
                style={{ minWidth: '14rem' }}
                value={errorCode}
                onChange={(e) => setErrorCode(e.target.value)}
              />
              <button type="submit" disabled={busy}>
                Fail job
              </button>
            </form>
          ) : null}
          <dl>
            <dt>Job ID</dt>
            <dd>{data.id}</dd>
            <dt>Type</dt>
            <dd>{data.jobType}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Priority</dt>
            <dd>{data.priority}</dd>
            <dt>Attempts</dt>
            <dd>{data.attempts}</dd>
            <dt>Requested</dt>
            <dd>{formatDate(data.requestedAt)}</dd>
            <dt>Started</dt>
            <dd>{formatDate(data.startedAt)}</dd>
            <dt>Completed</dt>
            <dd>{formatDate(data.completedAt)}</dd>
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
            <dt>Source</dt>
            <dd>
              {[data.sourceType, data.sourceId].filter(Boolean).join(' · ')}
            </dd>
            <dt>Adapter</dt>
            <dd>{data.adapterKey ?? '—'}</dd>
            <dt>Error</dt>
            <dd>
              {data.errorCode
                ? `${data.errorCode}${data.errorMessage ? ` — ${data.errorMessage}` : ''}`
                : '—'}
            </dd>
            <dt>CV event</dt>
            <dd>
              {data.visionEventId ? (
                <Link to={`/vision-events/${data.visionEventId}`}>
                  {data.visionEventId}
                </Link>
              ) : (
                '—'
              )}
            </dd>
          </dl>

          {data.result ? (
            <>
              <h1 style={{ marginTop: '1.5rem' }}>Result</h1>
              <dl>
                <dt>Suggested event type</dt>
                <dd>{data.result.eventType}</dd>
                <dt>Quantity delta</dt>
                <dd>{data.result.quantityDelta}</dd>
                <dt>Occurred</dt>
                <dd>{formatDate(data.result.occurredAt)}</dd>
                <dt>Evidence score</dt>
                <dd>{data.result.evidenceScore ?? '—'}</dd>
                <dt>Evidence quality</dt>
                <dd>{data.result.evidenceQuality ?? '—'}</dd>
                <dt>Model</dt>
                <dd>
                  {data.result.modelKey
                    ? `${data.result.modelKey}${
                        data.result.modelVersion
                          ? ` @ ${data.result.modelVersion}`
                          : ''
                      }`
                    : '—'}
                </dd>
                <dt>Produced</dt>
                <dd>{formatDate(data.result.createdAt)}</dd>
              </dl>
              <h2 style={{ marginTop: '1rem' }}>
                Candidate SKUs ({data.result.candidates.length})
              </h2>
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>SKU</th>
                    <th>Label</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.result.candidates.map((candidate) => (
                    <tr key={candidate.id}>
                      <td>{candidate.rank}</td>
                      <td>{candidate.sku}</td>
                      <td>{candidate.label ?? '—'}</td>
                      <td>{candidate.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}
