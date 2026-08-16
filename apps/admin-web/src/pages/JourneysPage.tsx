import { Fragment, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  JourneyDetail,
  JourneyEventReview,
  JourneySummary,
  Paginated,
  Product,
  Store,
  api,
} from '../api';
import { Page, StatusBadge, formatDate, useLoad } from '../components';
import { decisionTone } from '../cv-evaluation-utils';
import {
  CorrectionDraft,
  newCorrectionDraft,
  validateCorrectionDraft,
} from '../review-correction';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/** The most recent review wins (server returns reviews oldest-first). */
function latestReview(
  reviews: JourneyEventReview[],
): JourneyEventReview | null {
  return reviews.length > 0 ? reviews[reviews.length - 1] : null;
}

const REVIEWABLE_TYPES = new Set([
  'PRODUCT_PICKUP',
  'PRODUCT_RETURN',
  'REVIEW_REQUIRED',
]);

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
            <th>Decision</th>
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
              <td>
                {journey.decision ? (
                  <span className={`badge ${decisionTone(journey.decision)}`}>
                    {journey.decision}
                  </span>
                ) : (
                  '—'
                )}
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

/** Journey review: timeline, reviews, provisional basket, fusion runs,
 *  unresolved issues, and the final SHADOW decision. */
export function JourneyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productId, setProductId] = useState('');
  const [eventType, setEventType] = useState('PRODUCT_PICKUP');
  const [assetId, setAssetId] = useState('');
  // Inline CORRECT form state: ONE draft object keyed by its event,
  // replaced whole on row switch — reason/product/quantity can never
  // leak from one observation's form into another's audited review.
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);

  const journey = useLoad<JourneyDetail>(() => api(`/journeys/${id}`), [id, reload]);
  const products = useLoad<Paginated<Product>>(
    () => api<Paginated<Product>>('/catalog/products?take=100'),
    [],
  );

  // One idempotency key per event, created on the first review attempt and
  // dropped only after a CONFIRMED success — a retry after a lost response
  // resends the same key and the server replays the stored review instead
  // of appending a duplicate immutable record (same rotate-on-success
  // idiom as the upload idempotency key in VideoAssetsPage).
  const reviewKeys = useRef(new Map<string, string>());

  async function act(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/journeys/${id}${path}`, { method: 'POST', body });
      setDraft(null);
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitReview(eventId: string, body: Record<string, unknown>) {
    const existing = reviewKeys.current.get(eventId);
    const idempotencyKey = existing ?? crypto.randomUUID();
    reviewKeys.current.set(eventId, idempotencyKey);
    setBusy(true);
    setError(null);
    try {
      await api(`/journeys/${id}/events/${eventId}/review`, {
        method: 'POST',
        body: { ...body, idempotencyKey },
      });
      reviewKeys.current.delete(eventId);
      setDraft(null);
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function startCorrect(eventId: string, original: {
    eventType: string;
    productId: string | null;
    quantity: number;
  }) {
    // Whole-draft swap — a fresh draft per event, seeded only from that
    // event's own observation.
    setDraft(newCorrectionDraft(eventId, original));
  }

  function submitCorrect(eventId: string) {
    if (!draft || draft.eventId !== eventId) {
      return;
    }
    const validation = validateCorrectionDraft(draft);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    void submitReview(eventId, {
      decision: 'CORRECT',
      correctedEventType: draft.eventType,
      correctedProductId: draft.productId,
      correctedQuantity: validation.quantity,
      ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
    });
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
            {data.decision ? (
              <span className={`badge ${decisionTone(data.decision)}`}>
                {data.decision}
              </span>
            ) : null}
            <span className="muted">
              started {formatDate(data.startedAt)}
              {data.endedAt ? ` · ended ${formatDate(data.endedAt)}` : ''}
              {data.decidedAt ? ` · decided ${formatDate(data.decidedAt)}` : ''}
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
          {data.decisionReason ? (
            <p className="muted">Decision: {data.decisionReason}</p>
          ) : null}

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
                <th>Review</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => {
                const review = latestReview(event.reviews);
                const reviewable = REVIEWABLE_TYPES.has(event.eventType);
                return (
                  <Fragment key={event.id}>
                    <tr>
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
                      <td>
                        {review ? (
                          <>
                            <span
                              className={`badge ${
                                review.decision === 'APPROVE'
                                  ? 'ok'
                                  : review.decision === 'REJECT'
                                    ? 'down'
                                    : 'warn'
                              }`}
                            >
                              {review.decision}
                            </span>
                            {review.decision === 'CORRECT' ? (
                              <div className="muted">
                                → {review.correctedSku ?? review.correctedProductId}{' '}
                                × {review.correctedQuantity}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {reviewable ? (
                          <span style={{ whiteSpace: 'nowrap' }}>
                            <button
                              disabled={busy}
                              onClick={() =>
                                void submitReview(event.id, {
                                  decision: 'APPROVE',
                                })
                              }
                            >
                              Approve
                            </button>{' '}
                            <button
                              disabled={busy}
                              onClick={() =>
                                void submitReview(event.id, {
                                  decision: 'REJECT',
                                })
                              }
                            >
                              Reject
                            </button>{' '}
                            <button
                              disabled={busy}
                              onClick={() => startCorrect(event.id, event)}
                            >
                              Correct
                            </button>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                    {draft?.eventId === event.id ? (
                      <tr>
                        <td colSpan={10}>
                          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
                            <span className="muted">Correction:</span>
                            <select
                              value={draft.eventType}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  eventType:
                                    e.target.value === 'PRODUCT_RETURN'
                                      ? 'PRODUCT_RETURN'
                                      : 'PRODUCT_PICKUP',
                                })
                              }
                            >
                              <option value="PRODUCT_PICKUP">PRODUCT_PICKUP</option>
                              <option value="PRODUCT_RETURN">PRODUCT_RETURN</option>
                            </select>
                            <select
                              value={draft.productId}
                              onChange={(e) =>
                                setDraft({ ...draft, productId: e.target.value })
                              }
                            >
                              <option value="">Actual product…</option>
                              {(products.data?.items ?? []).map((product) => (
                                <option key={product.id} value={product.id}>
                                  {product.name} ({product.sku})
                                </option>
                              ))}
                            </select>
                            <input
                              type="number"
                              min={1}
                              max={100}
                              step={1}
                              style={{ width: '5rem' }}
                              value={draft.quantity}
                              onChange={(e) =>
                                setDraft({ ...draft, quantity: e.target.value })
                              }
                            />
                            <input
                              type="text"
                              style={{ minWidth: '14rem' }}
                              placeholder="Reason (optional)"
                              value={draft.reason}
                              onChange={(e) =>
                                setDraft({ ...draft, reason: e.target.value })
                              }
                            />
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() => submitCorrect(event.id)}
                            >
                              Apply correction
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => setDraft(null)}
                            >
                              Cancel
                            </button>
                            {event.eventType === 'REVIEW_REQUIRED' ? (
                              <span className="muted">
                                REVIEW_REQUIRED needs the event type set — what
                                actually happened.
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="muted">
            Reviews are append-only and audited — the observation row is never
            rewritten; the latest review per event drives the basket fold.
          </p>

          <h2>Imported fusion runs ({data.fusionRuns.length})</h2>
          {data.fusionRuns.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Policy</th>
                  <th>Top SKU</th>
                  <th>Fused score (uncalibrated)</th>
                  <th>VLM</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {data.fusionRuns.map((run) => (
                  <tr key={run.runId}>
                    <td title={run.runId}>
                      {run.runId.slice(0, 8)}…
                      <div className="muted">{formatDate(run.createdAt)}</div>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          run.policy === 'AUTO_PROPOSE'
                            ? 'ok'
                            : run.policy === 'FAILED'
                              ? 'down'
                              : 'warn'
                        }`}
                      >
                        {run.policy}
                      </span>
                    </td>
                    <td>{run.fusedTopSku ?? '—'}</td>
                    <td>
                      {run.fusedTopScore !== null
                        ? run.fusedTopScore.toFixed(3)
                        : '—'}
                    </td>
                    <td>
                      {run.vlm && run.vlm.invoked ? (
                        <>
                          {run.vlm.verdict ?? run.vlm.status}
                          {run.vlm.selectedSku ? ` · ${run.vlm.selectedSku}` : ''}
                          {run.vlm.requiresHumanReview ? (
                            <span className="badge warn"> review</span>
                          ) : null}
                        </>
                      ) : (
                        'not invoked'
                      )}
                    </td>
                    <td>
                      <Link to={`/video-assets/${run.videoAssetId}`}>
                        Evidence →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No fusion observations imported.</p>
          )}

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
