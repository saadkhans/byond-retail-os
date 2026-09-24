import { FormEvent, useState } from 'react';
import {
  api,
  ApiError,
  EffectiveStoreFlowPolicy,
  Paginated,
  Store,
  StoreEntryIssued,
  StoreEntryToken,
  StoreFlowAutonomyLevel,
  StoreFlowEntry,
  StoreFlowExitResult,
  StoreFlowJourney,
  StoreFlowPolicy,
  StoreFlowQueueItem,
  StoreFlowSyncResult,
  Unit,
} from '../api';
import {
  Badge,
  Card,
  Disclosure,
  EmptyState,
  Field,
  formatDate,
  FormRow,
  Notice,
  Page,
  Section,
  StatTiles,
  Tabs,
  useLoad,
} from '../components';
import { useTabState } from '@byond/ui';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

function formatMoney(minor: number | null, currencyCode: string | null): string {
  if (minor === null || currencyCode === null) {
    return '—';
  }
  return `${(minor / 100).toFixed(2)} ${currencyCode}`;
}

const AUTONOMY_LEVELS: {
  value: StoreFlowAutonomyLevel;
  label: string;
  blurb: string;
}[] = [
  {
    value: 'SHADOW',
    label: 'Shadow — observe only',
    blurb:
      'The store records what it sees and changes nothing. No basket, no ' +
      'order, no stock movement, no payment. This is the default.',
  },
  {
    value: 'PROPOSE',
    label: 'Propose — a person approves every pickup',
    blurb:
      'Each observed pickup becomes a pending event bound to the shopper ' +
      'basket. Nothing reaches the basket until someone approves it.',
  },
  {
    value: 'AUTO_APPLY',
    label: 'Auto-apply — confident, stocked pickups go straight in',
    blurb:
      'Confident pickups that pass inventory validation are applied without ' +
      'a person. Everything else still waits in the queue.',
  },
];

function autonomyTone(level: StoreFlowAutonomyLevel): 'neutral' | 'warn' {
  return level === 'SHADOW' ? 'neutral' : 'warn';
}

/**
 * Phase 26 — the store flow: how autonomous each store is, who is in it right
 * now, and the one queue where an uncertain pickup is decided.
 */
export function StoreFlowPage() {
  const [tab, setTab] = useTabState('policy');
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);

  const stores = useLoad<Paginated<Store> | null>(
    () => api<Paginated<Store>>('/stores?take=100').catch(() => null),
    [],
  );

  return (
    <Page
      title="Store flow"
      description={
        'Shopper entry, the bridge from an observed pickup to a basket line, ' +
        'and settlement on exit. A store changes nothing until you move it ' +
        'off Shadow.'
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'policy', label: 'Autonomy' },
          { id: 'entry', label: 'Entry' },
          { id: 'journeys', label: 'Shoppers in store' },
          { id: 'queue', label: 'Review queue' },
        ]}
      />
      {tab === 'policy' ? (
        <PolicyTab
          stores={stores.data?.items ?? []}
          reloadKey={reloadKey}
          onChanged={reload}
        />
      ) : null}
      {tab === 'entry' ? (
        <EntryTab
          stores={stores.data?.items ?? []}
          reloadKey={reloadKey}
          onChanged={reload}
        />
      ) : null}
      {tab === 'journeys' ? (
        <JourneysTab reloadKey={reloadKey} onChanged={reload} />
      ) : null}
      {tab === 'queue' ? (
        <QueueTab reloadKey={reloadKey} onChanged={reload} />
      ) : null}
    </Page>
  );
}

