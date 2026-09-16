import { FormEvent, useState } from 'react';
import {
  api,
  ApiError,
  EslGateway,
  EslLabel,
  EslProcessSummary,
  EslUpdateJob,
  Paginated,
  Product,
  Store,
} from '../api';
import {
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

function percent(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export function EslPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);
  const [notice, setNotice] = useState<string | null>(null);

  const gateways = useLoad<Paginated<EslGateway>>(
    () => api('/esl/gateways?take=100'),
    [reloadKey],
  );
  const labels = useLoad<Paginated<EslLabel>>(
    () => api('/esl/labels?take=200'),
    [reloadKey],
  );
  const jobs = useLoad<Paginated<EslUpdateJob>>(
    () => api('/esl/update-jobs?take=50'),
    [reloadKey],
  );
  const vendors = useLoad<{ vendorCodes: string[] } | null>(
    () => api<{ vendorCodes: string[] }>('/esl/vendors').catch(() => null),
    [],
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
      title="Shelf labels"
      description="Electronic shelf labels follow the price that is in force. Activating a price book version queues a push for every label showing an affected product; failures retry on their own, and reconciliation repairs anything that drifted."
      error={gateways.error ?? labels.error ?? jobs.error}
      loading={gateways.loading}
    >
      {notice ? <Notice tone="ok">{notice}</Notice> : null}

      <CreateGatewayForm
        stores={stores.data?.items ?? []}
        vendorCodes={vendors.data?.vendorCodes ?? ['SIMULATED']}
        onCreated={reload}
      />

      <GatewaySection
        gateways={gateways.data?.items ?? []}
        onChanged={reload}
        onNotice={setNotice}
      />

      <LabelSection
        labels={labels.data?.items ?? []}
        products={products.data?.items ?? []}
        onChanged={reload}
        onNotice={setNotice}
      />

      <JobSection
        jobs={jobs.data?.items ?? []}
        onChanged={reload}
        onNotice={setNotice}
      />
    </Page>
  );
}

function CreateGatewayForm({
  stores,
  vendorCodes,
  onCreated,
}: {
  stores: Store[];
  vendorCodes: string[];
  onCreated: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [vendorCode, setVendorCode] = useState(vendorCodes[0] ?? 'SIMULATED');
  const [locationId, setLocationId] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/esl/gateways', {
        method: 'POST',
        body: {
          code,
          name,
          vendorCode,
          locationId,
          ...(credentialRef ? { credentialRef } : {}),
        },
      });
      setCode('');
      setName('');
      setCredentialRef('');
      onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Register a gateway">
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Code" required>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                placeholder="STORE-01"
              />
            </Field>
            <Field label="Name" required>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                placeholder="Store 1 gateway"
              />
            </Field>
            <Field label="Vendor" required>
              <select
                value={vendorCode}
                onChange={(event) => setVendorCode(event.target.value)}
              >
                {vendorCodes.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Store" required>
              <select
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                required
              >
                <option value="">Select a store</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Credential reference"
              hint="The NAME of a credential in configuration, never the credential itself."
            >
              <input
                value={credentialRef}
                onChange={(event) => setCredentialRef(event.target.value)}
                placeholder="ACME_STORE_01"
              />
            </Field>
          </FormRow>
          {formError ? <Notice tone="critical">{formError}</Notice> : null}
          <button type="submit" disabled={busy || !locationId}>
            {busy ? 'Registering…' : 'Register gateway'}
          </button>
        </form>
      </Card>
    </Section>
  );
}

