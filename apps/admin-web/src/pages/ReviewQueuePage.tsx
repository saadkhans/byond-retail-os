import { Fragment, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  Paginated,
  Product,
  ReviewQueueItem,
  api,
} from '../api';
import { Page, formatDate, useLoad } from '../components';
import { decisionTone } from '../cv-evaluation-utils';
import {
  CorrectionDraft,
  newCorrectionDraft,
  validateCorrectionDraft,
} from '../review-correction';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/** Controlled queue reasons → readable label + badge tone. */
const REASON_LABEL: Record<
  ReviewQueueItem['reason'],
  { label: string; tone: string }
> = {
  'REVIEW_REQUIRED observation': { label: 'Needs review', tone: 'warn' },
  'unknown product': { label: 'Unknown product', tone: 'warn' },
  RETURN_WITHOUT_PICKUP: { label: 'Return w/o pickup', tone: 'warn' },
  NEGATIVE_QUANTITY: { label: 'Negative quantity', tone: 'warn' },
};

/**
 * Phase 12 review queue: journey observations awaiting a human decision,
 * with the fusion/VLM evidence summary beside each. All actions go
 * through the existing per-event review endpoint — reviews are
 * append-only and audited, and none of them touches billing.
 */
export function ReviewQueuePage() {
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Inline CORRECT form state: ONE draft object keyed by its event,
  // replaced whole on row switch — reason/product/quantity can never
  // leak from one observation's form into another's audited review.
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);

  const queue = useLoad<ReviewQueueItem[]>(
    () => api('/journeys/review-queue'),
    [reload],
  );
  const products = useLoad<Paginated<Product>>(
    () => api<Paginated<Product>>('/catalog/products?take=100'),
    [],
  );

  // One idempotency key per event, dropped only after a CONFIRMED success
  // — a lost-response retry replays server-side instead of appending a
  // second immutable review (same idiom as JourneysPage).
  const reviewKeys = useRef(new Map<string, string>());

  async function submitReview(
    item: ReviewQueueItem,
    body: Record<string, unknown>,
  ) {
    const existing = reviewKeys.current.get(item.eventId);
    const idempotencyKey = existing ?? crypto.randomUUID();
    reviewKeys.current.set(item.eventId, idempotencyKey);
    setBusy(true);
    setActionError(null);
    try {
      await api(
        `/journeys/${item.journeyId}/events/${item.eventId}/review`,
        { method: 'POST', body: { ...body, idempotencyKey } },
      );
      reviewKeys.current.delete(item.eventId);
      setDraft(null);
      setReload((n) => n + 1);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submitCorrect(item: ReviewQueueItem) {
    if (!draft || draft.eventId !== item.eventId) {
      return;
    }
    const validation = validateCorrectionDraft(draft);
    if (!validation.ok) {
      setActionError(validation.error);
      return;
    }
    void submitReview(item, {
      decision: 'CORRECT',
      correctedEventType: draft.eventType,
      correctedProductId: draft.productId,
      correctedQuantity: validation.quantity,
      ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
    });
  }

  const rows = queue.data ?? [];

  return (
    <Page
      title="Review queue (shadow)"
      error={queue.error}
      loading={queue.loading && !queue.data}
    >
      <p className="muted">
        Uncertain CV observations awaiting a human decision, oldest first.
        Reviews are append-only and audited — the observation row is never
        rewritten, and no review touches checkout, orders, payments, or
        inventory.
      </p>
      {actionError ? <div className="error">{actionError}</div> : null}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Journey</th>
            <th>Event</th>
            <th>Candidate SKU</th>
            <th>Fused score (uncalibrated)</th>
            <th>VLM</th>
            <th>Reason</th>
            <th>Evidence</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <Fragment key={item.eventId}>
              <tr>
                <td>{formatDate(item.occurredAt)}</td>
                <td>
                  <Link to={`/journeys/${item.journeyId}`}>
                    {item.journeyId.slice(0, 8)}…
                  </Link>{' '}
                  {item.journeyDecision ? (
                    <span
                      className={`badge ${decisionTone(item.journeyDecision)}`}
                    >
                      {item.journeyDecision}
                    </span>
                  ) : (
                    <span className="muted">{item.journeyStatus}</span>
                  )}
                </td>
                <td>{item.eventType}</td>
                <td>{item.candidateSku ?? '—'}</td>
                <td>
                  {item.fusedTopScore != null
                    ? item.fusedTopScore.toFixed(3)
                    : '—'}
                </td>
                <td>
                  {item.vlm
                    ? `${item.vlm.verdict ?? item.vlm.status ?? '—'}${
                        item.vlm.selectedSku ? ` · ${item.vlm.selectedSku}` : ''
                      }${item.vlm.requiresHumanReview ? ' · review' : ''}`
                    : '—'}
                </td>
                <td>
                  <span className={`badge ${REASON_LABEL[item.reason].tone}`}>
                    {REASON_LABEL[item.reason].label}
                  </span>
                </td>
                <td>
                  {item.videoAssetId ? (
                    <Link to={`/video-assets/${item.videoAssetId}`}>
                      evidence
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    {item.reason !== 'REVIEW_REQUIRED observation' ? (
                      // The server rejects APPROVE for unidentified
                      // products AND for observations implicated in an
                      // unresolved journey inconsistency (return without
                      // pickup / negative quantity) — approval would not
                      // resolve the fold. Correct or reject instead.
                      <span className="muted">
                        {item.reason === 'unknown product'
                          ? 'identify the product or reject'
                          : 'correct or reject to resolve'}
                      </span>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void submitReview(item, { decision: 'APPROVE' })
                        }
                      >
                        Approve
                      </button>
                    )}{' '}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void submitReview(item, { decision: 'REJECT' })
                      }
                    >
                      Reject
                    </button>{' '}
                    <button
                      disabled={busy}
                      onClick={() =>
                        // Whole-draft swap: opening another row (or
                        // toggling this one closed) can never carry a
                        // reason or product across observations.
                        setDraft(
                          draft?.eventId === item.eventId
                            ? null
                            : newCorrectionDraft(item.eventId, {
                                eventType: item.eventType,
                              }),
                        )
                      }
                    >
                      Correct
                    </button>
                  </span>
                </td>
              </tr>
              {draft?.eventId === item.eventId ? (
                <tr>
                  <td colSpan={9}>
                    <span style={{ whiteSpace: 'nowrap' }}>
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
                      </select>{' '}
                      <select
                        value={draft.productId}
                        onChange={(e) =>
                          setDraft({ ...draft, productId: e.target.value })
                        }
                      >
                        <option value="">Product…</option>
                        {(products.data?.items ?? []).map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name} ({product.sku})
                          </option>
                        ))}
                      </select>{' '}
                      <input
                        style={{ width: '4rem' }}
                        value={draft.quantity}
                        onChange={(e) =>
                          setDraft({ ...draft, quantity: e.target.value })
                        }
                        placeholder="Qty"
                      />{' '}
                      <input
                        style={{ minWidth: '14rem' }}
                        value={draft.reason}
                        onChange={(e) =>
                          setDraft({ ...draft, reason: e.target.value })
                        }
                        placeholder="Reason (optional)"
                      />{' '}
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => submitCorrect(item)}
                      >
                        Apply correction
                      </button>
                    </span>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className="muted">Queue is empty — nothing needs review.</p>
      ) : null}
    </Page>
  );
}
