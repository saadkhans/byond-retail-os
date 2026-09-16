import { FormEvent, useState } from 'react';
import {
  api,
  ApiError,
  GoodsReceipt,
  Paginated,
  Product,
  PurchaseOrder,
  PurchaseOrderLine,
  ReceiptMovement,
  Store,
  Supplier,
  SupplierProduct,
} from '../api';
import {
  Badge,
  Card,
  DataTable,
  Disclosure,
  EmptyState,
  Field,
  formatDate,
  FormRow,
  Notice,
  Page,
  Section,
  StatusBadge,
  useLoad,
} from '../components';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

/** Minor units to a readable amount. Display only; never used for maths. */
function formatMoney(minor: number | null, currencyCode: string): string {
  if (minor === null) {
    return '—';
  }
  return `${(minor / 100).toFixed(2)} ${currencyCode}`;
}

/** Today plus `days`, as the `yyyy-mm-dd` a date input wants. */
function addDaysAsDateInput(days: number): string {
  const target = new Date();
  target.setDate(target.getDate() + days);
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${target.getFullYear()}-${month}-${day}`;
}

export function ProcurementPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);

  const suppliers = useLoad<Paginated<Supplier>>(
    () => api('/suppliers?take=100'),
    [reloadKey],
  );
  const orders = useLoad<Paginated<PurchaseOrder>>(
    () => api('/purchase-orders?take=50'),
    [reloadKey],
  );
  const supplierProducts = useLoad<Paginated<SupplierProduct>>(
    () => api('/supplier-products?take=200'),
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
      title="Procurement"
      description="Suppliers, purchase orders and receiving. Everything received is admitted through the append-only inventory ledger, so a stock level and a replay of its movements can never disagree."
      error={suppliers.error ?? orders.error}
      loading={suppliers.loading || orders.loading}
    >
      <NewSupplierForm onCreated={reload} />
      <SupplierList suppliers={suppliers.data?.items ?? []} />
      <SupplierCatalog
        suppliers={(suppliers.data?.items ?? []).filter(
          (supplier) => supplier.status === 'ACTIVE',
        )}
        products={products.data?.items ?? []}
        links={supplierProducts.data?.items ?? []}
        onChanged={reload}
      />
      <NewOrderForm
        suppliers={(suppliers.data?.items ?? []).filter(
          (supplier) => supplier.status === 'ACTIVE',
        )}
        stores={stores.data?.items ?? []}
        products={products.data?.items ?? []}
        onCreated={reload}
      />
      <Section
        title="Purchase orders"
        description="Received and outstanding quantities are derived from the receipts posted against each line, not from a stored counter."
      >
        {orders.data && orders.data.items.length === 0 ? (
          <EmptyState>
            No purchase orders yet. Create one above, submit it to the
            supplier, then record what arrives.
          </EmptyState>
        ) : null}
        {orders.data?.items.map((order) => (
          <OrderCard key={order.id} order={order} onChanged={reload} />
        ))}
      </Section>
    </Page>
  );
}

function NewSupplierForm({ onCreated }: { onCreated: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [leadTimeDays, setLeadTimeDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/suppliers', {
        method: 'POST',
        body: {
          code,
          name,
          ...(contactEmail ? { contactEmail } : {}),
          ...(leadTimeDays ? { leadTimeDays: Number(leadTimeDays) } : {}),
        },
      });
      setCode('');
      setName('');
      setContactEmail('');
      setLeadTimeDays('');
      onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="New supplier"
      description="Suppliers are archived, never deleted, so past orders stay readable."
    >
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Code" required>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="ACME"
                required
              />
            </Field>
            <Field label="Name" required>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Acme Trading"
                required
              />
            </Field>
            <Field label="Orders email">
              <input
                type="email"
                value={contactEmail}
                onChange={(event) => setContactEmail(event.target.value)}
                placeholder="orders@acme.example"
              />
            </Field>
            <Field label="Lead time" hint="Days, used to suggest a date">
              <input
                type="number"
                min={0}
                max={365}
                value={leadTimeDays}
                onChange={(event) => setLeadTimeDays(event.target.value)}
              />
            </Field>
          </FormRow>
          {formError ? <Notice tone="critical">{formError}</Notice> : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create supplier'}
          </button>
        </form>
      </Card>
    </Section>
  );
}

function SupplierList({ suppliers }: { suppliers: Supplier[] }) {
  if (suppliers.length === 0) {
    return null;
  }
  return (
    <Section title="Suppliers">
      <Card>
        <DataTable
          rows={suppliers}
          rowKey={(supplier) => supplier.id}
          columns={[
            {
              key: 'code',
              header: 'Code',
              render: (supplier) => supplier.code,
            },
            {
              key: 'name',
              header: 'Name',
              render: (supplier) => supplier.name,
            },
            {
              key: 'status',
              header: 'Status',
              render: (supplier) => <StatusBadge status={supplier.status} />,
            },
            {
              key: 'contact',
              header: 'Orders email',
              render: (supplier) => supplier.contactEmail ?? '—',
            },
            {
              key: 'lead',
              header: 'Lead time',
              numeric: true,
              render: (supplier) =>
                supplier.leadTimeDays === null
                  ? '—'
                  : `${supplier.leadTimeDays} d`,
            },
          ]}
        />
      </Card>
    </Section>
  );
}

/**
 * What each supplier charges for a product. This is the only place the
 * supplier catalog can be populated, and it is what the order form falls back
 * to when a buyer leaves pack size and cost blank.
 *
 * Re-submitting an existing pair with a different cost APPENDS a history row
 * on the API side rather than overwriting the old figure, which is why the
 * form asks for a reason.
 */
function SupplierCatalog({
  suppliers,
  products,
  links,
  onChanged,
}: {
  suppliers: Supplier[];
  products: Product[];
  links: SupplierProduct[];
  onChanged: () => void;
}) {
  const [supplierId, setSupplierId] = useState('');
  const [productId, setProductId] = useState('');
  const [supplierSku, setSupplierSku] = useState('');
  const [packSize, setPackSize] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [currencyCode, setCurrencyCode] = useState('AED');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api(`/suppliers/${supplierId}/products`, {
        method: 'PUT',
        body: {
          productId,
          supplierSku,
          packSize: Number(packSize),
          unitCostMinor: Number(unitCost),
          currencyCode,
          ...(reason ? { reason } : {}),
        },
      });
      setSupplierSku('');
      setUnitCost('');
      setReason('');
      onChanged();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Supplier catalog"
      description="What a supplier calls one of our products, how many units are in a pack, and what a pack costs. Changing a cost appends a history row; it never overwrites the old figure."
    >
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Supplier" required>
              <select
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                required
              >
                <option value="">Choose…</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Product" required>
              <select
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                required
              >
                <option value="">Choose…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Supplier SKU"
              required
              hint="Their identifier, as printed on their paperwork"
            >
              <input
                value={supplierSku}
                onChange={(event) => setSupplierSku(event.target.value)}
                maxLength={80}
                required
              />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Pack size" required hint="Units of our product per pack">
              <input
                type="number"
                min={1}
                value={packSize}
                onChange={(event) => setPackSize(event.target.value)}
                required
              />
            </Field>
            <Field label="Cost per pack" required hint="Minor units, e.g. 1099">
              <input
                type="number"
                min={0}
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value)}
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
            <Field label="Reason" hint="Why the cost changed; stored on the history row">
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
              />
            </Field>
          </FormRow>
          {formError ? <Notice tone="critical">{formError}</Notice> : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Set supplier cost'}
          </button>
        </form>
      </Card>
      {links.length === 0 ? (
        <EmptyState>
          No supplier costs recorded yet. Until one exists, an order line has to
          state its own pack size and cost.
        </EmptyState>
      ) : (
        <Card>
          <DataTable
            rows={links}
            rowKey={(link) => link.id}
            columns={[
              {
                key: 'supplier',
                header: 'Supplier',
                render: (link) => link.supplier?.name ?? link.supplierId,
              },
              {
                key: 'product',
                header: 'Product',
                render: (link) =>
                  link.product
                    ? `${link.product.sku} — ${link.product.name}`
                    : link.productId,
              },
              {
                key: 'supplierSku',
                header: 'Supplier SKU',
                render: (link) => link.supplierSku,
              },
              {
                key: 'packSize',
                header: 'Pack size',
                numeric: true,
                render: (link) => link.packSize,
              },
              {
                key: 'cost',
                header: 'Cost / pack',
                numeric: true,
                render: (link) =>
                  formatMoney(link.unitCostMinor, link.currencyCode),
              },
            ]}
          />
        </Card>
      )}
    </Section>
  );
}

function NewOrderForm({
  suppliers,
  stores,
  products,
  onCreated,
}: {
  suppliers: Supplier[];
  stores: Store[];
  products: Product[];
  onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [currencyCode, setCurrencyCode] = useState('AED');
  const [expectedAt, setExpectedAt] = useState('');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [packSize, setPackSize] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Choosing a supplier suggests a delivery date from their recorded lead
   * time. It is only a suggestion — the buyer can clear or change it, and the
   * order is created without one if they do.
   */
  function chooseSupplier(nextSupplierId: string) {
    setSupplierId(nextSupplierId);
    const supplier = suppliers.find(
      (candidate) => candidate.id === nextSupplierId,
    );
    setExpectedAt(
      supplier?.leadTimeDays == null
        ? ''
        : addDaysAsDateInput(supplier.leadTimeDays),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/purchase-orders', {
        method: 'POST',
        body: {
          supplierId,
          locationId,
          currencyCode,
          ...(expectedAt
            ? { expectedAt: new Date(expectedAt).toISOString() }
            : {}),
          lines: [
            {
              productId,
              quantityOrdered: Number(quantity),
              ...(packSize ? { packSize: Number(packSize) } : {}),
              ...(unitCost ? { unitCostMinor: Number(unitCost) } : {}),
            },
          ],
        },
      });
      setQuantity('1');
      setPackSize('');
      setUnitCost('');
      onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="New purchase order"
      description="Creates a draft with one line. Pack size and cost come from the supplier catalog unless you override them here."
    >
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Supplier" required>
              <select
                value={supplierId}
                onChange={(event) => chooseSupplier(event.target.value)}
                required
              >
                <option value="">Choose…</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Deliver to" required hint="Receiving stocks here">
              <select
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                required
              >
                <option value="">Choose…</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Currency" required hint="ISO-4217, e.g. AED">
              <input
                value={currencyCode}
                onChange={(event) => setCurrencyCode(event.target.value)}
                maxLength={3}
                required
              />
            </Field>
            <Field
              label="Expected"
              hint="Suggested from the supplier lead time"
            >
              <input
                type="date"
                value={expectedAt}
                onChange={(event) => setExpectedAt(event.target.value)}
              />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Product" required>
              <select
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                required
              >
                <option value="">Choose…</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Packs" required>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </Field>
            <Field label="Pack size" hint="Units per pack; blank uses catalog">
              <input
                type="number"
                min={1}
                value={packSize}
                onChange={(event) => setPackSize(event.target.value)}
              />
            </Field>
            <Field label="Cost per pack" hint="Minor units; blank uses catalog">
              <input
                type="number"
                min={0}
                value={unitCost}
                onChange={(event) => setUnitCost(event.target.value)}
              />
            </Field>
          </FormRow>
          {formError ? <Notice tone="critical">{formError}</Notice> : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create draft order'}
          </button>
        </form>
      </Card>
    </Section>
  );
}

function OrderCard({
  order,
  onChanged,
}: {
  order: PurchaseOrder;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(path: string, body: unknown) {
    setBusy(true);
    setActionError(null);
    try {
      await api(path, { method: 'POST', body });
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const receivable =
    order.status === 'SUBMITTED' || order.status === 'PARTIALLY_RECEIVED';

  return (
    <Card>
      <h3>
        {order.reference} <StatusBadge status={order.status} />
      </h3>
      <p>
        {order.supplier?.name ?? 'Unknown supplier'} to{' '}
        {order.location?.name ?? 'unknown store'}. Ordered{' '}
        {formatDate(order.createdAt)}.{' '}
        {order.expectedAt ? `Expected ${formatDate(order.expectedAt)}. ` : null}
        {order.totalCostMinor === null
          ? `Running total ${formatMoney(order.computedTotalMinor, order.currencyCode)}.`
          : `Total ${formatMoney(order.totalCostMinor, order.currencyCode)}.`}
        {order.externalReference
          ? ` Supplier acknowledged as ${order.externalReference}.`
          : null}
        {order.cancelledReason ? ` Cancelled: ${order.cancelledReason}.` : null}
      </p>

      <DataTable
        rows={order.lines}
        rowKey={(line) => line.id}
        columns={[
          { key: 'sku', header: 'SKU', render: (line) => line.sku },
          {
            key: 'name',
            header: 'Product',
            render: (line) => line.productName,
          },
          {
            key: 'ordered',
            header: 'Packs ordered',
            numeric: true,
            render: (line) => line.quantityOrdered,
          },
          {
            key: 'received',
            header: 'Received',
            numeric: true,
            render: (line) => line.quantityReceived,
          },
          {
            key: 'outstanding',
            header: 'Outstanding',
            numeric: true,
            render: (line) =>
              line.quantityOutstanding === 0 ? (
                <Badge tone="ok">complete</Badge>
              ) : (
                line.quantityOutstanding
              ),
          },
          {
            key: 'units',
            header: 'Units in',
            numeric: true,
            render: (line) => line.unitsReceived,
          },
          {
            key: 'cost',
            header: 'Cost / pack',
            numeric: true,
            render: (line) =>
              formatMoney(line.unitCostMinor, line.currencyCode),
          },
        ]}
      />

      {actionError ? <Notice tone="critical">{actionError}</Notice> : null}

      {order.status === 'DRAFT' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => act(`/purchase-orders/${order.id}/submit`, {})}
        >
          {busy ? 'Submitting…' : 'Send to supplier'}
        </button>
      ) : null}

      {receivable ? (
        <ReceiveForm order={order} onReceived={onChanged} />
      ) : null}

      {order.status !== 'RECEIVED' && order.status !== 'CANCELLED' ? (
        <CancelForm order={order} onCancelled={onChanged} />
      ) : null}

      {order.receipts.length > 0 ? (
        <Disclosure summary={`${order.receipts.length} goods receipt(s)`}>
          {order.receipts.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} />
          ))}
        </Disclosure>
      ) : null}
    </Card>
  );
}

function ReceiveForm({
  order,
  onReceived,
}: {
  order: PurchaseOrder;
  onReceived: () => void;
}) {
  const outstanding = order.lines.filter(
    (line: PurchaseOrderLine) => line.quantityOutstanding > 0,
  );
  const [lineId, setLineId] = useState(outstanding[0]?.id ?? '');
  const [quantity, setQuantity] = useState('');
  const [deliveryNote, setDeliveryNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api(`/purchase-orders/${order.id}/receipts`, {
        method: 'POST',
        body: {
          ...(deliveryNote ? { deliveryNote } : {}),
          // A delivery note number is the natural replay guard: posting the
          // same note twice returns the receipt it already created rather
          // than stocking the lorry twice.
          ...(deliveryNote
            ? { idempotencyKey: `${order.id}:${deliveryNote}` }
            : {}),
          lines: [
            {
              purchaseOrderLineId: lineId,
              quantityReceived: Number(quantity),
            },
          ],
        },
      });
      setQuantity('');
      setDeliveryNote('');
      onReceived();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FormRow>
        <Field label="Line" required>
          <select
            value={lineId}
            onChange={(event) => setLineId(event.target.value)}
            required
          >
            <option value="">Choose…</option>
            {order.lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.sku} ({line.quantityOutstanding} outstanding)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Packs received" required>
          <input
            type="number"
            min={0}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            required
          />
        </Field>
        <Field
          label="Delivery note"
          hint="Also guards against posting twice"
        >
          <input
            value={deliveryNote}
            onChange={(event) => setDeliveryNote(event.target.value)}
            placeholder="DN-4471"
          />
        </Field>
      </FormRow>
      {formError ? <Notice tone="critical">{formError}</Notice> : null}
      <button type="submit" disabled={busy}>
        {busy ? 'Recording…' : 'Record delivery'}
      </button>
    </form>
  );
}

function CancelForm({
  order,
  onCancelled,
}: {
  order: PurchaseOrder;
  onCancelled: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api(`/purchase-orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason },
      });
      setReason('');
      onCancelled();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Disclosure summary="Cancel this order">
      <form onSubmit={submit}>
        <Notice tone="warn">
          Stock already received stays received. The ledger is append-only, so
          cancelling closes the order without unwinding any movement.
        </Notice>
        <FormRow>
          <Field label="Reason" required>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Supplier out of stock"
              required
            />
          </Field>
        </FormRow>
        {formError ? <Notice tone="critical">{formError}</Notice> : null}
        <button type="submit" disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel order'}
        </button>
      </form>
    </Disclosure>
  );
}

