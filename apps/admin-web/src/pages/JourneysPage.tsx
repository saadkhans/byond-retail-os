import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  JourneyDetail,
  JourneySummary,
  Paginated,
  Product,
  Store,
  api,
} from '../api';
import { Page, StatusBadge, formatDate, useLoad } from '../components';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/** Journey list + open-journey form (SHADOW mode — no billing anywhere). */
export function JourneysPage() {
  const [reload, setReload] = useState(0);
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const journeys = useLoad<JourneySummary[]>(() => api('/journeys'), [reload]);
  const stores = useLoad<Paginated<Store>>(
    () => api<Paginated<Store>>('/stores?take=100'),
    [],
  );

  async function open() {
    if (!locationId) {
      setError('Pick the store the shopper entered.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/journeys', { method: 'POST', body: { locationId } });
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Customer journeys (shadow)" error={journeys.error} loading={journeys.loading && !journeys.data}>
      <p className="muted">
        Append-only observation streams with a provisional basket FOLD.
        Shadow mode: nothing here touches checkout, orders, payments, or
        inventory.
      </p>
      {error ? <div className="error">{error}</div> : null}
      <div className="toolbar">
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Store…</option>
          {(stores.data?.items ?? []).map((store) => (
            <option key={store.id} value={store.id}>
              {store.name} ({store.code})
            </option>
          ))}
        </select>
        <button className="primary" disabled={busy} onClick={() => void open()}>
          Open journey (ENTRY)
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Journey</th>
            <th>Status</th>
            <th>Started</th>
            <th>Ended</th>
            <th>Events</th>
          </tr>
        </thead>
        <tbody>
          {(journeys.data ?? []).map((journey) => (
            <tr key={journey.id}>
              <td>
                <Link to={`/journeys/${journey.id}`}>{journey.id}</Link>
              </td>
              <td>
                <StatusBadge status={journey.status} />
              </td>
              <td>{formatDate(journey.startedAt)}</td>
              <td>{formatDate(journey.endedAt)}</td>
              <td>{journey.eventCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}

/** Journey review: timeline, provisional basket, unresolved issues. */
export function JourneyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productId, setProductId] = useState('');
  const [eventType, setEventType] = useState('PRODUCT_PICKUP');
  const [assetId, setAssetId] = useState('');

  const journey = useLoad<JourneyDetail>(() => api(`/journeys/${id}`), [id, reload]);
  const products = useLoad<Paginated<Product>>(
    () => api<Paginated<Product>>('/catalog/products?take=100'),
    [],
  );

  async function act(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/journeys/${id}${path}`, { method: 'POST', body });
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const data = journey.data;
  const open = data?.status === 'OPEN';

  return (
    <Page title="Journey review (shadow)" error={journey.error} loading={journey.loading && !data}>
      {data ? (
        <div className="detail">
          {error ? <div className="error">{error}</div> : null}
          <div className="toolbar">
            <StatusBadge status={data.status} />
            <span className="muted">
              started {formatDate(data.startedAt)}
              {data.endedAt ? ` · ended ${formatDate(data.endedAt)}` : ''}
            </span>
            {open ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void act('/exit', {})}
              >
                Record EXIT + reconcile
              </button>
            ) : null}
          </div>

          {open ? (
            <div className="toolbar" style={{ flexWrap: 'wrap' }}>
              <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
                <option value="PRODUCT_PICKUP">PRODUCT_PICKUP</option>
                <option value="PRODUCT_RETURN">PRODUCT_RETURN</option>
                <option value="SHELF_INTERACTION">SHELF_INTERACTION</option>
                <option value="REVIEW_REQUIRED">REVIEW_REQUIRED</option>
              </select>
              <select value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">Product (for pickup/return)…</option>
                {(products.data?.items ?? []).map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} ({product.sku})
                  </option>
                ))}
              </select>
              <button
                disabled={busy}
                onClick={() =>
                  void act('/events', {
                    eventType,
                    ...(productId ? { productId } : {}),
                  })
                }
              >
                Append event
              </button>
              <input
                type="text"
                style={{ minWidth: '16rem' }}
                placeholder="Video asset id (import latest fusion run)"
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
              />
              <button
                disabled={busy || !assetId.trim()}
                onClick={() =>
                  void act('/events/from-fusion-run', {
                    videoAssetId: assetId.trim(),
                  })
                }
              >
                Import fusion observation
              </button>
            </div>
          ) : null}

          <h2>Timeline ({data.events.length})</h2>
          <table>
            <thead>
              <tr>
                <th>At</th>
                <th>Event</th>
                <th>Product</th>
                <th>Qty</th>
                <th>Score</th>
                <th>Source</th>
                <th>Evidence</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.occurredAt)}</td>
                  <td>{event.eventType}</td>
                  <td>{event.sku ? `${event.productName} (${event.sku})` : '—'}</td>
                  <td>{event.quantity}</td>
                  <td>
                    {event.matchScore !== null
                      ? event.matchScore.toFixed(3)
                      : '—'}
                  </td>
                  <td>{event.sourceType}</td>
                  <td>
                    {event.videoAssetId ? (
                      <Link to={`/video-assets/${event.videoAssetId}`}>
                        video
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="muted">{event.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Provisional basket ({data.basket.length})</h2>
          {data.basket.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {data.basket.map((line) => (
                  <tr key={line.productId ?? 'unknown'}>
                    <td>{line.productName ?? '—'}</td>
                    <td>{line.sku ?? '—'}</td>
                    <td>{line.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Empty basket.</p>
          )}

          <h2>Unresolved issues ({data.issues.length})</h2>
          {data.issues.length > 0 ? (
            <ul>
              {data.issues.map((issue, index) => (
                <li key={index}>
                  <span className="badge warn">{issue.kind}</span>{' '}
                  {issue.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None — journey reconciles cleanly.</p>
          )}
        </div>
      ) : null}
    </Page>
  );
}
