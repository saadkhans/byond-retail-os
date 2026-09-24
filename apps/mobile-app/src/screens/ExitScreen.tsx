import { OUTCOME_COPY, formatMoney } from '../shopper-flow';
import type { ShopperView } from '../types';

/**
 * Screen 3 — exit.
 *
 * Two states live here, and neither is an error page.
 *
 * "Checking you out" is the exit in flight. "Checking with a colleague" is
 * Phase 26 refusing to settle while an observation still waits for a human —
 * a deliberate, correct refusal that protects the shopper from being billed
 * for something nobody confirmed. Dressing it as a failure would train
 * people to walk away from it.
 */
export function ExitScreen({
  view,
  inFlight,
  onRetry,
}: {
  view: ShopperView;
  inFlight: boolean;
  onRetry: () => void;
}) {
  const copy = OUTCOME_COPY.AWAITING_COLLEAGUE;
  const total = formatMoney(view.basket.totalMinor, view.basket.currencyCode);

  return (
    <main className="screen">
      <header className="screen-head">
        <h1>{inFlight ? 'Checking you out…' : copy.title}</h1>
        <p className="lede">
          {inFlight
            ? 'One moment while we finish your visit.'
            : copy.detail}
        </p>
      </header>

      {view.basket.lines.length > 0 ? (
        <>
          <ul className="lines">
            {view.basket.lines.map((line) => (
              <li key={line.id} className="line">
                <div className="line-main">
                  <span className="line-name">{line.productName}</span>
                  <span className="line-sku">{line.sku}</span>
                </div>
                <div className="line-side">
                  <span className="line-qty">{line.quantity}&times;</span>
                  <span className="line-total">
                    {formatMoney(line.lineTotalMinor, line.currencyCode) ?? '—'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="total">
            <span>Total</span>
            <strong>{total ?? 'a colleague will confirm'}</strong>
          </div>
        </>
      ) : (
        <p className="empty">You are not taking anything with you.</p>
      )}

      {inFlight ? null : (
        <button type="button" className="primary" onClick={onRetry}>
          Check again
        </button>
      )}

      <p className="fine-print">
        We never ask for card details in this app. Payment is handled by the
        store.
      </p>
    </main>
  );
}