function GatewaySection({
  gateways,
  onChanged,
  onNotice,
}: {
  gateways: EslGateway[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(
    gatewayId: string,
    run: () => Promise<string>,
  ): Promise<void> {
    setBusyId(gatewayId);
    setError(null);
    try {
      onNotice(await run());
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section title="Gateways">
      {error ? <Notice tone="critical">{error}</Notice> : null}
      <DataTable
        rows={gateways}
        rowKey={(gateway) => gateway.id}
        empty="No gateways yet. Register one above, then discover its labels."
        columns={[
          {
            key: 'code',
            header: 'Code',
            render: (gateway) => gateway.code,
          },
          {
            key: 'vendor',
            header: 'Vendor',
            render: (gateway) => gateway.vendorCode,
          },
          {
            key: 'store',
            header: 'Store',
            render: (gateway) => gateway.location?.name ?? '—',
          },
          {
            key: 'status',
            header: 'Status',
            render: (gateway) => <StatusBadge status={gateway.status} />,
          },
          {
            key: 'labels',
            header: 'Labels',
            numeric: true,
            render: (gateway) => gateway._count?.labels ?? 0,
          },
          {
            key: 'credential',
            header: 'Credential',
            render: (gateway) =>
              gateway.credentialRef ? 'configured' : 'none',
          },
          {
            key: 'seen',
            header: 'Last seen',
            render: (gateway) => formatDate(gateway.lastSeenAt),
          },
          {
            key: 'actions',
            header: '',
            render: (gateway) => (
              <div className="row-actions">
                <button
                  type="button"
                  disabled={busyId === gateway.id}
                  onClick={() =>
                    act(gateway.id, async () => {
                      const result = await api<{ registered: number }>(
                        `/esl/gateways/${gateway.id}/discover`,
                        { method: 'POST' },
                      );
                      return `Discovered ${result.registered} label(s) on ${gateway.code}.`;
                    })
                  }
                >
                  Discover labels
                </button>
                <button
                  type="button"
                  disabled={busyId === gateway.id}
                  onClick={() =>
                    act(gateway.id, async () => {
                      const next =
                        gateway.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
                      await api(`/esl/gateways/${gateway.id}`, {
                        method: 'PATCH',
                        body: { status: next },
                      });
                      return `${gateway.code} is now ${next}.`;
                    })
                  }
                >
                  {gateway.status === 'DISABLED' ? 'Enable' : 'Disable'}
                </button>
              </div>
            ),
          },
        ]}
      />
    </Section>
  );
}

function LabelSection({
  labels,
  products,
  onChanged,
  onNotice,
}: {
  labels: EslLabel[];
  products: Product[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(labelId: string, run: () => Promise<string>) {
    setBusyId(labelId);
    setError(null);
    try {
      onNotice(await run());
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section title="Labels">
      {error ? <Notice tone="critical">{error}</Notice> : null}
      {labels.length === 0 ? (
        <EmptyState>
          No labels yet. Discover them from a gateway, then bind each one to the
          product it sits in front of — binding is what makes a label follow
          price changes.
        </EmptyState>
      ) : (
        <DataTable
          rows={labels}
          rowKey={(label) => label.id}
          columns={[
            {
              key: 'vendorLabelId',
              header: 'Label',
              render: (label) => label.vendorLabelId,
            },
            {
              key: 'gateway',
              header: 'Gateway',
              render: (label) => label.gateway?.code ?? '—',
            },
            {
              key: 'product',
              header: 'Showing',
              render: (label) =>
                label.product ? `${label.product.sku} — ${label.product.name}` : '—',
            },
            {
              key: 'status',
              header: 'Status',
              render: (label) => <StatusBadge status={label.status} />,
            },
            {
              key: 'battery',
              header: 'Battery',
              numeric: true,
              render: (label) => percent(label.batteryPercent),
            },
            {
              key: 'signal',
              header: 'Signal',
              numeric: true,
              render: (label) => percent(label.signalPercent),
            },
            {
              key: 'rendered',
              header: 'Last rendered',
              render: (label) => formatDate(label.lastRenderedAt),
            },
            {
              key: 'actions',
              header: '',
              render: (label) => (
                <div className="row-actions">
                  <select
                    value={label.productId ?? ''}
                    disabled={busyId === label.id || label.status === 'RETIRED'}
                    onChange={(event) =>
                      act(label.id, async () => {
                        await api(`/esl/labels/${label.id}`, {
                          method: 'PATCH',
                          body: { productId: event.target.value || null },
                        });
                        return `${label.vendorLabelId} rebound.`;
                      })
                    }
                  >
                    <option value="">Unbound</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.sku}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busyId === label.id || label.status !== 'BOUND'}
                    onClick={() =>
                      act(label.id, async () => {
                        await api(`/esl/labels/${label.id}/render`, {
                          method: 'POST',
                        });
                        return `Re-render queued for ${label.vendorLabelId}.`;
                      })
                    }
                  >
                    Re-render
                  </button>
                </div>
              ),
            },
          ]}
        />
      )}
    </Section>
  );
}

function JobSection({
  jobs,
  onChanged,
  onNotice,
}: {
  jobs: EslUpdateJob[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(run: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      onNotice(await run());
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Update queue"
      description="A pass recovers work stranded by a crashed worker, then pushes what it can claim. Nothing here runs on a timer — this is the operator's handle on it."
    >
      {error ? <Notice tone="critical">{error}</Notice> : null}
      <Card>
        <div className="row-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const summary = await api<EslProcessSummary>(
                  '/esl/update-jobs/process',
                  { method: 'POST', body: {} },
                );
                return `Claimed ${summary.claimed}: ${summary.succeeded} rendered, ${summary.requeued} retrying, ${summary.failed} failed.`;
              })
            }
          >
            Run a pass
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const result = await api<{ requeued: number; failed: number }>(
                  '/esl/update-jobs/reclaim-expired',
                  { method: 'POST' },
                );
                return `Requeued ${result.requeued}, gave up on ${result.failed}.`;
              })
            }
          >
            Reclaim expired leases
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const result = await api<{
                  inspected: number;
                  enqueued: number;
                }>('/esl/reconcile', { method: 'POST' });
                return `Inspected ${result.inspected} label(s), queued ${result.enqueued} correction(s).`;
              })
            }
          >
            Reconcile against prices
          </button>
        </div>
      </Card>
      <Disclosure summary={`Recent jobs (${jobs.length})`} defaultOpen>
        <DataTable
          rows={jobs}
          rowKey={(job) => job.id}
          empty="No update jobs yet."
          columns={[
            {
              key: 'label',
              header: 'Label',
              render: (job) => job.label?.vendorLabelId ?? job.labelId,
            },
            {
              key: 'trigger',
              header: 'Trigger',
              render: (job) => job.trigger.replace(/_/g, ' ').toLowerCase(),
            },
            {
              key: 'status',
              header: 'Status',
              render: (job) => <StatusBadge status={job.status} />,
            },
            {
              key: 'attempts',
              header: 'Attempts',
              numeric: true,
              render: (job) => job.attempts,
            },
            {
              key: 'error',
              header: 'Last error',
              render: (job) =>
                job.lastErrorCode
                  ? `${job.lastErrorCode}${
                      job.lastErrorMessage ? ` — ${job.lastErrorMessage}` : ''
                    }`
                  : '—',
            },
            {
              key: 'requested',
              header: 'Requested',
              render: (job) => formatDate(job.requestedAt),
            },
          ]}
        />
      </Disclosure>
    </Section>
  );
}