function ReceiptRow({ receipt }: { receipt: GoodsReceipt }) {
  const movements = useLoad<ReceiptMovement[] | null>(
    () =>
      api<ReceiptMovement[]>(
        `/goods-receipts/${receipt.id}/movements`,
      ).catch(() => null),
    [receipt.id],
  );

  return (
    <Card>
      <h4>
        {receipt.reference}
        {receipt.deliveryNote ? ` — note ${receipt.deliveryNote}` : ''}
      </h4>
      <p>Received {formatDate(receipt.receivedAt)}.</p>
      <DataTable
        rows={receipt.lines}
        rowKey={(line) => line.id}
        columns={[
          {
            key: 'product',
            header: 'Product',
            render: (line) => line.product?.sku ?? line.productId,
          },
          {
            key: 'packs',
            header: 'Packs',
            numeric: true,
            render: (line) => line.quantityReceived,
          },
          {
            key: 'units',
            header: 'Units',
            numeric: true,
            render: (line) => line.unitsReceived,
          },
          {
            key: 'discrepancy',
            header: 'Discrepancy',
            render: (line) =>
              line.discrepancy === 'NONE' ? (
                '—'
              ) : (
                <Badge tone="warn" title={line.discrepancyNote ?? undefined}>
                  {line.discrepancy.replace(/_/g, ' ').toLowerCase()}
                </Badge>
              ),
          },
        ]}
      />
      <Disclosure summary="Ledger movements this delivery produced">
        {movements.data && movements.data.length > 0 ? (
          <DataTable
            rows={movements.data}
            rowKey={(movement) => movement.id}
            columns={[
              {
                key: 'delta',
                header: 'Change',
                numeric: true,
                render: (movement) => `+${movement.quantityDelta}`,
              },
              {
                key: 'after',
                header: 'On hand after',
                numeric: true,
                render: (movement) => movement.quantityAfter,
              },
              {
                key: 'at',
                header: 'Recorded',
                render: (movement) => formatDate(movement.createdAt),
              },
            ]}
          />
        ) : (
          <EmptyState>
            Nothing moved: every line on this receipt arrived empty.
          </EmptyState>
        )}
      </Disclosure>
    </Card>
  );
}
