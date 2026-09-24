import { FormEvent, useState } from 'react';
import {
  api,
  ApiError,
  Paginated,
  PriceBook,
  PriceBookEntry,
  PriceBookVersion,
  Product,
  ResolvedPrice,
  Store,
} from '../api';
import {
  Card,
  Disclosure,
  EmptyState,
  Field,
  FormRow,
  formatDate,
  Notice,
  Page,
  Section,
  StatusBadge,
  useLoad,
} from '../components';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/** Minor units → a readable amount. Display only; never used for maths. */
function formatMoney(minor: number | null, currencyCode: string | null): string {
  if (minor === null || currencyCode === null) {
    return '—';
  }
  return `${(minor / 100).toFixed(2)} ${currencyCode}`;
}

function versionTone(version: PriceBookVersion): string {
  return version.status;
}

export function PricingPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);

  const { data, error, loading } = useLoad<Paginated<PriceBook>>(
    () => api('/price-books?take=100'),
    [reloadKey],
  );
  const stores = useLoad<Paginated<Store> | null>(
    () => api<Paginated<Store>>('/stores?take=100').catch(() => null),
    [],
  );
  const products = useLoad<Paginated<Product> | null>(
    () => api<Paginated<Product>>('/catalog/products?take=200').catch(() => null),
    [],
  );

  return (
    <Page
      title="Pricing"
      description="Price books are versioned. Changing a price means creating a new version and activating it; history is never rewritten, and any earlier version can be rolled back to."
      error={error}
      loading={loading}
    >
      <CreateBookForm stores={stores.data?.items ?? []} onCreated={reload} />
      <ResolvePriceForm
        products={products.data?.items ?? []}
        stores={stores.data?.items ?? []}
      />
      {data && data.items.length === 0 ? (
        <EmptyState>
          No price books yet. Create one above, add prices to its draft
          version, then activate it — basket lines pick the price up from
          there.
        </EmptyState>
      ) : null}
      {data?.items.map((book) => (
        <PriceBookCard
          key={book.id}
          book={book}
          products={products.data?.items ?? []}
          onChanged={reload}
        />
      ))}
    </Page>
  );
}

function CreateBookForm({
  stores,
  onCreated,
}: {
  stores: Store[];
  onCreated: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [currencyCode, setCurrencyCode] = useState('AED');
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/price-books', {
        method: 'POST',
        body: {
          code,
          name,
          currencyCode,
          ...(locationId ? { locationId } : {}),
        },
      });
      setCode('');
      setName('');
      onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="New price book"
      description="A book scoped to a store overrides the tenant-wide book there."
    >
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Code" required>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="RETAIL"
                required
              />
            </Field>
            <Field label="Name" required>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Retail prices"
                required
              />
            </Field>
            <Field label="Currency" required hint="ISO-4217, e.g. AED">
              <input
                value={currencyCode}
                onChange={(event) => setCurrencyCode(event.target.value)}
                maxLength={3}
                required
              />
            </Field>
            <Field label="Store" hint="Leave empty for the tenant-wide book">
              <select
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">All stores</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </Field>
          </FormRow>
          {formError ? <Notice tone="critical">{formError}</Notice> : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create price book'}
          </button>
        </form>
      </Card>
    </Section>
  );
}

