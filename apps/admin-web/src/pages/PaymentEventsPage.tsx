import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  Paginated,
  PaymentEvent,
  PaymentEventType,
} from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const EVENT_TYPES: PaymentEventType[] = [
  'AUTHORIZATION_SUCCEEDED',
  'AUTHORIZATION_FAILED',
  'CAPTURE_SUCCEEDED',
  'CAPTURE_FAILED',
  'PAYMENT_CANCELLED',
  'PAYMENT_VOIDED',
  'PAYMENT_EXPIRED',
  'UNKNOWN',
];

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

export function PaymentEventsPage() {
  const [skip, setSkip] = useState(0);
  const [reload, setReload] = useState(0);
  const take = 25;

  const [eventType, setEventType] =
    useState<PaymentEventType>('CAPTURE_SUCCEEDED');
  const [providerEventId, setProviderEventId] = useState('');
  const [intentId, setIntentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { data, error, loading } = useLoad<Paginated<PaymentEvent>>(
    () => api(`/payment-events?skip=${skip}&take=${take}`),
    [skip, reload],
  );

  async function simulate(event: FormEvent) {
    event.preventDefault();
    if (!providerEventId.trim()) {
      setFormError('Provide a provider event id (dedupe key).');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api('/payment-events/simulate', {
        method: 'POST',
        body: {
          provider: 'SIMULATED',
          providerEventId: providerEventId.trim(),
          eventType,
          intentId: intentId.trim() || undefined,
        },
      });
      setProviderEventId('');
      setIntentId('');
      setReload((n) => n + 1);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Payment events" error={error} loading={loading}>
      <div className="muted" style={{ margin: '0.25rem 0 1rem' }}>
        ⚠️ Provider event INGESTION FOUNDATION — authenticated/admin-only, not a
        public webhook. Only normalized fields are stored (no raw payload, no
        signature verification). Duplicate (provider, event id) is idempotent.
      </div>
      <form className="toolbar" onSubmit={(e) => void simulate(e)}>
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as PaymentEventType)}
        >
          {EVENT_TYPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          style={{ width: '14rem' }}
          value={providerEventId}
          onChange={(e) => setProviderEventId(e.target.value)}
          placeholder="Provider event id"
          aria-label="Provider event id"
        />
        <input
          style={{ width: '14rem' }}
          value={intentId}
          onChange={(e) => setIntentId(e.target.value)}
          placeholder="Intent id (optional)"
          aria-label="Intent id (optional)"
        />
        <button className="primary" type="submit" disabled={busy}>
          Simulate event
        </button>
      </form>
      {formError ? <div className="error">{formError}</div> : null}
      <div className="toolbar">
        <span className="muted">{data?.total ?? 0} total</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Provider event id</th>
            <th>Type</th>
            <th>Status</th>
            <th>Intent</th>
            <th>Received</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((event) => (
            <tr key={event.id}>
              <td>{event.providerEventId}</td>
              <td>{event.eventType}</td>
              <td>
                <StatusBadge status={event.status} />
              </td>
              <td>
                {event.intentId ? (
                  <Link to={`/payments/${event.intentId}`}>
                    {event.intentId}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{formatDate(event.receivedAt)}</td>
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
