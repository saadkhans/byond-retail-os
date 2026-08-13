import { FormEvent, useState } from 'react';
import { ApiError, Paginated, Product, StockLevel, Store, api } from '../api';
import { Page, useLoad } from '../components';

const MOVEMENT_TYPES = ['RECEIPT', 'CORRECTION_IN', 'CORRECTION_OUT'] as const;

interface MovementResponse {
  movement: { id: string; quantityDelta: number; movementType: string };
  level: { quantity: number };
  replayed: boolean;
}

/**
 * "Record inventory movement" — the SAFE write path onto the append-only
 * ledger: positive quantities with the type carrying direction, a
 * mandatory reason and external reference (the idempotency key), and an
 * EXPLICIT confirmation step before anything is recorded. Levels are
 * projections; nothing here overwrites a quantity.
 */
function RecordMovementForm({ onRecorded }: { onRecorded: () => void }) {
  const [locationId, setLocationId] = useState('');
  const [productId, setProductId] = useState('');
  const [movementType, setMovementType] =
    useState<(typeof MOVEMENT_TYPES)[number]>('RECEIPT');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const stores = useLoad<Paginated<Store>>(
    () => api<Paginated<Store>>('/stores?take=100'),
    [],
  );
  const products = useLoad<Paginated<Product>>(
    () => api<Paginated<Product>>('/catalog/products?take=100'),
    [],
  );

  const parsedQuantity = Number(quantity.trim());
  const valid =
    locationId !== '' &&
    productId !== '' &&
    Number.isInteger(parsedQuantity) &&
    parsedQuantity >= 1 &&
    reason.trim().length > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(reference.trim());

  const storeName =
    stores.data?.items.find((store) => store.id === locationId)?.name ?? '';
  const productLabel = (() => {
    const product = products.data?.items.find((item) => item.id === productId);
    return product ? `${product.name} (${product.sku})` : '';
  })();

  function requestConfirm(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!valid) {
      setError(
        'Fill every field: store, product, a whole quantity of at least 1, ' +
          'a reason, and a reference (letters/digits/._-).',
      );
      return;
    }
    // Explicit confirmation step — nothing is recorded yet.
    setConfirming(true);
  }

  async function confirmAndRecord() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<MovementResponse>('/inventory/movements', {
        method: 'POST',
        body: {
          locationId,
          productId,
          movementType,
          quantity: parsedQuantity,
          reason: reason.trim(),
          reference: reference.trim(),
        },
      });
      setNotice(
        result.replayed
          ? `Reference ${reference.trim()} was already recorded — replayed the ` +
              `existing movement (on hand now ${result.level.quantity}). No duplicate stock.`
          : `Movement recorded: ${movementType} ${parsedQuantity} → on hand ${result.level.quantity}.`,
      );
      setConfirming(false);
      onRecorded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ margin: '1rem 0', border: '1px solid var(--border, #d8d8e0)', borderRadius: 6, padding: '0.75rem' }}>
      <h2 style={{ marginTop: 0 }}>Record inventory movement</h2>
      <p className="muted">
        Appends to the immutable ledger (never overwrites a quantity). The
        reference is the idempotency key: retrying it can never create
        duplicate stock.
      </p>
      {error ? <div className="error">{error}</div> : null}
      {notice ? (
        <p className="muted" style={{ color: '#1e7e34' }}>
          ✓ {notice}
        </p>
      ) : null}
      <form className="toolbar" onSubmit={requestConfirm} style={{ flexWrap: 'wrap' }}>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Store…</option>
          {(stores.data?.items ?? []).map((store) => (
            <option key={store.id} value={store.id}>
              {store.name} ({store.code})
            </option>
          ))}
        </select>
        <select value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">Product…</option>
          {(products.data?.items ?? []).map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} ({product.sku})
            </option>
          ))}
        </select>
        <select
          value={movementType}
          onChange={(e) =>
            setMovementType(e.target.value as (typeof MOVEMENT_TYPES)[number])
          }
        >
          {MOVEMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          step={1}
          style={{ width: '6rem' }}
          title="Positive unit count — the movement type carries direction"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <input
          type="text"
          style={{ minWidth: '16rem' }}
          placeholder="Reason (audited)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <input
          type="text"
          style={{ minWidth: '14rem' }}
          placeholder="External/test reference (idempotency key)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy || confirming}>
          Record movement…
        </button>
      </form>
      {confirming ? (
        <div className="toolbar" style={{ background: 'rgba(255, 200, 80, 0.15)', borderRadius: 4, padding: '0.5rem' }}>
          <span>
            Confirm: <strong>{movementType}</strong> of{' '}
            <strong>{parsedQuantity}</strong> × {productLabel} at{' '}
            <strong>{storeName}</strong>, reference{' '}
            <code>{reference.trim()}</code>?
          </span>
          <button className="primary" disabled={busy} onClick={() => void confirmAndRecord()}>
            {busy ? 'Recording…' : 'Confirm and record'}
          </button>
          <button disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Stock levels (read-only projections) + the safe movement writer. */
export function InventoryPage() {
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [reload, setReload] = useState(0);

  const { data, error, loading } = useLoad<StockLevel[]>(
    () => api(`/inventory/levels${lowStockOnly ? '?lowStockOnly=true' : ''}`),
    [lowStockOnly, reload],
  );

  return (
    <Page title="Inventory" error={error} loading={loading && !data}>
      <RecordMovementForm onRecorded={() => setReload((n) => n + 1)} />
      <div className="toolbar">
        <label>
          <input
            type="checkbox"
            checked={lowStockOnly}
            onChange={(e) => setLowStockOnly(e.target.checked)}
          />{' '}
          Low stock only
        </label>
        <span className="muted">{data?.length ?? 0} levels</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Location</th>
            <th>SKU</th>
            <th>Product</th>
            <th>On hand</th>
            <th>Low stock</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((level) => (
            <tr key={level.id}>
              <td>
                {level.location.name} ({level.location.code})
              </td>
              <td>{level.product.sku}</td>
              <td>{level.product.name}</td>
              <td>{level.quantity}</td>
              <td>
                {level.isLowStock ? (
                  <span className="badge down">LOW</span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