function ResolvePriceForm({
  products,
  stores,
}: {
  products: Product[];
  stores: Store[];
}) {
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [at, setAt] = useState('');
  const [result, setResult] = useState<ResolvedPrice | null | undefined>(
    undefined,
  );
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setResult(undefined);
    try {
      const query = new URLSearchParams({ productId });
      if (locationId) {
        query.set('locationId', locationId);
      }
      if (at) {
        query.set('at', new Date(at).toISOString());
      }
      setResult(await api<ResolvedPrice | null>(`/prices/resolve?${query}`));
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  return (
    <Section
      title="What does this cost?"
      description="Answers at an instant. A past date returns what the product actually cost then, because superseded versions keep their effective windows."
    >
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Product" required>
              <select
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                required
              >
                <option value="">Select…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Store">
              <select
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">None</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="At" hint="Defaults to now">
              <input
                type="datetime-local"
                value={at}
                onChange={(event) => setAt(event.target.value)}
              />
            </Field>
          </FormRow>
          {formError ? <Notice tone="critical">{formError}</Notice> : null}
          <button type="submit">Resolve</button>
        </form>
        {result === null ? (
          <Notice tone="warn">
            No price book covers this product here. A basket line would be
            recorded unpriced — not free.
          </Notice>
        ) : null}
        {result ? (
          <Notice tone="ok">
            {formatMoney(result.unitPriceMinor, result.currencyCode)} from
            version {result.priceBookVersionId}
          </Notice>
        ) : null}
      </Card>
    </Section>
  );
}

function PriceBookCard({
  book,
  products,
  onChanged,
}: {
  book: PriceBook;
  products: Product[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setCardError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setCardError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const versions = book.versions ?? [];
  const activeVersion = versions.find((version) => version.status === 'ACTIVE');

  return (
    <Section
      title={`${book.code} — ${book.name}`}
      description={
        book.location
          ? `${book.currencyCode} · ${book.location.name} only`
          : `${book.currencyCode} · all stores`
      }
      actions={
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(() =>
              api(`/price-books/${book.id}/versions`, {
                method: 'POST',
                body: { reason: 'PRICE_CHANGE' },
              }),
            )
          }
        >
          New draft version
        </button>
      }
    >
      <Card>
        <StatusBadge status={book.status} />
        {cardError ? <Notice tone="critical">{cardError}</Notice> : null}
        {versions.length === 0 ? (
          <EmptyState>
            No versions yet. Create a draft, set its prices, then activate it.
          </EmptyState>
        ) : null}
        {versions.map((version) => (
          <Disclosure
            key={version.id}
            defaultOpen={version.id === activeVersion?.id}
            summary={
              <>
                v{version.versionNumber} <StatusBadge status={versionTone(version)} />{' '}
                <span className="muted">
                  {formatDate(version.effectiveFrom)}
                  {version.effectiveTo
                    ? ` → ${formatDate(version.effectiveTo)}`
                    : ' → current'}
                  {version.reason === 'ROLLBACK' ? ' · rollback' : ''}
                </span>
              </>
            }
          >
            <VersionPanel
              book={book}
              version={version}
              products={products}
              busy={busy}
              onRun={run}
            />
          </Disclosure>
        ))}
      </Card>
    </Section>
  );
}

function VersionPanel({
  book,
  version,
  products,
  busy,
  onRun,
}: {
  book: PriceBook;
  version: PriceBookVersion;
  products: Product[];
  busy: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { data: entries } = useLoad<PriceBookEntry[]>(
    () => api(`/price-books/${book.id}/versions/${version.id}/entries`),
    [book.id, version.id, busy],
  );
  const [draft, setDraft] = useState<Record<string, string>>({});

  const isDraft = version.status === 'DRAFT';
  const canRollBackTo =
    version.status === 'SUPERSEDED' || version.status === 'ACTIVE';

  async function saveEntries() {
    const payload = Object.entries(draft)
      .filter(([, value]) => value.trim() !== '')
      .map(([productId, value]) => ({
        productId,
        unitPriceMinor: Math.round(Number(value) * 100),
      }));
    await onRun(() =>
      api(`/price-books/${book.id}/versions/${version.id}/entries`, {
        method: 'PUT',
        body: { entries: payload },
      }),
    );
  }

  return (
    <>
      {version.note ? <p className="muted">{version.note}</p> : null}
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Product</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {(entries ?? []).map((entry) => (
            <tr key={entry.id}>
              <td>{entry.product.sku}</td>
              <td>{entry.product.name}</td>
              <td>{formatMoney(entry.unitPriceMinor, entry.currencyCode)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {isDraft ? (
        <>
          <p className="muted">
            Set the whole price list for this draft. A version is a complete
            snapshot, so anything left blank is not in it.
          </p>
          <FormRow>
            {products.map((product) => (
              <Field key={product.id} label={`${product.sku}`}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={
                    draft[product.id] ??
                    (entries?.find((entry) => entry.productId === product.id)
                      ? String(
                          (entries.find(
                            (entry) => entry.productId === product.id,
                          )!.unitPriceMinor ?? 0) / 100,
                        )
                      : '')
                  }
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [product.id]: event.target.value,
                    }))
                  }
                />
              </Field>
            ))}
          </FormRow>
          <button type="button" disabled={busy} onClick={saveEntries}>
            Save prices
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onRun(() =>
                api(
                  `/price-books/${book.id}/versions/${version.id}/activate`,
                  { method: 'POST', body: {} },
                ),
              )
            }
          >
            Activate
          </button>
        </>
      ) : null}

      {canRollBackTo && version.status !== 'ACTIVE' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onRun(() =>
              api(`/price-books/${book.id}/versions/${version.id}/rollback`, {
                method: 'POST',
                body: { note: `Rolled back to v${version.versionNumber}` },
              }),
            )
          }
        >
          Roll back to this version
        </button>
      ) : null}
    </>
  );
}