function PolicyTab({
  stores,
  reloadKey,
  onChanged,
}: {
  stores: Store[];
  reloadKey: number;
  onChanged: () => void;
}) {
  const { data, error, loading } = useLoad<StoreFlowPolicy[]>(
    () => api('/store-flow/policies'),
    [reloadKey],
  );
  const [locationId, setLocationId] = useState('');
  const [level, setLevel] = useState<StoreFlowAutonomyLevel>('SHADOW');
  const [threshold, setThreshold] = useState('0.7');
  const [validateInventory, setValidateInventory] = useState(true);
  const [settleOnExit, setSettleOnExit] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const [probeStore, setProbeStore] = useState('');
  const [probe, setProbe] = useState<EffectiveStoreFlowPolicy | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      await api('/store-flow/policies', {
        method: 'POST',
        body: {
          ...(locationId ? { locationId } : {}),
          autonomyLevel: level,
          autoApplyMinConfidence: Number(threshold),
          requireInventoryValidation: validateInventory,
          settleOnExit,
          ...(note ? { note } : {}),
        },
      });
      setMessage(
        `Published a new policy version. ${
          locationId ? 'This store' : 'Every store without its own policy'
        } is now on ${level}.`,
      );
      setNote('');
      onChanged();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const runProbe = async () => {
    if (!probeStore) return;
    try {
      setProbe(
        await api<EffectiveStoreFlowPolicy>(
          `/store-flow/policies/effective/${encodeURIComponent(probeStore)}`,
        ),
      );
    } catch (err) {
      setFailure(errorMessage(err));
    }
  };

  return (
    <>
      <Section
        title="Publish a policy change"
        description={
          'Changing autonomy always creates a new immutable version. Nothing ' +
          'is edited in place, so the record of who let a store act ' +
          'unattended is complete, and reverting means publishing an earlier ' +
          'setting forward again.'
        }
      >
        <Card>
          <form onSubmit={submit}>
            <FormRow>
              <Field label="Scope" hint="Leave empty for the tenant default.">
                <select
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                >
                  <option value="">All stores (tenant default)</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Autonomy level" required>
                <select
                  value={level}
                  onChange={(event) =>
                    setLevel(event.target.value as StoreFlowAutonomyLevel)
                  }
                >
                  {AUTONOMY_LEVELS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </FormRow>
            <Notice tone="info">
              {AUTONOMY_LEVELS.find((option) => option.value === level)?.blurb}
            </Notice>
            <FormRow>
              <Field
                label="Confidence floor"
                hint="An uncalibrated ranking score, not a probability."
              >
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                />
              </Field>
              <Field label="Validate against inventory">
                <input
                  type="checkbox"
                  checked={validateInventory}
                  onChange={(event) =>
                    setValidateInventory(event.target.checked)
                  }
                />
              </Field>
              <Field label="Settle on exit">
                <input
                  type="checkbox"
                  checked={settleOnExit}
                  onChange={(event) => setSettleOnExit(event.target.checked)}
                />
              </Field>
            </FormRow>
            <Field label="Why" hint="Recorded on the version and in the audit log.">
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
              />
            </Field>
            <button type="submit" disabled={busy}>
              {busy ? 'Publishing…' : 'Publish version'}
            </button>
          </form>
          {message ? <Notice tone="ok">{message}</Notice> : null}
          {failure ? <Notice tone="critical">{failure}</Notice> : null}
        </Card>
      </Section>

      <Section
        title="What applies where"
        description="A store policy beats the tenant default. With neither, a store observes only."
      >
        <Card>
          <FormRow>
            <Field label="Check a store">
              <select
                value={probeStore}
                onChange={(event) => setProbeStore(event.target.value)}
              >
                <option value="">Choose a store…</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </Field>
            <button type="button" onClick={runProbe} disabled={!probeStore}>
              Resolve
            </button>
          </FormRow>
          {probe ? (
            <StatTiles
              tiles={[
                { label: 'Autonomy', value: probe.autonomyLevel },
                {
                  label: 'Confidence floor',
                  value: probe.autoApplyMinConfidence.toFixed(2),
                },
                {
                  label: 'Inventory check',
                  value: probe.requireInventoryValidation ? 'On' : 'Off',
                },
                {
                  label: 'Settles on exit',
                  value: probe.settleOnExit ? 'Yes' : 'No',
                },
              ]}
            />
          ) : null}
        </Card>
      </Section>

      <Section title="Policies and their history">
        {error ? <Notice tone="critical">{error}</Notice> : null}
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && (data ?? []).length === 0 ? (
          <EmptyState>
            No policy has been published. Every store observes only.
          </EmptyState>
        ) : null}
        {(data ?? []).map((policy) => {
          const active = policy.versions.find(
            (version) => version.id === policy.activeVersionId,
          );
          return (
            <Card key={policy.id}>
              <h3>
                {policy.locationId
                  ? (stores.find((store) => store.id === policy.locationId)
                      ?.name ?? policy.locationId)
                  : 'Tenant default'}{' '}
                {active ? (
                  <Badge tone={autonomyTone(active.autonomyLevel)}>
                    {active.autonomyLevel}
                  </Badge>
                ) : (
                  <Badge tone="neutral">no active version</Badge>
                )}
              </h3>
              <Disclosure summary={`${policy.versions.length} version(s)`}>
                <ul>
                  {policy.versions.map((version) => (
                    <li key={version.id}>
                      v{version.versionNumber} · {version.autonomyLevel} · floor{' '}
                      {version.autoApplyMinConfidence.toFixed(2)} ·{' '}
                      {version.requireInventoryValidation
                        ? 'inventory checked'
                        : 'inventory unchecked'}{' '}
                      · {version.settleOnExit ? 'settles' : 'no settlement'} ·{' '}
                      {formatDate(version.createdAt)}
                      {version.note ? ` · ${version.note}` : ''}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </Card>
          );
        })}
      </Section>
    </>
  );
}

function EntryTab({
  stores,
  reloadKey,
  onChanged,
}: {
  stores: Store[];
  reloadKey: number;
  onChanged: () => void;
}) {
  const tokens = useLoad<StoreEntryToken[]>(
    () => api('/store-flow/entry-tokens'),
    [reloadKey],
  );
  const units = useLoad<Paginated<Unit> | null>(
    () => api<Paginated<Unit>>('/units?take=100').catch(() => null),
    [],
  );
  const [locationId, setLocationId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [issued, setIssued] = useState<StoreEntryIssued | null>(null);
  const [entered, setEntered] = useState<StoreFlowEntry | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const issue = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setEntered(null);
    try {
      setIssued(
        await api<StoreEntryIssued>('/store-flow/entry-tokens', {
          method: 'POST',
          body: { locationId, unitId },
        }),
      );
      onChanged();
    } catch (err) {
      setFailure(errorMessage(err));
    }
  };

  const redeem = async () => {
    if (!issued) return;
    setFailure(null);
    try {
      setEntered(
        await api<StoreFlowEntry>('/store-flow/entry', {
          method: 'POST',
          body: { token: issued.secret },
        }),
      );
      setIssued(null);
      onChanged();
    } catch (err) {
      setFailure(errorMessage(err));
    }
  };

  return (
    <>
      <Section
        title="Issue an entry credential"
        description={
          'Single-use and short-lived. The secret below is shown once and ' +
          'never stored — only its digest is kept, so it cannot be recovered ' +
          'from the database.'
        }
      >
        <Card>
          <form onSubmit={issue}>
            <FormRow>
              <Field label="Store" required>
                <select
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                  required
                >
                  <option value="">Choose a store…</option>
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Unit" required>
                <select
                  value={unitId}
                  onChange={(event) => setUnitId(event.target.value)}
                  required
                >
                  <option value="">Choose a unit…</option>
                  {(units.data?.items ?? [])
                    .filter((unit) => !locationId || unit.locationId === locationId)
                    .map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.name}
                      </option>
                    ))}
                </select>
              </Field>
            </FormRow>
            <button type="submit" disabled={!locationId || !unitId}>
              Issue credential
            </button>
          </form>
          {issued ? (
            <Notice tone="warn">
              <div>
                Credential valid until {formatDate(issued.expiresAt)}. Copy it
                now — it will not be shown again.
              </div>
              <code>{issued.secret}</code>
              <div>
                <button type="button" onClick={redeem}>
                  Redeem it here (opens a journey and a basket)
                </button>
              </div>
            </Notice>
          ) : null}
          {entered ? (
            <Notice tone="ok">
              Shopper {entered.shopperId} entered. Journey {entered.journeyId},
              basket {entered.checkoutSessionId}.
            </Notice>
          ) : null}
          {failure ? <Notice tone="critical">{failure}</Notice> : null}
        </Card>
      </Section>

      <Section title="Recently issued">
        {tokens.error ? <Notice tone="critical">{tokens.error}</Notice> : null}
        {(tokens.data ?? []).length === 0 ? (
          <EmptyState>No entry credentials have been issued.</EmptyState>
        ) : (
          <Card>
            <ul>
              {(tokens.data ?? []).map((token) => (
                <li key={token.id}>
                  <Badge
                    tone={token.status === 'ISSUED' ? 'warn' : 'neutral'}
                  >
                    {token.status}
                  </Badge>{' '}
                  expires {formatDate(token.expiresAt)}
                  {token.redeemedJourneyId
                    ? ` · journey ${token.redeemedJourneyId}`
                    : ''}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>
    </>
  );
}

function JourneysTab({
  reloadKey,
  onChanged,
}: {
  reloadKey: number;
  onChanged: () => void;
}) {
  const { data, error, loading } = useLoad<StoreFlowJourney[]>(
    () => api('/store-flow/journeys'),
    [reloadKey],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const act = async (journeyId: string, action: 'sync' | 'exit') => {
    setBusy(journeyId);
    setFailure(null);
    setResult(null);
    try {
      if (action === 'sync') {
        const sync = await api<StoreFlowSyncResult>(
          `/store-flow/journeys/${encodeURIComponent(journeyId)}/sync`,
          { method: 'POST' },
        );
        setResult(
          sync.skippedShadow
            ? 'This store observes only, so nothing was projected.'
            : `Projected ${sync.projected.length} observation(s).`,
        );
      } else {
        const exited = await api<StoreFlowExitResult>(
          `/store-flow/journeys/${encodeURIComponent(journeyId)}/exit`,
          { method: 'POST' },
        );
        setResult(
          exited.settlement.order
            ? `Order ${exited.settlement.order.orderNumber} · ${exited.settlement.status}`
            : `No order: ${exited.settlement.blockedBy ?? exited.settlement.status}`,
        );
      }
      onChanged();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Shoppers in store"
      description="Each journey with the basket its observations have built."
    >
      {error ? <Notice tone="critical">{error}</Notice> : null}
      {result ? <Notice tone="ok">{result}</Notice> : null}
      {failure ? <Notice tone="critical">{failure}</Notice> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && (data ?? []).length === 0 ? (
        <EmptyState>
          No shopper has entered through a store entry credential yet.
        </EmptyState>
      ) : null}
      {(data ?? []).map((journey) => {
        const total = journey.lines.reduce(
          (sum, line) => sum + (line.lineTotalMinor ?? 0),
          0,
        );
        const currency = journey.lines.find((line) => line.currencyCode)
          ?.currencyCode ?? null;
        return (
          <Card key={journey.id}>
            <h3>
              {journey.id} <Badge tone="neutral">{journey.status}</Badge>{' '}
              <Badge
                tone={
                  journey.settlementStatus === 'PAID' ? 'ok' : 'neutral'
                }
              >
                {journey.settlementStatus}
              </Badge>
            </h3>
            <p className="muted">
              Started {formatDate(journey.startedAt)}
              {journey.endedAt ? ` · ended ${formatDate(journey.endedAt)}` : ''}
            </p>
            {journey.lines.length === 0 ? (
              <p className="muted">Basket empty.</p>
            ) : (
              <ul>
                {journey.lines.map((line) => (
                  <li key={line.id}>
                    {line.quantity} × {line.productName} ({line.sku}) ·{' '}
                    {formatMoney(line.lineTotalMinor, line.currencyCode)}
                  </li>
                ))}
              </ul>
            )}
            <p>
              <strong>Total {formatMoney(total || null, currency)}</strong>
            </p>
            <button
              type="button"
              onClick={() => act(journey.id, 'sync')}
              disabled={busy === journey.id}
            >
              Catch up observations
            </button>{' '}
            <button
              type="button"
              onClick={() => act(journey.id, 'exit')}
              disabled={busy === journey.id}
            >
              Exit and settle
            </button>
          </Card>
        );
      })}
    </Section>
  );
}

function QueueTab({
  reloadKey,
  onChanged,
}: {
  reloadKey: number;
  onChanged: () => void;
}) {
  const { data, error, loading } = useLoad<StoreFlowQueueItem[]>(
    () => api('/store-flow/review-queue'),
    [reloadKey],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const decide = async (eventId: string, decision: 'APPROVE' | 'REJECT') => {
    setBusy(eventId);
    setFailure(null);
    try {
      await api(
        `/store-flow/review-queue/${encodeURIComponent(eventId)}/decision`,
        { method: 'POST', body: { decision, idempotencyKey: `ui-${eventId}` } },
      );
      onChanged();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Review queue"
      description={
        'One queue over both streams. A decision here is recorded against the ' +
        'observation and applied to the basket, so approving actually moves ' +
        'the shopper basket.'
      }
    >
      {error ? <Notice tone="critical">{error}</Notice> : null}
      {failure ? <Notice tone="critical">{failure}</Notice> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {!loading && (data ?? []).length === 0 ? (
        <EmptyState>Nothing is waiting for a decision.</EmptyState>
      ) : null}
      {(data ?? []).map((item) => (
        <Card key={item.eventId}>
          <h3>
            {item.candidateSku ?? 'Unidentified product'}{' '}
            <Badge tone="warn">{item.reason}</Badge>
            {item.storeFlow ? (
              <>
                {' '}
                <Badge tone="neutral">{item.storeFlow.reasonCode}</Badge>
              </>
            ) : null}
          </h3>
          <p className="muted">
            {item.eventType} at {formatDate(item.occurredAt)}
            {item.fusedTopScore !== null
              ? ` · score ${item.fusedTopScore.toFixed(2)}`
              : ''}
            {item.storeFlow?.visionEventStatus
              ? ` · basket event ${item.storeFlow.visionEventStatus}`
              : ' · nothing proposed to a basket'}
          </p>
          <button
            type="button"
            onClick={() => decide(item.eventId, 'APPROVE')}
            disabled={busy === item.eventId}
          >
            Approve into basket
          </button>{' '}
          <button
            type="button"
            onClick={() => decide(item.eventId, 'REJECT')}
            disabled={busy === item.eventId}
          >
            Reject
          </button>
        </Card>
      ))}
    </Section>
  );
}
