import { OUTCOME_COPY, formatMoney, type VisitOutcome } from '../shopper-flow';
import type { ShopperView } from '../types';

/**
 * Screen 4 — payment.
 *
 * There is no payment FORM here, and there never will be. Money moves
 * through Phase 6's provider-neutral intent state machine, driven by Phase
 * 26's exit, with `SIMULATED` as the only provider this repository has. This
 * screen reports what that state machine did; it does not collect anything,
 * and it never sees a payment instrument.
 *
 * A payment that did not go through is shown as an instruction ("pay at the
 * counter"), not as a retry button: retrying payment is a decision a person
 * makes, not a side effect of tapping twice on a phone.
 */
export function PaymentScreen({
  view,
  outcome,
  onFinish,
}: {
  view: ShopperView;
  outcome: VisitOutcome;
  onFinish: () => void;
}) {
  const copy = OUTCOME_COPY[outcome];
  const paid = formatMoney(
    view.settlement.paidMinor,
    view.settlement.currencyCode,
  );

  return (
    <main className="screen">
      <header className="screen-head">
        <h1>{copy.title}</h1>
        <p className="lede">{copy.detail}</p>
      </header>

      {view.settlement.orderNumber ? (
        <dl className={`receipt receipt-${copy.tone}`}>
          <div>
            <dt>Order</dt>
            <dd>{view.settlement.orderNumber}</dd>
          </div>
          {paid ? (
            <div>
              <dt>{outcome === 'PAID' ? 'Paid' : 'Amount'}</dt>
              <dd>{paid}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {view.basket.lines.length > 0 ? (
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
      ) : null}

      <button type="button" className="primary" onClick={onFinish}>
        Done
      </button>

      <p className="fine-print">
        We never ask for card details in this app. Payment is handled by the
        store.
      </p>
    </main>
  );
}
