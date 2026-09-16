import {
  basketIsLegitimatelyEmpty,
  detectionNotice,
  formatMoney,
} from '../shopper-flow';
import type { ShopperView } from '../types';

/**
 * Screen 2 — the live basket.
 *
 * This screen's hardest job is telling the truth about an empty list. Under
 * the default SHADOW policy the store observes and changes nothing, so an
 * empty basket is the CORRECT answer, not a failure — and the shopper is
 * told exactly that, rather than being shown a spinner that implies items
 * are on their way.
 */
export function BasketScreen({
  view,
  stale,
  onLeave,
}: {
  view: ShopperView;
  stale: boolean;
  onLeave: () => void;
}) {
  const notice = detectionNotice(view.detection);
  const total = formatMoney(view.basket.totalMinor, view.basket.currencyCode);
  const emptyOnPurpose = basketIsLegitimatelyEmpty(view);

  return (
    <main className="screen">
      <header className="screen-head">
        <h1>Your basket</h1>
        <p className="lede">{notice.title}</p>
      </header>

      <div className="notice" role="status">
        <p>{notice.detail}</p>
      </div>

      {stale ? (
        <div className="notice notice-problem" role="status">
          <p>
            We are having trouble staying in touch with the store, so this list
            may be out of date.
          </p>
        </div>
      ) : null}

      {view.basket.lines.length === 0 ? (
        <p className="empty">
          {emptyOnPurpose
            ? 'Nothing here — and nothing will appear, because this store is not adding items automatically today.'
            : 'Nothing here yet. Items appear shortly after you pick them up.'}
        </p>
      ) : (
        <ul className="lines">
          {view.basket.lines.map((line) => {
            const lineTotal = formatMoney(line.lineTotalMinor, line.currencyCode);
            return (
              <li key={line.id} className="line">
                <div className="line-main">
                  <span className="line-name">{line.productName}</span>
                  <span className="line-sku">{line.sku}</span>
                </div>
                <div className="line-side">
                  <span className="line-qty">{line.quantity}&times;</span>
                  <span className="line-total">{lineTotal ?? '—'}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {view.basket.lines.length > 0 ? (
        <div className="total">
          <span>Total so far</span>
          <strong>{total ?? 'we will confirm at the door'}</strong>
        </div>
      ) : null}

      {view.basket.hasUnpricedLine ? (
        <p className="help">
          One item has no price yet, so this total is not the full amount. A
          colleague will confirm it.
        </p>
      ) : null}

      <button type="button" className="primary" onClick={onLeave}>
        I&rsquo;m leaving
      </button>

      <p className="fine-print">
        We never ask for card details in this app. Payment is handled by the
        store.
      </p>
    </main>
  );
}
