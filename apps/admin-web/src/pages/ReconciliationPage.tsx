import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  Paginated,
  ReconciliationRecord,
  ReconciliationStatus,
} from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const RECON_STATUSES: (ReconciliationStatus | '')[] = [
  '',
  'PENDING',
  'MATCHED',
  'MISMATCH',
  'RECONCILED',
  'FAILED',
];

const SETTABLE: ReconciliationStatus[] = [
  'MATCHED',
  'MISMATCH',
  'RECONCILED',
  'FAILED',
];

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

export function ReconciliationPage() {
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const { data, error, loading } = useLoad<Paginated<ReconciliationRecord>>(
    () =>
      api(
        `/reconciliation/records?skip=${skip}&take=${take}` +
          (status ? `&status=${status}` : ''),
      ),
    [status, skip],
  );

  return (
    <Page title="Reconciliation" error={error} loading={loading}>
      <div className="muted" style={{ margin: '0.25rem 0 1rem' }}>
        ⚠️ Reconciliation FOUNDATION — a PENDING record is seeded when a payment
        is captured. No settlement accounting, provider import, or Zoho
        integration in this phase.
      </div>
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setSkip(0);
            setStatus(e.target.value);
          }}
        >
          {RECON_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value || 'Any status'}
            </option>
          ))}
        </select>
        <span className="muted">{data?.total ?? 0} total</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Record</th>
            <th>Status</th>
            <th>Intent</th>
            <th>Expected</th>
            <th>Reported</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((record) => (
            <tr key={record.id}>
              <td>
                <Link to={`/reconciliation/${record.id}`}>{record.id}</Link>
              </td>
              <td>
                <StatusBadge status={record.status} />
              </td>
              <td>
                {record.intentId ? (
                  <Link to={`/payments/${record.intentId}`}>
                    {record.intentId}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{record.expectedAmountMinor ?? '—'}</td>
              <td>{record.reportedAmountMinor ?? '—'}</td>
              <td>{formatDate(record.createdAt)}</td>
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

export function ReconciliationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reported, setReported] = useState('');
  const [notes, setNotes] = useState('');

  const { data, error, loading } = useLoad<ReconciliationRecord>(
    () => api(`/reconciliation/records/${id}`),
    [id, reload],
  );

  const terminal = data?.status === 'RECONCILED';

  async function setStatusTo(next: ReconciliationStatus) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/reconciliation/records/${id}`, {
        method: 'PATCH',
        body: {
          status: next,
          reportedAmountMinor: reported.trim()
            ? Number(reported)
            : undefined,
          notes: notes.trim() || undefined,
        },
      });
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Reconciliation record" error={error} loading={loading}>
      {data ? (
        <div className="detail">
          {actionError ? <div className="error">{actionError}</div> : null}
          <dl>
            <dt>Record ID</dt>
            <dd>{data.id}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Intent</dt>
            <dd>
              {data.intentId ? (
                <Link to={`/payments/${data.intentId}`}>{data.intentId}</Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Expected amount</dt>
            <dd>
              {data.expectedAmountMinor ?? '—'} {data.currencyCode ?? ''}
            </dd>
            <dt>Reported amount</dt>
            <dd>{data.reportedAmountMinor ?? '—'}</dd>
            <dt>Notes</dt>
            <dd>{data.notes ?? '—'}</dd>
            <dt>Reconciled</dt>
            <dd>{formatDate(data.reconciledAt)}</dd>
            <dt>Created</dt>
            <dd>{formatDate(data.createdAt)}</dd>
          </dl>

          {terminal ? (
            <p className="muted">
              This record is RECONCILED (terminal) and cannot change again.
            </p>
          ) : (
            <>
              <h1 style={{ marginTop: '1.5rem' }}>Manual reconciliation</h1>
              <div className="toolbar">
                <input
                  type="number"
                  min={0}
                  step={1}
                  style={{ width: '10rem' }}
                  value={reported}
                  onChange={(e) => setReported(e.target.value)}
                  placeholder="Reported (minor)"
                  aria-label="Reported amount"
                />
                <input
                  style={{ width: '18rem' }}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Note (optional)"
                  aria-label="Note"
                />
              </div>
              <div className="toolbar">
                {SETTABLE.map((next) => (
                  <button
                    key={next}
                    disabled={busy}
                    className={next === 'RECONCILED' ? 'primary' : ''}
                    onClick={() => void setStatusTo(next)}
                  >
                    {next}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </Page>
  );
}
