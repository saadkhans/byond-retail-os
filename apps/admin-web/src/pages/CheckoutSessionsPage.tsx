import { FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  CheckoutSession,
  Order,
  Paginated,
  Product,
  Store,
  Unit,
} from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const SESSION_STATUSES = [
  '',
  'OPEN',
  'ACTIVE',
  'PENDING_REVIEW',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
];

const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

export function CheckoutSessionsPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const [locationId, setLocationId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data, error, loading } = useLoad<Paginated<CheckoutSession>>(
    () =>
      api(
        `/checkout-sessions?skip=${skip}&take=${take}` +
          (status ? `&status=${status}` : ''),
      ),
    [status, skip],
  );

  // Selects for the manual test flow; failures surface in the form, not the page.
  const stores = useLoad<Paginated<Store> | null>(
    () => api<Paginated<Store>>('/stores?take=100').catch(() => null),
    [],
  );
  const units = useLoad<Paginated<Unit> | null>(
    () =>
      locationId
        ? api<Paginated<Unit>>(
            `/units?locationId=${encodeURIComponent(locationId)}&take=100`,
          ).catch(() => null)
        : Promise.resolve(null),
    [locationId],
  );

  async function createSession(event: FormEvent) {
    event.preventDefault();
    if (!locationId || !unitId) {
      setCreateError('Pick a store and a unit first.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const session = await api<CheckoutSession>('/checkout-sessions', {
        method: 'POST',
        body: {
          locationId,
          unitId,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      navigate(`/checkout-sessions/${session.id}`);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Page title="Checkout sessions" error={error} loading={loading}>
      <form className="toolbar" onSubmit={(e) => void createSession(e)}>
        <select
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            setUnitId('');
          }}
        >
          <option value="">Store…</option>
          {stores.data?.items.map((store) => (
            <option key={store.id} value={store.id}>
              {store.name} ({store.code})
            </option>
          ))}
        </select>
        <select
          value={unitId}
          onChange={(e) => setUnitId(e.target.value)}
          disabled={!locationId}
        >
          <option value="">Unit…</option>
          {units.data?.items.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name} ({unit.code})
            </option>
          ))}
        </select>
        <button className="primary" type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'New session'}
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
          {SESSION_STATUSES.map((value) => (
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
            <th>Session</th>
            <th>Status</th>
            <th>Source</th>
            <th>Started</th>
            <th>Ended</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((session) => (
            <tr key={session.id}>
              <td>
                <Link to={`/checkout-sessions/${session.id}`}>
                  {session.id}
                </Link>
              </td>
              <td>
                <StatusBadge status={session.status} />
              </td>
              <td>{session.sourceType}</td>
              <td>{formatDate(session.startedAt)}</td>
              <td>{formatDate(session.endedAt)}</td>
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

export function CheckoutSessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [lineQuantities, setLineQuantities] = useState<Record<string, string>>(
    {},
  );

  const { data, error, loading } = useLoad<CheckoutSession>(
    () => api(`/checkout-sessions/${id}`),
    [id, reload],
  );

  const products = useLoad<Paginated<Product> | null>(
    () =>
      api<Paginated<Product>>('/catalog/products?take=100').catch(() => null),
    [],
  );
  const saleableProducts =
    products.data?.items.filter((product) => product.status === 'ACTIVE') ?? [];

  const terminal = data ? TERMINAL_STATUSES.includes(data.status) : true;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function addLine(event: FormEvent) {
    event.preventDefault();
    const qty = Number(quantity);
    if (!productId || !Number.isInteger(qty) || qty < 1) {
      setActionError('Pick a product and a whole quantity of at least 1.');
      return;
    }
    await run(async () => {
      await api(`/checkout-sessions/${id}/lines`, {
        method: 'POST',
        body: {
          productId,
          quantity: qty,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      setProductId('');
      setQuantity('1');
    });
  }

  async function updateLine(lineId: string) {
    const raw = lineQuantities[lineId];
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty < 1) {
      setActionError('Quantity must be a whole number of at least 1.');
      return;
    }
    await run(async () => {
      await api(`/checkout-sessions/${id}/lines/${lineId}`, {
        method: 'PATCH',
        body: { quantity: qty },
      });
    });
  }

  async function removeLine(lineId: string) {
    await run(async () => {
      await api(`/checkout-sessions/${id}/lines/${lineId}`, {
        method: 'DELETE',
      });
    });
  }

  async function setStatus(status: 'CANCELLED' | 'EXPIRED') {
    await run(async () => {
      await api(`/checkout-sessions/${id}/status`, {
        method: 'PATCH',
        body: { status },
      });
    });
  }

  async function complete() {
    setBusy(true);
    setActionError(null);
    try {
      const order = await api<Order>(`/checkout-sessions/${id}/complete`, {
        method: 'POST',
        body: { idempotencyKey: crypto.randomUUID() },
      });
      navigate(`/orders/${order.id}`);
    } catch (err) {
      setActionError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Page title="Checkout session" error={error} loading={loading}>
      {data ? (
        <div className="detail">
          {actionError ? <div className="error">{actionError}</div> : null}
          <div className="toolbar">
            <button
              className="primary"
              disabled={busy || terminal || !(data.lines?.length ?? 0)}
              onClick={() => void complete()}
            >
              Complete → order
            </button>
            <button
              disabled={busy || terminal}
              onClick={() => void setStatus('CANCELLED')}
            >
              Cancel session
            </button>
            <button
              disabled={busy || terminal}
              onClick={() => void setStatus('EXPIRED')}
            >
              Expire session
            </button>
            {data.order ? (
              <Link to={`/orders/${data.order.id}`}>
                Order {data.order.orderNumber}
              </Link>
            ) : null}
          </div>
          <dl>
            <dt>Session ID</dt>
            <dd>{data.id}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Store</dt>
            <dd>
              <Link to={`/stores/${data.locationId}`}>{data.locationId}</Link>
            </dd>
            <dt>Unit</dt>
            <dd>
              <Link to={`/units/${data.unitId}`}>{data.unitId}</Link>
            </dd>
            <dt>Device</dt>
            <dd>
              {data.deviceId ? (
                <Link to={`/devices/${data.deviceId}`}>{data.deviceId}</Link>
              ) : (
                '—'
              )}
            </dd>
            <dt>Started</dt>
            <dd>{formatDate(data.startedAt)}</dd>
            <dt>Ended</dt>
            <dd>{formatDate(data.endedAt)}</dd>
            <dt>Source type</dt>
            <dd>{data.sourceType}</dd>
            <dt>Source ID</dt>
            <dd>{data.sourceId ?? '—'}</dd>
            <dt>Evidence bundle</dt>
            <dd>{data.evidenceBundleId ?? '—'}</dd>
            <dt>Vision event</dt>
            <dd>{data.visionEventId ?? '—'}</dd>
            <dt>VLM review</dt>
            <dd>{data.vlmReviewId ?? '—'}</dd>
            <dt>Evidence score</dt>
            <dd>{data.evidenceScore ?? '—'}</dd>
            <dt>Evidence quality</dt>
            <dd>{data.evidenceQuality ?? '—'}</dd>
            <dt>Reason codes</dt>
            <dd>{data.reasonCodes.length ? data.reasonCodes.join(', ') : '—'}</dd>
            <dt>Idempotency key</dt>
            <dd>{data.idempotencyKey ?? '—'}</dd>
          </dl>

          <h1 style={{ marginTop: '1.5rem' }}>
            Basket lines ({data.lines?.length ?? 0})
          </h1>
          {!terminal ? (
            <form className="toolbar" onSubmit={(e) => void addLine(e)}>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
              >
                <option value="">Product…</option>
                {saleableProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                step={1}
                style={{ width: '6rem' }}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              <button className="primary" type="submit" disabled={busy}>
                Add line
              </button>
            </form>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>UoM</th>
                <th>Quantity</th>
                <th>Evidence</th>
                {!terminal ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.lines?.map((line) => (
                <tr key={line.id}>
                  <td>{line.sku}</td>
                  <td>{line.productName}</td>
                  <td>{line.unitOfMeasure}</td>
                  <td>
                    {terminal ? (
                      line.quantity
                    ) : (
                      <input
                        type="number"
                        min={1}
                        step={1}
                        style={{ width: '5rem' }}
                        value={lineQuantities[line.id] ?? String(line.quantity)}
                        onChange={(e) =>
                          setLineQuantities((prev) => ({
                            ...prev,
                            [line.id]: e.target.value,
                          }))
                        }
                      />
                    )}
                  </td>
                  <td>
                    {[
                      line.sourceType,
                      line.visionEventId,
                      line.vlmReviewId,
                      line.evidenceBundleId,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  {!terminal ? (
                    <td>
                      <button
                        disabled={busy}
                        onClick={() => void updateLine(line.id)}
                      >
                        Update
                      </button>{' '}
                      <button
                        disabled={busy}
                        onClick={() => void removeLine(line.id)}
                      >
                        Remove
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
