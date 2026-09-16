import { useState } from 'react';
import {
  api,
  BalanceReport,
  CountReconciliationReport,
  CvAccuracyReport,
  MovementReport,
  Paginated,
  SalesExplainReport,
  SalesReport,
  ShrinkReport,
  Store,
} from '../api';
import {
  Badge,
  DataTable,
  EmptyState,
  Field,
  FormRow,
  Notice,
  Page,
  Section,
  StatTiles,
  Tabs,
  useLoad,
} from '../components';
import {
  asOfLabel,
  damagedReturnsNote,
  driftLabel,
  driftTone,
  money,
  percent,
  reconciliationLabel,
  reconciliationTone,
  signed,
  windowLabel,
} from '../reporting-utils';

/**
 * Phase 30 — the reporting surface.
 *
 * This page reads. It has no form that submits, no button that writes and no
 * field that stores operator prose — the only inputs are a date window and a
 * store/run picker, all of which go into a query string and nowhere else.
 * `reporting-page-safety.spec.ts` pins that, along with the two distinctions
 * this page exists to keep visible:
 *
 *   - a ledger balance is the sum of its movements, and the stock projection
 *     is shown beside it as a CROSS-CHECK, never as the answer;
 *   - projection drift is a platform defect, not a shelf variance, and a
 *     damaged return is not shrink.
 */
