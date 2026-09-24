import { FormEvent, useState } from 'react';
import {
  api,
  ApiError,
  CycleCount,
  CycleCountLine,
  OrderReturn,
  OrderReturnLine,
  Paginated,
  ShrinkEvent,
  Store,
} from '../api';
import {
  Card,
  DataTable,
  Disclosure,
  EmptyState,
  Field,
  FormRow,
  formatDate,
  Notice,
  Page,
  Section,
  StatusBadge,
  Tabs,
  useLoad,
} from '../components';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/** Minor units → a readable amount. Display only; never used for maths. */
function formatMoney(
  minor: number | null | undefined,
  currencyCode: string | null | undefined,
): string {
  if (minor === null || minor === undefined || !currencyCode) {
    return '—';
  }
  return `${(minor / 100).toFixed(2)} ${currencyCode}`;
}

/** A signed quantity, rendered so the direction is unmissable. */
function formatDelta(value: number | null): string {
  if (value === null) {
    return '—';
  }
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Plain-language explanation of why a return moved no money. Operators need
 * to know the difference between "we chose not to" and "there was nothing to
 * give back" without reading the enum.
 */
const REFUND_SKIP_EXPLANATION: Record<string, string> = {
  NOT_REQUESTED: 'Stock-only return: no refund was asked for.',
  NO_CAPTURED_PAYMENT:
    'No payment on this order ever captured, so there is nothing to give back.',
  NO_PRICEABLE_LINES:
    'The returned lines carry no price, so no amount can be justified.',
  ALREADY_FULLY_REFUNDED:
    'Everything this order captured has already been refunded.',
};

export function ReturnsPage() {
  const [tab, setTab] = useState('returns');
  return (
    <Page
      title="Returns & reconciliation"
      description="The reverse flow. Goods come back, money goes back, and counts are squared against the books — all of it by appending to the inventory ledger, never by editing a stock level."
    >
      <Tabs
        tabs={[
          { id: 'returns', label: 'Returns' },
          { id: 'counts', label: 'Cycle counts' },
          { id: 'shrink', label: 'Shrink' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'returns' ? <ReturnsTab /> : null}
      {tab === 'counts' ? <CycleCountsTab /> : null}
      {tab === 'shrink' ? <ShrinkTab /> : null}
    </Page>
  );
}

// ---------------------------------------------------------------------- returns

function ReturnsTab() {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);
  const { data, error, loading } = useLoad<Paginated<OrderReturn>>(
    () => api('/returns?take=50'),
    [reloadKey],
  );

  return (
    <>
      <RecordReturnForm onRecorded={reload} />
      <Section
        title="Recorded returns and cancellations"
        description="Each one lists the lines that came back, the ledger movement every restocked line produced, and the refund it triggered — or, in plain words, why there was none."
      >
        {error ? <Notice tone="critical">{error}</Notice> : null}
        {loading ? <p className="muted">Loading…</p> : null}
        {data && data.items.length === 0 ? (
          <EmptyState>
            Nothing has come back yet. A return puts goods back on the shelf as
            a RETURN_IN ledger movement and refunds what the returned lines
            were worth, bounded by what the order actually captured.
          </EmptyState>
        ) : null}
        {data?.items.map((item) => (
          <ReturnCard key={item.id} item={item} />
        ))}
      </Section>
    </>
  );
}

function ReturnCard({ item }: { item: OrderReturn }) {
  return (
    <Card>
      <div className="row-between">
        <div>
          <strong>{item.order?.orderNumber ?? item.orderId}</strong>{' '}
          <span className="muted">{item.reference}</span>
        </div>
        <StatusBadge status={item.status} />
      </div>
      <p className="muted">
        {item.kind === 'ORDER_CANCELLATION'
          ? 'Cancellation — everything still outstanding was reversed and the order cancelled.'
          : 'Customer return.'}{' '}
        {item.reason}
      </p>
      <FormRow>
        <div>
          <span className="muted">Units back on the shelf</span>
          <div>{item.restockedQuantity}</div>
        </div>
        <div>
          <span className="muted">Returned value</span>
          <div>{formatMoney(item.refundAmountMinor, item.currencyCode)}</div>
        </div>
        <div>
          <span className="muted">Refunded</span>
          <div>
            {item.refund
              ? formatMoney(item.refund.amountMinor, item.refund.currencyCode)
              : '—'}
          </div>
        </div>
        <div>
          <span className="muted">Recorded</span>
          <div>{formatDate(item.createdAt)}</div>
        </div>
      </FormRow>
      {item.refundSkipReason ? (
        <Notice tone="info">
          No money moved.{' '}
          {REFUND_SKIP_EXPLANATION[item.refundSkipReason] ??
            item.refundSkipReason}
        </Notice>
      ) : null}
      {item.status === 'REFUND_FAILED' ? (
        <Notice tone="critical">
          The refund was declined. The goods are correctly back in stock; the
          money has not moved. Record a new return, or refund the payment by
          hand, once the cause is understood.
        </Notice>
      ) : null}
      <Disclosure summary={`Lines (${item.lines?.length ?? 0})`}>
        <DataTable<OrderReturnLine>
          columns={[
            { key: 'sku', header: 'SKU', render: (line) => line.sku },
            {
              key: 'name',
              header: 'Product',
              render: (line) => line.productName,
            },
            {
              key: 'qty',
              header: 'Units',
              numeric: true,
              render: (line) => line.quantity,
            },
            {
              key: 'restocked',
              header: 'Back on shelf',
              render: (line) => (line.restocked ? 'Yes' : 'No — not resellable'),
            },
            {
              key: 'movement',
              header: 'Ledger movement',
              render: (line) =>
                line.movementId ? (
                  <code>{line.movementId}</code>
                ) : (
                  <span className="muted">none — stock did not change</span>
                ),
            },
            {
              key: 'value',
              header: 'Value',
              numeric: true,
              render: (line) =>
                formatMoney(line.refundAmountMinor, item.currencyCode),
            },
          ]}
          rows={item.lines ?? []}
          rowKey={(line) => line.id}
        />
      </Disclosure>
    </Card>
  );
}

function RecordReturnForm({ onRecorded }: { onRecorded: () => void }) {
  const [orderId, setOrderId] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [orderLineId, setOrderLineId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [restock, setRestock] = useState(true);
  const [cancelWholeOrder, setCancelWholeOrder] = useState(false);
  const [refund, setRefund] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/returns', {
        method: 'POST',
        body: {
          orderId,
          kind: cancelWholeOrder ? 'ORDER_CANCELLATION' : 'CUSTOMER_RETURN',
          reference,
          reason,
          refund,
          ...(cancelWholeOrder
            ? {}
            : {
                lines: [
                  {
                    orderLineId,
                    quantity: Number(quantity),
                    restock,
                  },
                ],
              }),
        },
      });
      setReference('');
      setReason('');
      setOrderLineId('');
      setQuantity('1');
      onRecorded();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Record a return"
      description="Goods first, money second. The lines go back into stock as ledger movements in one transaction; only then is a refund attempted, and only against a payment that actually captured."
    >
      <form onSubmit={submit}>
        {formError ? <Notice tone="critical">{formError}</Notice> : null}
        <FormRow>
          <Field label="Order id" required>
            <input
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              required
            />
          </Field>
          <Field
            label="Reference"
            required
            hint="Your own reference. Sending the same one twice replays the original return instead of reversing stock or refunding money again."
          >
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              required
            />
          </Field>
        </FormRow>
        <Field
          label="Reason"
          required
          hint="Kept in the ledger forever. Never paste card numbers, tokens or passwords — the server rejects them."
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </Field>
        <Field label="Cancel the whole order">
          <input
            type="checkbox"
            checked={cancelWholeOrder}
            onChange={(event) => setCancelWholeOrder(event.target.checked)}
          />
        </Field>
        {cancelWholeOrder ? (
          <Notice tone="info">
            Everything still outstanding on the order comes back into stock and
            the order is cancelled. This is the only way to cancel an order that
            has already been paid.
          </Notice>
        ) : (
          <FormRow>
            <Field label="Order line id" required>
              <input
                value={orderLineId}
                onChange={(event) => setOrderLineId(event.target.value)}
                required
              />
            </Field>
            <Field label="Units" required>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </Field>
            <Field
              label="Back on the shelf"
              hint="Clear this for damaged or unsellable goods: no stock movement is written, which is the honest record that stock did not change."
            >
              <input
                type="checkbox"
                checked={restock}
                onChange={(event) => setRestock(event.target.checked)}
              />
            </Field>
          </FormRow>
        )}
        <Field
          label="Refund the money"
          hint="Never more than the order captured, less anything already refunded."
        >
          <input
            type="checkbox"
            checked={refund}
            onChange={(event) => setRefund(event.target.checked)}
          />
        </Field>
        <button type="submit" disabled={busy}>
          {busy ? 'Recording…' : 'Record return'}
        </button>
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ cycle counts

function CycleCountsTab() {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);
  const { data, error, loading } = useLoad<Paginated<CycleCount>>(
    () => api('/cycle-counts?take=50'),
    [reloadKey],
  );
  const stores = useLoad<Paginated<Store> | null>(
    () => api<Paginated<Store>>('/stores?take=100').catch(() => null),
    [],
  );

  return (
    <>
      <OpenCountForm stores={stores.data?.items ?? []} onOpened={reload} />
      <Section
        title="Counts and stocktakes"
        description="Reconciling compares what was counted with what the projection says AND with what the ledger replays to. A difference becomes a signed correction movement; a count that agrees writes nothing."
      >
        {error ? <Notice tone="critical">{error}</Notice> : null}
        {loading ? <p className="muted">Loading…</p> : null}
        {data && data.items.length === 0 ? (
          <EmptyState>
            No counts yet. Open one for a store, record what you find product by
            product, then reconcile.
          </EmptyState>
        ) : null}
        {data?.items.map((count) => (
          <CycleCountCard key={count.id} count={count} onChanged={reload} />
        ))}
      </Section>
    </>
  );
}

function CycleCountCard({
  count,
  onChanged,
}: {
  count: CycleCount;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const drifted = (count.lines ?? []).filter(
    (line) => (line.ledgerDriftQuantity ?? 0) !== 0,
  );

  async function act(path: string) {
    setBusy(true);
    setCardError(null);
    try {
      await api(`/cycle-counts/${count.id}/${path}`, {
        method: 'POST',
        body: {},
      });
      onChanged();
    } catch (err) {
      setCardError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="row-between">
        <div>
          <strong>{count.reference}</strong>{' '}
          <span className="muted">
            {count.location?.name ?? count.locationId}
            {count.isFullStocktake ? ' · full stocktake' : ' · cycle count'}
          </span>
        </div>
        <StatusBadge status={count.status} />
      </div>
      {cardError ? <Notice tone="critical">{cardError}</Notice> : null}
      {drifted.length > 0 ? (
        <Notice tone="critical">
          The stock projection disagrees with its own ledger history for{' '}
          {drifted.length} product(s). That is a platform problem, not a stock
          discrepancy — it has NOT been corrected here. Raise it before trusting
          these numbers.
        </Notice>
      ) : null}
      <DataTable<CycleCountLine>
        columns={[
          {
            key: 'product',
            header: 'Product',
            render: (line) => <code>{line.productId}</code>,
          },
          {
            key: 'counted',
            header: 'Counted',
            numeric: true,
            render: (line) => line.countedQuantity,
          },
          {
            key: 'system',
            header: 'Projection',
            numeric: true,
            render: (line) => line.systemQuantity ?? '—',
          },
          {
            key: 'ledger',
            header: 'Ledger replay',
            numeric: true,
            render: (line) => line.ledgerQuantity ?? '—',
          },
          {
            key: 'variance',
            header: 'Variance',
            numeric: true,
            render: (line) => formatDelta(line.varianceQuantity),
          },
          {
            key: 'movement',
            header: 'Correction movement',
            render: (line) =>
              line.movementId ? (
                <code>{line.movementId}</code>
              ) : (
                <span className="muted">
                  {line.varianceQuantity === 0
                    ? 'agreed — nothing written'
                    : 'not reconciled yet'}
                </span>
              ),
          },
        ]}
        rows={count.lines ?? []}
        rowKey={(line) => line.id}
        empty="Nothing counted yet."
      />
      {count.status === 'OPEN' ? (
        <>
          <RecordCountLineForm countId={count.id} onRecorded={onChanged} />
          <div className="actions">
            <button disabled={busy} onClick={() => act('reconcile')}>
              Reconcile against the ledger
            </button>
            <button disabled={busy} onClick={() => act('cancel')}>
              Abandon
            </button>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function RecordCountLineForm({
  countId,
  onRecorded,
}: {
  countId: string;
  onRecorded: () => void;
}) {
  const [productId, setProductId] = useState('');
  const [countedQuantity, setCountedQuantity] = useState('0');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api(`/cycle-counts/${countId}/lines`, {
        method: 'POST',
        body: {
          productId,
          countedQuantity: Number(countedQuantity),
          ...(note ? { note } : {}),
        },
      });
      setProductId('');
      setCountedQuantity('0');
      setNote('');
      onRecorded();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {formError ? <Notice tone="critical">{formError}</Notice> : null}
      <FormRow>
        <Field label="Product id" required>
          <input
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
            required
          />
        </Field>
        <Field label="Units found" required>
          <input
            type="number"
            min={0}
            value={countedQuantity}
            onChange={(event) => setCountedQuantity(event.target.value)}
            required
          />
        </Field>
        <Field
          label="Discrepancy note"
          hint="Kept in the record. Never paste card numbers or credentials."
        >
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </FormRow>
      <button type="submit" disabled={busy}>
        {busy ? 'Recording…' : 'Record count'}
      </button>
    </form>
  );
}

function OpenCountForm({
  stores,
  onOpened,
}: {
  stores: Store[];
  onOpened: () => void;
}) {
  const [locationId, setLocationId] = useState('');
  const [reference, setReference] = useState('');
  const [isFullStocktake, setIsFullStocktake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/cycle-counts', {
        method: 'POST',
        body: { locationId, reference, isFullStocktake },
      });
      setReference('');
      onOpened();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Open a count"
      description="Opening a count changes nothing at all. Counting changes nothing. Only reconciling writes to the ledger — and then only the difference."
    >
      <form onSubmit={submit}>
        {formError ? <Notice tone="critical">{formError}</Notice> : null}
        <FormRow>
          <Field label="Store" required>
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              required
            >
              <option value="">Select a store…</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reference" required>
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              required
            />
          </Field>
          <Field label="Full stocktake">
            <input
              type="checkbox"
              checked={isFullStocktake}
              onChange={(event) => setIsFullStocktake(event.target.checked)}
            />
          </Field>
        </FormRow>
        <button type="submit" disabled={busy}>
          {busy ? 'Opening…' : 'Open count'}
        </button>
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------------ shrink

function ShrinkTab() {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);
  const { data, error, loading } = useLoad<Paginated<ShrinkEvent>>(
    () => api('/shrink-events?take=50'),
    [reloadKey],
  );

  return (
    <>
      <RecordShrinkForm onRecorded={reload} />
      <Section
        title="Recorded write-offs"
        description="Each one removes real stock, so each one names the observation it came from and the ledger movement it produced."
      >
        {error ? <Notice tone="critical">{error}</Notice> : null}
        {loading ? <p className="muted">Loading…</p> : null}
        <DataTable<ShrinkEvent>
          columns={[
            {
              key: 'product',
              header: 'Product',
              render: (row) => <code>{row.productId}</code>,
            },
            {
              key: 'qty',
              header: 'Units',
              numeric: true,
              render: (row) => row.quantity,
            },
            {
              key: 'observation',
              header: 'Observation',
              render: (row) =>
                row.visionEventId ? (
                  <code>{row.visionEventId}</code>
                ) : (
                  <span className="muted">—</span>
                ),
            },
            {
              key: 'movement',
              header: 'Ledger movement',
              render: (row) => <code>{row.movementId}</code>,
            },
            { key: 'reason', header: 'Reason', render: (row) => row.reason },
            {
              key: 'when',
              header: 'Recorded',
              render: (row) => formatDate(row.createdAt),
            },
          ]}
          rows={data?.items ?? []}
          rowKey={(row) => row.id}
          empty="Nothing has been written off."
        />
      </Section>
    </>
  );
}

function RecordShrinkForm({ onRecorded }: { onRecorded: () => void }) {
  const [visionEventId, setVisionEventId] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/shrink-events', {
        method: 'POST',
        body: {
          visionEventId,
          productId,
          quantity: Number(quantity),
          reason,
        },
      });
      setVisionEventId('');
      setProductId('');
      setQuantity('1');
      setReason('');
      onRecorded();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Write off a detected loss"
      description="Turns one reviewed pickup that no live order accounts for into a SHRINK ledger movement."
    >
      <Notice tone="warn">
        This removes real stock from the books. It is allowed only for an
        observation a human has already decided, only for a product the camera
        actually proposed, and only once per observation. A confidence score is
        not a probability — decide the observation in the review queue first.
      </Notice>
      <form onSubmit={submit}>
        {formError ? <Notice tone="critical">{formError}</Notice> : null}
        <FormRow>
          <Field label="Observation id" required>
            <input
              value={visionEventId}
              onChange={(event) => setVisionEventId(event.target.value)}
              required
            />
          </Field>
          <Field label="Product id" required>
            <input
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              required
            />
          </Field>
          <Field label="Units" required>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              required
            />
          </Field>
        </FormRow>
        <Field
          label="Why this is loss"
          required
          hint="Kept in the ledger forever. Never paste card numbers or credentials."
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </Field>
        <button type="submit" disabled={busy}>
          {busy ? 'Recording…' : 'Write off'}
        </button>
      </form>
    </Section>
  );
}
