import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, Paginated, PaymentIntent, PaymentStatus } from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const INTENT_STATUSES: (PaymentStatus | '')[] = [
  '',
  'CREATED',
  'REQUIRES_AUTHORIZATION',
  'AUTHORIZED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'VOIDED',
  'EXPIRED',
];

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/**
 * SIMULATION-ONLY banner. This admin surface never collects card numbers,
 * CVV, or PIN, never shows "live payment captured", and only drives the
 * provider-abstract state machine.
 */
function SimulationNotice() {
  return (
    <div className="muted" style={{ margin: '0.25rem 0 1rem' }}>
      ⚠️ Provider-abstract simulation only — no live payment gateway is
      integrated. Authorization and capture are simulated; no card numbers,
      CVV, or PIN are ever collected or stored.
    </div>
  );
}

export function PaymentsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const [amount, setAmount] = useState('1000');
  const [currency, setCurrency] = useState('SAR');
  const [orderId, setOrderId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data, error, loading } = useLoad<Paginated<PaymentIntent>>(
    () =>
      api(
        `/payments/intents?skip=${skip}&take=${take}` +
          (status ? `&status=${status}` : ''),
      ),
    [status, skip],
  );

  async function createIntent(event: FormEvent) {
    event.preventDefault();
    const amountMinor = Number(amount);
    if (!Number.isInteger(amountMinor) || amountMinor < 0) {
      setCreateError('Amount must be a whole number of minor units (≥ 0).');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const intent = await api<PaymentIntent>('/payments/intents', {
        method: 'POST',
        body: {
          amountMinor,
          currencyCode: currency.trim().toUpperCase(),
          orderId: orderId.trim() || undefined,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      navigate(`/payments/${intent.id}`);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Page title="Payments" error={error} loading={loading}>
      <SimulationNotice />
      <form className="toolbar" onSubmit={(e) => void createIntent(e)}>
        <input
          type="number"
          min={0}
          step={1}
          style={{ width: '8rem' }}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Amount (minor units)"
          placeholder="Amount (minor)"
        />
        <input
          style={{ width: '5rem' }}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          aria-label="Currency code"
          placeholder="SAR"
        />
        <input
          style={{ width: '16rem' }}
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          aria-label="Order id (optional)"
          placeholder="Order id (optional)"
        />
        <button className="primary" type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'New intent'}
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
          {INTENT_STATUSES.map((value) => (
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
            <th>Intent</th>
            <th>Status</th>
            <th>Amount</th>
            <th>Provider</th>
            <th>Order</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((intent) => (
            <tr key={intent.id}>
              <td>
                <Link to={`/payments/${intent.id}`}>{intent.id}</Link>
              </td>
              <td>
                <StatusBadge status={intent.status} />
              </td>
              <td>
                {intent.amountMinor} {intent.currencyCode}
              </td>
              <td>{intent.provider}</td>
              <td>
                {intent.order ? (
                  <Link to={`/orders/${intent.order.id}`}>
                    {intent.order.orderNumber}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{formatDate(intent.createdAt)}</td>
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

const AUTHORIZABLE: PaymentStatus[] = ['CREATED', 'REQUIRES_AUTHORIZATION'];
const CAPTURABLE: PaymentStatus[] = ['AUTHORIZED', 'CAPTURE_PENDING'];
const TERMINAL: PaymentStatus[] = [
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'VOIDED',
  'EXPIRED',
];

export function PaymentIntentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, loading } = useLoad<PaymentIntent>(
    () => api(`/payments/intents/${id}`),
    [id, reload],
  );

  async function run(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/payments/intents/${id}/${path}`, { method: 'POST', body });
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const st = data?.status;
  const canAuthorize = st ? AUTHORIZABLE.includes(st) : false;
  const canCapture = st ? CAPTURABLE.includes(st) : false;
  const canCancel = st ? !TERMINAL.includes(st) && st !== 'CAPTURE_PENDING' : false;
  const canFail = st ? !TERMINAL.includes(st) : false;

  return (
    <Page title="Payment intent" error={error} loading={loading}>
      {data ? (
        <div className="detail">
          <SimulationNotice />
          {actionError ? <div className="error">{actionError}</div> : null}
          <div className="toolbar">
            <button
              className="primary"
              disabled={busy || !canAuthorize}
              onClick={() =>
                void run('authorize', { idempotencyKey: crypto.randomUUID() })
              }
            >
              Simulate authorize
            </button>
            <button
              className="primary"
              disabled={busy || !canCapture}
              onClick={() =>
                void run('capture', { idempotencyKey: crypto.randomUUID() })
              }
            >
              Simulate capture
            </button>
            <button
              disabled={busy || !canCancel}
              onClick={() => void run('cancel')}
            >
              Cancel / void
            </button>
            <button disabled={busy || !canFail} onClick={() => void run('fail')}>
              Simulate failure
            </button>
          </div>
          <dl>
            <dt>Intent ID</dt>
            <dd>{data.id}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} /> (simulated)
            </dd>
            <dt>Amount</dt>
            <dd>
              {data.amountMinor} {data.currencyCode} (minor units)
            </dd>
            <dt>Captured amount</dt>
            <dd>
              {data.capturedAmountMinor} {data.currencyCode}
            </dd>
            <dt>Provider</dt>
            <dd>{data.provider}</dd>
            <dt>Order</dt>
            <dd>
              {data.order ? (
                <Link to={`/orders/${data.order.id}`}>
                  {data.order.orderNumber} — payment {data.order.paymentStatus}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Checkout session</dt>
            <dd>
              {data.session ? (
                <Link to={`/checkout-sessions/${data.session.id}`}>
                  {data.session.id}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Provider ref</dt>
            <dd>{data.providerRef ?? '—'}</dd>
            <dt>Card metadata (safe)</dt>
            <dd>
              {[
                data.instrumentBrand,
                data.instrumentLast4 ? `•••• ${data.instrumentLast4}` : null,
                data.instrumentWallet,
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </dd>
            <dt>Failure reason</dt>
            <dd>{data.failureReason ?? '—'}</dd>
            <dt>Authorized</dt>
            <dd>{formatDate(data.authorizedAt)}</dd>
            <dt>Captured</dt>
            <dd>{formatDate(data.capturedAt)}</dd>
            <dt>Created</dt>
            <dd>{formatDate(data.createdAt)}</dd>
          </dl>

          <h1 style={{ marginTop: '1.5rem' }}>
            Captures ({data.captures?.length ?? 0})
          </h1>
          <table>
            <thead>
              <tr>
                <th>Capture</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Captured</th>
              </tr>
            </thead>
            <tbody>
              {data.captures?.map((capture) => (
                <tr key={capture.id}>
                  <td>{capture.id}</td>
                  <td>
                    <StatusBadge status={capture.status} />
                  </td>
                  <td>{capture.amountMinor}</td>
                  <td>{formatDate(capture.capturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h1 style={{ marginTop: '1.5rem' }}>
            Provider events ({data.events?.length ?? 0})
          </h1>
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Type</th>
                <th>Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {data.events?.map((event) => (
                <tr key={event.id}>
                  <td>{event.providerEventId}</td>
                  <td>{event.eventType}</td>
                  <td>
                    <StatusBadge status={event.status} />
                  </td>
                  <td>{formatDate(event.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h1 style={{ marginTop: '1.5rem' }}>
            Reconciliation ({data.reconciliationRecords?.length ?? 0})
          </h1>
          <table>
            <thead>
              <tr>
                <th>Record</th>
                <th>Status</th>
                <th>Expected</th>
                <th>Reported</th>
              </tr>
            </thead>
            <tbody>
              {data.reconciliationRecords?.map((record) => (
                <tr key={record.id}>
                  <td>
                    <Link to={`/reconciliation/${record.id}`}>{record.id}</Link>
                  </td>
                  <td>
                    <StatusBadge status={record.status} />
                  </td>
                  <td>{record.expectedAmountMinor ?? '—'}</td>
                  <td>{record.reportedAmountMinor ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
