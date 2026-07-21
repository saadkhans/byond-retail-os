import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  CheckoutSession,
  Paginated,
  Product,
  VisionEvent,
} from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const EVENT_STATUSES = ['', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'OVERRIDDEN'];

const EVENT_TYPES = [
  '',
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'PRODUCT_TRANSFER',
  'CART_INSERTION',
  'EXIT_RECONCILIATION',
];

/** Only these event types mutate the basket on approval (or override). */
const BASKET_AFFECTING_TYPES = [
  'PRODUCT_PICKUP',
  'CART_INSERTION',
  'PRODUCT_RETURN',
];

/** Session states whose basket can still change (bind targets). */
const MUTABLE_SESSION_STATUSES = ['OPEN', 'ACTIVE', 'PENDING_REVIEW'];

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

export function VisionEventsPage() {
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const { data, error, loading } = useLoad<Paginated<VisionEvent>>(
    () =>
      api(
        `/vision-events?skip=${skip}&take=${take}` +
          (status ? `&status=${status}` : '') +
          (type ? `&type=${type}` : ''),
      ),
    [status, type, skip],
  );

  return (
    <Page title="CV events" error={error} loading={loading}>
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setSkip(0);
            setStatus(e.target.value);
          }}
        >
          {EVENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value || 'Any status'}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => {
            setSkip(0);
            setType(e.target.value);
          }}
        >
          {EVENT_TYPES.map((value) => (
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
            <th>Event</th>
            <th>Type</th>
            <th>Status</th>
            <th>Qty</th>
            <th>Store</th>
            <th>Unit</th>
            <th>Session</th>
            <th>Occurred</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((event) => (
            <tr key={event.id}>
              <td>
                <Link to={`/vision-events/${event.id}`}>{event.id}</Link>
              </td>
              <td>{event.type}</td>
              <td>
                <StatusBadge status={event.status} />
              </td>
              <td>{event.quantity}</td>
              <td>{event.location ? `${event.location.name}` : event.locationId}</td>
              <td>{event.unit ? `${event.unit.name}` : event.unitId}</td>
              <td>
                {event.sessionId ? (
                  <Link to={`/checkout-sessions/${event.sessionId}`}>
                    {event.session?.status ?? 'session'}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{formatDate(event.occurredAt)}</td>
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

export function VisionEventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const [overrideProductId, setOverrideProductId] = useState('');
  const [overrideQuantity, setOverrideQuantity] = useState('1');
  const [productSearch, setProductSearch] = useState('');

  const { data, error, loading } = useLoad<VisionEvent>(
    () => api(`/vision-events/${id}`),
    [id, reload],
  );

  const [bindSessionId, setBindSessionId] = useState('');
  const [sessionSkip, setSessionSkip] = useState(0);
  const sessionTake = 100;

  // Server-side search keeps the override picker usable for catalogs larger
  // than one page; the load error (e.g. a reviewer without catalog:read) is
  // surfaced in the override form instead of silently emptying the picker.
  const products = useLoad<Paginated<Product>>(
    () =>
      api<Paginated<Product>>(
        `/catalog/products?take=100${
          productSearch ? `&search=${encodeURIComponent(productSearch)}` : ''
        }`,
      ),
    [productSearch],
  );

  const pending = data?.status === 'PENDING_REVIEW';
  const basketAffecting = data
    ? BASKET_AFFECTING_TYPES.includes(data.type)
    : false;
  const unbound = pending && !data?.sessionId;

  // Bind targets for an unbound pending event: same-unit sessions whose
  // basket can still change. Loaded only when the bind form is shown, and
  // paginated — an older bindable session can also be bound by pasting its
  // id directly, so no session is ever unreachable.
  const sessions = useLoad<Paginated<CheckoutSession> | null>(
    () =>
      data && data.status === 'PENDING_REVIEW' && !data.sessionId
        ? api<Paginated<CheckoutSession>>(
            `/checkout-sessions?unitId=${data.unitId}&skip=${sessionSkip}&take=${sessionTake}`,
          )
        : Promise.resolve(null),
    [data?.id, data?.status, data?.sessionId, sessionSkip, reload],
  );
  const bindableSessions =
    sessions.data?.items.filter((session) =>
      MUTABLE_SESSION_STATUSES.includes(session.status),
    ) ?? [];

  async function decide(
    decision: 'APPROVE' | 'REJECT' | 'OVERRIDE',
    extra: Record<string, unknown> = {},
  ) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/vision-events/${id}/review`, {
        method: 'POST',
        body: {
          decision,
          ...(reason ? { reason } : {}),
          ...extra,
        },
      });
      setReason('');
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function override(event: FormEvent) {
    event.preventDefault();
    const qty = Number(overrideQuantity);
    if (!overrideProductId || !Number.isInteger(qty) || qty < 1) {
      setActionError('Pick a product and a whole quantity of at least 1.');
      return;
    }
    // No hidden-stale-selection hazard: the product id is always visible in
    // the text input (search changes clear it), and a pasted id is
    // deliberate — the API validates it against the tenant catalog anyway.
    await decide('OVERRIDE', { productId: overrideProductId, quantity: qty });
  }

  async function bind(event: FormEvent) {
    event.preventDefault();
    if (!bindSessionId) {
      setActionError('Pick a checkout session to bind.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api(`/vision-events/${id}/session`, {
        method: 'POST',
        body: { sessionId: bindSessionId },
      });
      setBindSessionId('');
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="CV event" error={error} loading={loading}>
      {data ? (
        <div className="detail">
          {actionError ? <div className="error">{actionError}</div> : null}
          {pending ? (
            <>
              {unbound ? (
                <>
                  <form className="toolbar" onSubmit={(e) => void bind(e)}>
                    <select
                      value={bindSessionId}
                      onChange={(e) => setBindSessionId(e.target.value)}
                    >
                      <option value="">Bind to checkout session…</option>
                      {bindableSessions.map((session) => (
                        <option key={session.id} value={session.id}>
                          {session.id} ({session.status})
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="…or paste a session id"
                      style={{ minWidth: '14rem' }}
                      value={bindSessionId}
                      onChange={(e) => setBindSessionId(e.target.value)}
                    />
                    <button type="submit" disabled={busy || !bindSessionId}>
                      Bind session
                    </button>
                    {basketAffecting ? (
                      <span className="muted">
                        Basket-affecting approvals need a bound same-unit
                        session.
                      </span>
                    ) : null}
                  </form>
                  {sessions.data && sessions.data.total > sessionTake ? (
                    <div className="pagination">
                      <button
                        type="button"
                        disabled={sessionSkip === 0}
                        onClick={() =>
                          setSessionSkip(
                            Math.max(0, sessionSkip - sessionTake),
                          )
                        }
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        disabled={
                          sessionSkip + sessionTake >= sessions.data.total
                        }
                        onClick={() => setSessionSkip(sessionSkip + sessionTake)}
                      >
                        Next
                      </button>
                      <span className="muted">
                        Sessions {sessionSkip + 1}–
                        {Math.min(
                          sessionSkip + sessionTake,
                          sessions.data.total,
                        )}{' '}
                        of {sessions.data.total} for this unit (terminal
                        sessions are hidden; older ones can be pasted by id).
                      </span>
                    </div>
                  ) : null}
                  {sessions.error ? (
                    <div className="error">
                      Cannot load sessions to bind (needs the checkout:read
                      permission): {sessions.error}. You can still paste a
                      session id directly.
                    </div>
                  ) : null}
                </>
              ) : null}
              <div className="toolbar">
                <input
                  type="text"
                  placeholder="Reason (optional, audited)"
                  style={{ minWidth: '18rem' }}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button
                  className="primary"
                  // Candidates and a bound session are only required when
                  // approval mutates the basket; record-only types
                  // (PRODUCT_TRANSFER, EXIT_RECONCILIATION) approve with
                  // neither.
                  disabled={
                    busy ||
                    (basketAffecting &&
                      (!(data.candidates?.length ?? 0) || !data.sessionId))
                  }
                  onClick={() => void decide('APPROVE')}
                >
                  Approve{basketAffecting ? ' → basket' : ''}
                </button>
                <button disabled={busy} onClick={() => void decide('REJECT')}>
                  Reject
                </button>
              </div>
              {basketAffecting ? (
                <>
                  <form className="toolbar" onSubmit={(e) => void override(e)}>
                    <input
                      type="text"
                      placeholder="Search products (name or SKU)"
                      style={{ minWidth: '14rem' }}
                      value={productSearch}
                      onChange={(e) => {
                        setProductSearch(e.target.value);
                        // A new search may drop the selected product from
                        // the options; clear it so a hidden stale selection
                        // can never be submitted.
                        setOverrideProductId('');
                      }}
                    />
                    <select
                      value={overrideProductId}
                      onChange={(e) => setOverrideProductId(e.target.value)}
                    >
                      <option value="">Override product…</option>
                      {products.data?.items.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.sku} — {product.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="…or paste a product id"
                      style={{ minWidth: '14rem' }}
                      value={overrideProductId}
                      onChange={(e) => setOverrideProductId(e.target.value)}
                    />
                    <input
                      type="number"
                      min={1}
                      step={1}
                      style={{ width: '6rem' }}
                      value={overrideQuantity}
                      onChange={(e) => setOverrideQuantity(e.target.value)}
                    />
                    <button type="submit" disabled={busy || !data.sessionId}>
                      Manual override
                    </button>
                  </form>
                  {products.error ? (
                    <div className="error">
                      Cannot load products for the override picker (needs the
                      catalog:read permission): {products.error}. You can
                      still paste a product id directly.
                    </div>
                  ) : null}
                  {products.data && products.data.total > products.data.items.length ? (
                    <p className="muted">
                      Showing {products.data.items.length} of{' '}
                      {products.data.total} products — search to narrow the
                      list.
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          <dl>
            <dt>Event ID</dt>
            <dd>{data.id}</dd>
            <dt>Type</dt>
            <dd>{data.type}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Quantity</dt>
            <dd>{data.quantity}</dd>
            <dt>Store</dt>
            <dd>
              <Link to={`/stores/${data.locationId}`}>
                {data.location?.name ?? data.locationId}
              </Link>
            </dd>
            <dt>Unit</dt>
            <dd>
              <Link to={`/units/${data.unitId}`}>
                {data.unit?.name ?? data.unitId}
              </Link>
            </dd>
            <dt>Device</dt>
            <dd>
              {data.deviceId ? (
                <Link to={`/devices/${data.deviceId}`}>
                  {data.device?.name ?? data.deviceId}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Checkout session</dt>
            <dd>
              {data.sessionId ? (
                <Link to={`/checkout-sessions/${data.sessionId}`}>
                  {data.sessionId}
                  {data.session ? ` (${data.session.status})` : ''}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Occurred</dt>
            <dd>{formatDate(data.occurredAt)}</dd>
            <dt>Ingested</dt>
            <dd>{formatDate(data.ingestedAt)}</dd>
            <dt>Source</dt>
            <dd>
              {[data.sourceType, data.sourceId].filter(Boolean).join(' · ')}
            </dd>
            <dt>Model</dt>
            <dd>
              {data.modelName
                ? `${data.modelName}${data.modelVersion ? ` @ ${data.modelVersion}` : ''}`
                : '—'}
            </dd>
            <dt>Evidence score</dt>
            <dd>{data.evidenceScore ?? '—'}</dd>
            <dt>Evidence quality</dt>
            <dd>{data.evidenceQuality ?? '—'}</dd>
            <dt>Reason codes</dt>
            <dd>{data.reasonCodes.length ? data.reasonCodes.join(', ') : '—'}</dd>
          </dl>

          <h1 style={{ marginTop: '1.5rem' }}>
            Candidate SKUs ({data.candidates?.length ?? 0})
          </h1>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>SKU</th>
                <th>Product</th>
                <th>Score</th>
                <th>Source label</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates?.map((candidate) => (
                <tr key={candidate.id}>
                  <td>{candidate.rank}</td>
                  <td>{candidate.sku}</td>
                  <td>{candidate.productName}</td>
                  <td>{candidate.score ?? '—'}</td>
                  <td>{candidate.label ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.review ? (
            <>
              <h1 style={{ marginTop: '1.5rem' }}>Decision</h1>
              <dl>
                <dt>Decision</dt>
                <dd>{data.review.decision}</dd>
                <dt>Basket effect</dt>
                <dd>{data.review.basketEffect}</dd>
                <dt>Applied product</dt>
                <dd>{data.review.appliedProductId ?? '—'}</dd>
                <dt>Applied quantity</dt>
                <dd>{data.review.appliedQuantity ?? '—'}</dd>
                <dt>Basket line</dt>
                <dd>{data.review.sessionLineId ?? '—'}</dd>
                <dt>Reason</dt>
                <dd>{data.review.reason ?? '—'}</dd>
                <dt>Decided</dt>
                <dd>{formatDate(data.review.createdAt)}</dd>
              </dl>
            </>
          ) : null}

          {data.evidenceBundle ? (
            <>
              <h1 style={{ marginTop: '1.5rem' }}>Evidence bundle</h1>
              <dl>
                <dt>Bundle ID</dt>
                <dd>{data.evidenceBundle.id}</dd>
                <dt>Source</dt>
                <dd>
                  {[data.evidenceBundle.sourceType, data.evidenceBundle.sourceId]
                    .filter(Boolean)
                    .join(' · ')}
                </dd>
                <dt>Model</dt>
                <dd>
                  {data.evidenceBundle.modelName
                    ? `${data.evidenceBundle.modelName}${
                        data.evidenceBundle.modelVersion
                          ? ` @ ${data.evidenceBundle.modelVersion}`
                          : ''
                      }`
                    : '—'}
                </dd>
                <dt>Capture window</dt>
                <dd>
                  {data.evidenceBundle.captureStartedAt ||
                  data.evidenceBundle.captureEndedAt
                    ? `${formatDate(data.evidenceBundle.captureStartedAt)} → ${formatDate(
                        data.evidenceBundle.captureEndedAt,
                      )}`
                    : '—'}
                </dd>
              </dl>
              {data.evidenceBundle.artifacts?.length ? (
                <>
                  <h2 style={{ marginTop: '1rem' }}>
                    Artifacts ({data.evidenceBundle.artifacts.length}) — metadata
                    only
                  </h2>
                  <pre>
                    {JSON.stringify(data.evidenceBundle.artifacts, null, 2)}
                  </pre>
                </>
              ) : null}
              {data.evidenceBundle.metadata ? (
                <pre>{JSON.stringify(data.evidenceBundle.metadata, null, 2)}</pre>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}