function todayMinusDays(days: number): string {
  const target = new Date();
  target.setDate(target.getDate() - days);
  return target.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function windowQuery(from: string, to: string, locationId: string): string {
  const params = new URLSearchParams();
  if (from) {
    params.set('from', `${from}T00:00:00.000Z`);
  }
  if (to) {
    params.set('to', `${to}T23:59:59.999Z`);
  }
  if (locationId) {
    params.set('locationId', locationId);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function Provenance({
  provenance,
  window,
}: {
  provenance: {
    generatedAt: string;
    derivation: string;
    stale: boolean;
    sourceOfTruth: string[];
  };
  window?: { from: string; to: string };
}) {
  return (
    <p className="muted">
      {window ? `${windowLabel(window)} · ` : null}
      {asOfLabel(provenance)}
    </p>
  );
}

export function ReportsPage() {
  const [from, setFrom] = useState(todayMinusDays(30));
  const [to, setTo] = useState(today());
  const [locationId, setLocationId] = useState('');
  const [evaluationRunId, setEvaluationRunId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [tab, setTab] = useState('sales');

  const stores = useLoad<Paginated<Store> | null>(
    () => api<Paginated<Store>>('/stores?take=100').catch(() => null),
    [],
  );
  const query = windowQuery(from, to, locationId);

  const sales = useLoad<SalesReport | null>(
    () => api<SalesReport>(`/reports/sales${query}`).catch(() => null),
    [query],
  );
  const movements = useLoad<MovementReport | null>(
    () =>
      api<MovementReport>(`/reports/inventory/movements${query}`).catch(
        () => null,
      ),
    [query],
  );
  const balances = useLoad<BalanceReport | null>(
    () =>
      api<BalanceReport>(
        `/reports/inventory/balances${locationId ? `?locationId=${locationId}` : ''}`,
      ).catch(() => null),
    [locationId],
  );
  const counts = useLoad<CountReconciliationReport | null>(
    () =>
      api<CountReconciliationReport>(
        `/reports/inventory/count-reconciliation${query}`,
      ).catch(() => null),
    [query],
  );
  const shrink = useLoad<ShrinkReport | null>(
    () => api<ShrinkReport>(`/reports/shrink${query}`).catch(() => null),
    [query],
  );

  return (
    <Page
      title="Reports"
      description="Sales, inventory, shrink and CV accuracy — every figure derived on read from the append-only ledger and the evaluation tables. Nothing here is cached, and nothing here writes."
    >
      <Section title="Window">
        <FormRow>
          <Field label="From">
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
          <Field label="Store">
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            >
              <option value="">All stores</option>
              {(stores.data?.items ?? []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </Field>
        </FormRow>
      </Section>

      <Tabs
        tabs={[
          { id: 'sales', label: 'Sales' },
          { id: 'inventory', label: 'Inventory' },
          { id: 'shrink', label: 'Shrink' },
          { id: 'cv-accuracy', label: 'CV accuracy' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'sales' ? (
        <SalesSection
          report={sales.data ?? null}
          loading={sales.loading}
          orderId={orderId}
          onOrderId={setOrderId}
        />
      ) : null}
      {tab === 'inventory' ? (
        <InventorySection
          movements={movements.data ?? null}
          balances={balances.data ?? null}
          counts={counts.data ?? null}
          loading={movements.loading || balances.loading}
        />
      ) : null}
      {tab === 'shrink' ? (
        <ShrinkSection report={shrink.data ?? null} loading={shrink.loading} />
      ) : null}
      {tab === 'cv-accuracy' ? (
        <CvAccuracySection
          evaluationRunId={evaluationRunId}
          onEvaluationRunId={setEvaluationRunId}
        />
      ) : null}
    </Page>
  );
}

function SalesSection({
  report,
  loading,
  orderId,
  onOrderId,
}: {
  report: SalesReport | null;
  loading: boolean;
  orderId: string;
  onOrderId: (value: string) => void;
}) {
  if (loading) {
    return <p className="muted">Loading…</p>;
  }
  if (!report) {
    return (
      <EmptyState>
        No sales report. This needs the reporting module, report:read and
        order:read.
      </EmptyState>
    );
  }
  return (
    <>
      <Section title="Sales">
        <Provenance provenance={report.provenance} window={report.window} />
        <p className="muted">{report.scope}</p>
        {report.totals.byCurrency.length === 0 ? (
          <EmptyState>No priced sales in this window.</EmptyState>
        ) : null}
        {report.totals.byCurrency.map((totals) => (
          <div key={totals.currencyCode}>
            <StatTiles
              tiles={[
                {
                  label: 'Gross (price versions)',
                  value: money(totals.grossSalesMinor, totals.currencyCode),
                },
                {
                  label: 'Promotion discount',
                  value: money(
                    totals.promotionDiscountMinor,
                    totals.currencyCode,
                  ),
                },
                {
                  label: 'Net charged',
                  value: money(totals.netSalesMinor, totals.currencyCode),
                },
                { label: 'Units', value: String(totals.unitsSold) },
              ]}
            />
            <p className="muted">
              Gross − discount = net.{' '}
              <Badge tone={reconciliationTone(totals.reconciled)}>
                {reconciliationLabel(totals.reconciled)}
              </Badge>
            </p>
          </div>
        ))}
        <p className="muted">
          Cross-checked against an independent ungrouped SUM over the same order
          lines:{' '}
          <Badge tone={reconciliationTone(report.crossCheck.reconciled)}>
            {reconciliationLabel(report.crossCheck.reconciled)}
          </Badge>
        </p>
        {report.totals.unpricedLines > 0 ? (
          <Notice>
            {report.totals.unpricedLines} line(s) carry no price at all (sold
            before pricing shipped). They are counted separately, never as
            zero-value sales.
          </Notice>
        ) : null}
        {report.totals.inconsistentPricePoints > 0 ? (
          <Notice>
            {report.totals.inconsistentPricePoints} price point(s) have columns
            that contradict each other. Surfaced, not corrected — reporting
            never edits domain data.
          </Notice>
        ) : null}
      </Section>

      <Section title="By product">
        <DataTable
          rows={report.totals.byProduct}
          rowKey={(row) => row.key}
          columns={[
            { key: 'sku', header: 'SKU', render: (row) => row.sku },
            { key: 'product', header: 'Product', render: (row) => row.productName },
            { key: 'units', header: 'Units', render: (row) => String(row.unitsSold) },
            { key: 'gross', header: 'Gross', render: (row) => money(row.grossSalesMinor, row.currencyCode),
            },
            { key: 'discount', header: 'Discount', render: (row) =>
                money(row.promotionDiscountMinor, row.currencyCode),
            },
            { key: 'net', header: 'Net', render: (row) => money(row.netSalesMinor, row.currencyCode),
            },
          ]}
        />
      </Section>

      <Section
        title="By promotion version"
        description="Which discount gave away what. A promotion never rewrote a price version — it is a separate, subtractive layer on top of it."
      >
        <DataTable
          rows={report.totals.byPromotionVersion}
          rowKey={(row) => row.key}
          columns={[
            { key: 'promotion-version', header: 'Promotion version', render: (row) => row.promotionVersionId ?? 'No promotion',
            },
            { key: 'units', header: 'Units', render: (row) => String(row.unitsSold) },
            { key: 'discount-given', header: 'Discount given', render: (row) =>
                money(row.promotionDiscountMinor, row.currencyCode),
            },
            { key: 'net', header: 'Net', render: (row) => money(row.netSalesMinor, row.currencyCode),
            },
          ]}
        />
      </Section>

      <Section
        title="By price book version"
        description="Which version of which price book set the base price behind each sale."
      >
        <DataTable
          rows={report.totals.byPriceBookVersion}
          rowKey={(row) => row.key}
          columns={[
            { key: 'price-book-version', header: 'Price book version', render: (row) => row.priceBookVersionId ?? 'Unpriced',
            },
            { key: 'units', header: 'Units', render: (row) => String(row.unitsSold) },
            { key: 'gross', header: 'Gross', render: (row) => money(row.grossSalesMinor, row.currencyCode),
            },
          ]}
        />
      </Section>

      <ExplainOrder orderId={orderId} onOrderId={onOrderId} />
    </>
  );
}

function ExplainOrder({
  orderId,
  onOrderId,
}: {
  orderId: string;
  onOrderId: (value: string) => void;
}) {
  const explain = useLoad<SalesExplainReport | null>(
    () =>
      orderId
        ? api<SalesExplainReport>(
            `/reports/sales/orders/${encodeURIComponent(orderId)}`,
          ).catch(() => null)
        : Promise.resolve(null),
    [orderId],
  );
  return (
    <Section
      title="Explain one sale"
      description="Paste an order id to see the price book version that set each base price and the promotion version that discounted it — and whether the arithmetic in between holds."
    >
      <FormRow>
        <Field label="Order id">
          <input
            type="text"
            value={orderId}
            onChange={(event) => onOrderId(event.target.value.trim())}
          />
        </Field>
      </FormRow>
      {!orderId ? <EmptyState>No order selected.</EmptyState> : null}
      {orderId && !explain.data && !explain.loading ? (
        <EmptyState>No such order in this tenant.</EmptyState>
      ) : null}
      {explain.data ? (
        <>
          <p className="muted">
            {explain.data.orderNumber} ·{' '}
            {explain.data.reconciled === null ? (
              'the order carries no snapshotted total to check against'
            ) : (
              <Badge tone={reconciliationTone(explain.data.reconciled)}>
                {reconciliationLabel(explain.data.reconciled)} against the
                order’s own total
              </Badge>
            )}
          </p>
          <DataTable
            rows={explain.data.lines}
            rowKey={(row) => row.orderLineId}
            columns={[
              { key: 'sku', header: 'SKU', render: (row) => row.sku },
              { key: 'qty', header: 'Qty', render: (row) => String(row.quantity) },
              { key: 'base-price', header: 'Base price', render: (row) => money(row.basePriceMinor, row.currencyCode),
              },
              { key: 'price-version', header: 'Price version', render: (row) =>
                  row.priceBookVersion
                    ? `${row.priceBookVersion.priceBookCode} v${row.priceBookVersion.versionNumber}`
                    : '—',
              },
              { key: 'discount', header: 'Discount', render: (row) =>
                  money(row.promotionDiscountMinor, row.currencyCode),
              },
              { key: 'promotion-version', header: 'Promotion version', render: (row) =>
                  row.promotionVersion
                    ? `${row.promotionVersion.promotionCode} v${row.promotionVersion.versionNumber}`
                    : 'None',
              },
              { key: 'unit-paid', header: 'Unit paid', render: (row) => money(row.unitPriceMinor, row.currencyCode),
              },
              { key: 'line-total', header: 'Line total', render: (row) => money(row.lineTotalMinor, row.currencyCode),
              },
              { key: 'checks', header: 'Checks', render: (row) => (
                  <Badge
                    tone={reconciliationTone(
                      row.checks.unitPriceMatchesBaseMinusDiscount &&
                        row.checks.lineTotalMatchesUnitTimesQuantity,
                    )}
                  >
                    {row.checks.unitPriceMatchesBaseMinusDiscount &&
                    row.checks.lineTotalMatchesUnitTimesQuantity
                      ? 'base − discount = unit, unit × qty = total'
                      : 'arithmetic does not hold'}
                  </Badge>
                ),
              },
            ]}
          />
          <Provenance provenance={explain.data.provenance} />
        </>
      ) : null}
    </Section>
  );
}

function InventorySection({
  movements,
  balances,
  counts,
  loading,
}: {
  movements: MovementReport | null;
  balances: BalanceReport | null;
  counts: CountReconciliationReport | null;
  loading: boolean;
}) {
  if (loading) {
    return <p className="muted">Loading…</p>;
  }
  return (
    <>
      <Section
        title="Movements"
        description="The signed net change the append-only ledger recorded, by movement type. These replay to exactly the change in on-hand stock across the window."
      >
        {movements ? (
          <>
            <Provenance
              provenance={movements.provenance}
              window={movements.window}
            />
            <DataTable
              rows={movements.movements.byType}
              rowKey={(row) => row.movementType}
              columns={[
                { key: 'type', header: 'Type', render: (row) => row.movementType },
                { key: 'in', header: 'In', render: (row) => String(row.unitsIn) },
                { key: 'out', header: 'Out', render: (row) => String(row.unitsOut) },
                { key: 'net', header: 'Net', render: (row) => signed(row.quantityDelta) },
                { key: 'movements', header: 'Movements', render: (row) => String(row.movements) },
              ]}
            />
            <p className="muted">
              Net across every type: {signed(movements.movements.totals.quantityDelta)} units
              over {movements.movements.totals.movements} movement(s).
            </p>
          </>
        ) : (
          <EmptyState>No movement report. This needs inventory:read.</EmptyState>
        )}
      </Section>

      <Section
        title="Balances"
        description="Each balance is the SUM of its ledger movements. The stock projection is shown beside it only as a cross-check — it is never the answer."
      >
        {balances ? (
          <>
            <Provenance provenance={balances.provenance} />
            <p className="muted">{balances.balanceSource}</p>
            <p className="muted">
              <Badge tone={driftTone(balances.summary.projectionHealthy)}>
                {driftLabel(balances.summary.projectionHealthy)}
              </Badge>
            </p>
            <DataTable
              rows={balances.rows}
              rowKey={(row) => `${row.locationId}:${row.productId}`}
              columns={[
                { key: 'store', header: 'Store', render: (row) => row.locationId },
                { key: 'product', header: 'Product', render: (row) => row.productId },
                { key: 'ledger-balance', header: 'Ledger balance', render: (row) => String(row.ledgerQuantity),
                },
                { key: 'movements', header: 'Movements', render: (row) => String(row.movements) },
                { key: 'projection-cross-check', header: 'Projection (cross-check)', render: (row) =>
                    row.projectedQuantity === null
                      ? '—'
                      : String(row.projectedQuantity),
                },
                { key: 'drift', header: 'Drift', render: (row) =>
                    row.projectionDriftQuantity === null
                      ? '—'
                      : signed(row.projectionDriftQuantity),
                },
              ]}
            />
          </>
        ) : (
          <EmptyState>No balance report. This needs inventory:read.</EmptyState>
        )}
      </Section>

      <Section
        title="Cycle counts"
        description="Two different numbers, kept apart on purpose."
      >
        {counts ? (
          <>
            <Provenance provenance={counts.provenance} window={counts.window} />
            <StatTiles
              tiles={[
                {
                  label: 'Stock variance (counted − projected)',
                  value: signed(counts.variance.totalQuantity),
                },
                {
                  label: 'Lines with variance',
                  value: String(counts.variance.lines),
                },
                {
                  label: 'Projection drift (projected − ledger)',
                  value: signed(counts.projectionDefect.totalDriftQuantity),
                },
                {
                  label: 'Lines with drift',
                  value: String(counts.projectionDefect.lines),
                },
              ]}
            />
            <p className="muted">{counts.variance.meaning}</p>
            <p className="muted">
              <Badge tone={driftTone(counts.projectionDefect.healthy)}>
                {driftLabel(counts.projectionDefect.healthy)}
              </Badge>{' '}
              {counts.projectionDefect.meaning}
            </p>
            <Notice>
              These two totals are never added together. A variance is stock an
              operator found missing or spare; drift is the platform
              contradicting itself, and it has NOT been corrected here.
            </Notice>
          </>
        ) : (
          <EmptyState>
            No cycle-count report. This needs cycle-count:read.
          </EmptyState>
        )}
      </Section>
    </>
  );
}

function ShrinkSection({
  report,
  loading,
}: {
  report: ShrinkReport | null;
  loading: boolean;
}) {
  if (loading) {
    return <p className="muted">Loading…</p>;
  }
  if (!report) {
    return <EmptyState>No shrink report. This needs shrink:read.</EmptyState>;
  }
  return (
    <>
      <Section title="Shrink">
        <Provenance provenance={report.provenance} window={report.window} />
        <StatTiles
          tiles={[
            { label: 'Units written off', value: String(report.shrink.units) },
            { label: 'Write-offs', value: String(report.shrink.events) },
            {
              label: 'SHRINK movements in the ledger',
              value: String(report.ledgerCheck.shrinkMovementUnits),
            },
          ]}
        />
        <p className="muted">
          Every write-off must have its SHRINK ledger movement.{' '}
          <Badge tone={reconciliationTone(report.ledgerCheck.reconciled)}>
            {reconciliationLabel(report.ledgerCheck.reconciled)}
          </Badge>
        </p>
        <DataTable
          rows={report.shrink.bySource}
          rowKey={(row) => row.source}
          columns={[
            { key: 'source', header: 'Source', render: (row) => row.source },
            { key: 'units', header: 'Units', render: (row) => String(row.units) },
            { key: 'write-offs', header: 'Write-offs', render: (row) => String(row.events) },
          ]}
        />
      </Section>

      <Section
        title="Damaged returns — not shrink"
        description="Returned goods that never went back on the shelf. A damaged return deliberately writes no ledger movement, so it is counted here and never added to the shrink total."
      >
        <Notice>{damagedReturnsNote(report.damagedReturns.units)}</Notice>
        <DataTable
          rows={report.damagedReturns.byProduct}
          rowKey={(row) => row.productId}
          columns={[
            { key: 'product', header: 'Product', render: (row) => row.productId },
            { key: 'units', header: 'Units', render: (row) => String(row.units) },
            { key: 'return-lines', header: 'Return lines', render: (row) => String(row.lines) },
          ]}
        />
      </Section>
    </>
  );
}

function CvAccuracySection({
  evaluationRunId,
  onEvaluationRunId,
}: {
  evaluationRunId: string;
  onEvaluationRunId: (value: string) => void;
}) {
  const report = useLoad<CvAccuracyReport | null>(
    () =>
      evaluationRunId
        ? api<CvAccuracyReport>(
            `/reports/cv-accuracy?evaluationRunId=${encodeURIComponent(
              evaluationRunId,
            )}`,
          ).catch(() => null)
        : Promise.resolve(null),
    [evaluationRunId],
  );
  return (
    <Section
      title="CV accuracy"
      description="Accuracy and confusion over the latest operator verdict per observation. Counts only — this report never shows raw observation evidence, and it applies the same video boundary as the pilot review surface."
    >
      <FormRow>
        <Field label="Evaluation run id">
          <input
            type="text"
            value={evaluationRunId}
            onChange={(event) => onEvaluationRunId(event.target.value.trim())}
          />
        </Field>
      </FormRow>
      {!evaluationRunId ? (
        <EmptyState>Name an evaluation run to score.</EmptyState>
      ) : null}
      {evaluationRunId && !report.data && !report.loading ? (
        <EmptyState>No such evaluation run in this tenant.</EmptyState>
      ) : null}
      {report.data ? (
        <>
          <Provenance provenance={report.data.provenance} />
          <StatTiles
            tiles={[
              {
                label: 'Action accuracy',
                value: percent(report.data.accuracy.action),
              },
              { label: 'SKU accuracy', value: percent(report.data.accuracy.sku) },
              {
                label: 'Combined accuracy',
                value: percent(report.data.accuracy.combined),
              },
              {
                label: 'Decided observations',
                value: String(report.data.totals.decided),
              },
              {
                label: 'Missed events',
                value: String(report.data.totals.missedEvents),
              },
            ]}
          />
          <Notice>
            Excluded from these figures: {report.data.scope.excluded}.
          </Notice>
          <DataTable
            rows={report.data.confusion.action}
            rowKey={(row) => `${row.predicted}:${row.expected}`}
            columns={[
              { key: 'predicted-action', header: 'Predicted action', render: (row) => row.predicted },
              { key: 'operator-said', header: 'Operator said', render: (row) => row.expected },
              { key: 'count', header: 'Count', render: (row) => String(row.count) },
            ]}
          />
          <DataTable
            rows={report.data.confusion.sku}
            rowKey={(row) => `${row.predicted}:${row.expected}`}
            columns={[
              { key: 'predicted-sku', header: 'Predicted SKU', render: (row) => row.predicted },
              { key: 'operator-said', header: 'Operator said', render: (row) => row.expected },
              { key: 'count', header: 'Count', render: (row) => String(row.count) },
            ]}
          />
          <ul className="muted">
            {Object.entries(report.data.definitions).map(([key, meaning]) => (
              <li key={key}>
                <strong>{key}</strong>: {meaning}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}
