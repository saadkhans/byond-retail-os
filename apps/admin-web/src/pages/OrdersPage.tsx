import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Order, Paginated } from '../api';
import { formatDate, Page, StatusBadge, useLoad } from '../components';

const ORDER_STATUSES = ['', 'DRAFT', 'CONFIRMED', 'CANCELLED'];

export function OrdersPage() {
  const [status, setStatus] = useState('');
  const [skip, setSkip] = useState(0);
  const take = 25;

  const { data, error, loading } = useLoad<Paginated<Order>>(
    () =>
      api(
        `/orders?skip=${skip}&take=${take}` + (status ? `&status=${status}` : ''),
      ),
    [status, skip],
  );

  return (
    <Page title="Orders" error={error} loading={loading}>
      <div className="toolbar">
        <select
          value={status}
          onChange={(e) => {
            setSkip(0);
            setStatus(e.target.value);
          }}
        >
          {ORDER_STATUSES.map((value) => (
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
            <th>Order #</th>
            <th>Status</th>
            <th>Items</th>
            <th>Source</th>
            <th>Placed</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((order) => (
            <tr key={order.id}>
              <td>
                <Link to={`/orders/${order.id}`}>{order.orderNumber}</Link>
              </td>
              <td>
                <StatusBadge status={order.status} />
              </td>
              <td>{order.totalQuantity}</td>
              <td>{order.sourceType}</td>
              <td>{formatDate(order.placedAt)}</td>
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

export function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useLoad<Order>(
    () => api(`/orders/${id}`),
    [id],
  );

  return (
    <Page
      title={data ? `Order ${data.orderNumber}` : 'Order'}
      error={error}
      loading={loading}
    >
      {data ? (
        <div className="detail">
          <dl>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
            </dd>
            <dt>Payment status</dt>
            <dd>
              <StatusBadge status={data.paymentStatus} />{' '}
              <Link to="/payments">payment intents</Link>
              <span className="muted">
                {' '}
                — simulated/provider-abstract; PAID only after a captured intent
              </span>
            </dd>
            <dt>Paid at</dt>
            <dd>{formatDate(data.paidAt)}</dd>
            <dt>Checkout session</dt>
            <dd>
              <Link to={`/checkout-sessions/${data.checkoutSessionId}`}>
                {data.checkoutSessionId}
              </Link>
            </dd>
            <dt>Store</dt>
            <dd>
              <Link to={`/stores/${data.locationId}`}>{data.locationId}</Link>
            </dd>
            <dt>Unit</dt>
            <dd>
              <Link to={`/units/${data.unitId}`}>{data.unitId}</Link>
            </dd>
            <dt>Items</dt>
            <dd>{data.totalQuantity}</dd>
            <dt>Totals</dt>
            <dd className="muted">
              Not priced — pricing/payment arrives in a later phase.
            </dd>
            <dt>Placed</dt>
            <dd>{formatDate(data.placedAt)}</dd>
            <dt>Confirmed</dt>
            <dd>{formatDate(data.confirmedAt)}</dd>
            <dt>Cancelled</dt>
            <dd>{formatDate(data.cancelledAt)}</dd>
            <dt>Cancel reason</dt>
            <dd>{data.cancelReason ?? '—'}</dd>
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
            Order lines ({data.lines?.length ?? 0})
          </h1>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>UoM</th>
                <th>Quantity</th>
                <th>Session line</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {data.lines?.map((line) => (
                <tr key={line.id}>
                  <td>{line.sku}</td>
                  <td>{line.productName}</td>
                  <td>{line.unitOfMeasure}</td>
                  <td>{line.quantity}</td>
                  <td>{line.sessionLineId ?? '—'}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
