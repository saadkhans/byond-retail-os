import { FormEvent, useState } from 'react';
import {
  api,
  ApiError,
  LoyaltyAccountWithBalance,
  LoyaltyPointMovement,
  Paginated,
  PointMovementResult,
  PriceQuote,
  Product,
  Promotion,
  PromotionRule,
  PromotionVersion,
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
import {
  activeVersion,
  balanceFromLedger,
  describeRule,
  describeRuleScope,
  explainQuote,
  formatPoints,
  latestDraft,
  movementIdempotencyKey,
  quoteIsExplainable,
} from '../loyalty-utils';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Unexpected error';
}

export function LoyaltyPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);
  const [notice, setNotice] = useState<string | null>(null);

  const accounts = useLoad<Paginated<LoyaltyAccountWithBalance>>(
    () => api('/loyalty/accounts?take=100'),
    [reloadKey],
  );
  const promotions = useLoad<Paginated<Promotion>>(
    () => api('/loyalty/promotions?take=100'),
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
      title="Loyalty & promotions"
      description="Promotions do not rewrite prices. A price book version decides what a product costs; a promotion subtracts from that, and the basket line records both — so any price a shopper paid names one price version and at most one promotion version. Points are a balance derived from an append-only ledger, never a counter anyone edits."
      error={accounts.error ?? promotions.error}
      loading={accounts.loading}
    >
      {notice ? <Notice tone="ok">{notice}</Notice> : null}

      <QuoteSection
        products={products.data?.items ?? []}
        stores={stores.data?.items ?? []}
        accounts={accounts.data?.items ?? []}
      />

      <EnrolAccountForm onCreated={reload} />

      <AccountSection
        accounts={accounts.data?.items ?? []}
        onChanged={reload}
        onNotice={setNotice}
      />

      <CreatePromotionForm stores={stores.data?.items ?? []} onCreated={reload} />

      <PromotionSection
        promotions={promotions.data?.items ?? []}
        products={products.data?.items ?? []}
        onChanged={reload}
        onNotice={setNotice}
      />
    </Page>
  );
}

/* ------------------------------------------------------------------ */
/* Quote - the explainability surface                                  */
/* ------------------------------------------------------------------ */

function QuoteSection({
  products,
  stores,
  accounts,
}: {
  products: Product[];
  stores: Store[];
  accounts: LoyaltyAccountWithBalance[];
}) {
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [loyaltyAccountId, setLoyaltyAccountId] = useState('');
  const [at, setAt] = useState('');
  const [result, setResult] = useState<PriceQuote | null | undefined>(undefined);
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
      if (loyaltyAccountId) {
        query.set('loyaltyAccountId', loyaltyAccountId);
      }
      if (at) {
        query.set('at', new Date(at).toISOString());
      }
      setResult(await api<PriceQuote | null>(`/loyalty/quote?${query}`));
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  return (
    <Section
      title="What does this cost this shopper?"
      description="Answers at an instant, and shows the working. A past date answers historically, because superseded price versions and superseded promotion versions both keep their effective windows."
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
            <Field
              label="Member"
              hint="Member-only promotions need an ACTIVE account"
            >
              <select
                value={loyaltyAccountId}
                onChange={(event) => setLoyaltyAccountId(event.target.value)}
              >
                <option value="">No member</option>
                {accounts.map((entry) => (
                  <option key={entry.account.id} value={entry.account.id}>
                    {entry.account.memberCode}
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
          <button type="submit">Quote</button>
        </form>
        {result === null ? (
          <Notice tone="warn">
            No price book covers this product here. A basket line would be
            recorded unpriced — not free — and a promotion cannot conjure a
            price for it.
          </Notice>
        ) : null}
        {result ? (
          <>
            <Notice tone="ok">{explainQuote(result)}</Notice>
            {quoteIsExplainable(result) ? null : (
              <Notice tone="critical">
                This quote does not add up: what is paid is not the base price
                minus the discount. Do not act on it.
              </Notice>
            )}
          </>
        ) : null}
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Loyalty accounts and the points ledger                              */
/* ------------------------------------------------------------------ */

function EnrolAccountForm({ onCreated }: { onCreated: () => void }) {
  const [memberCode, setMemberCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/loyalty/accounts', {
        method: 'POST',
        body: {
          memberCode,
          ...(displayName ? { displayName } : {}),
        },
      });
      setMemberCode('');
      setDisplayName('');
      onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Enrol a member"
      description="The member code is an operator-issued identifier, and the label is an operator-facing note. Neither is a contact or payment detail; anything that looks like one is rejected rather than stored."
    >
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Member code" required>
              <input
                value={memberCode}
                onChange={(event) => setMemberCode(event.target.value)}
                placeholder="MEM-001"
                required
              />
            </Field>
            <Field label="Label" hint="Operator-facing only">
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Store 1 regular"
              />
            </Field>
          </FormRow>
          {formError ? <Notice tone="critical">{formError}</Notice> : null}
          <button type="submit" disabled={busy}>
            {busy ? 'Enrolling…' : 'Enrol member'}
          </button>
        </form>
      </Card>
    </Section>
  );
}

function AccountSection({
  accounts,
  onChanged,
  onNotice,
}: {
  accounts: LoyaltyAccountWithBalance[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  return (
    <Section
      title="Members"
      description="A balance is the sum of an append-only ledger. Nothing edits or deletes a movement — a mistake is corrected by appending a reversal."
    >
      {accounts.length === 0 ? (
        <EmptyState>
          No loyalty accounts yet. Enrol one above, then accrue points against
          it.
        </EmptyState>
      ) : null}
      {accounts.map((entry) => (
        <AccountCard
          key={entry.account.id}
          entry={entry}
          onChanged={onChanged}
          onNotice={onNotice}
        />
      ))}
    </Section>
  );
}

function AccountCard({
  entry,
  onChanged,
  onNotice,
}: {
  entry: LoyaltyAccountWithBalance;
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const { account } = entry;
  const [points, setPoints] = useState('');
  const [reasonCode, setReasonCode] = useState('PURCHASE');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const movements = useLoad<Paginated<LoyaltyPointMovement> | null>(
    () =>
      api<Paginated<LoyaltyPointMovement>>(
        `/loyalty/accounts/${account.id}/movements?take=25`,
      ).catch(() => null),
    [account.id, entry.movementCount],
  );

  async function post(action: 'accrue' | 'redeem') {
    const amount = Number(points);
    if (!Number.isInteger(amount) || amount < 1) {
      setCardError('Enter a whole number of points, 1 or more.');
      return;
    }
    setBusy(true);
    setCardError(null);
    try {
      const result = await api<PointMovementResult>(
        `/loyalty/accounts/${account.id}/${action}`,
        {
          method: 'POST',
          body: {
            points: amount,
            reasonCode,
            ...(note ? { note } : {}),
            // The API is idempotent on this key, so a double-click moves
            // points once.
            idempotencyKey: movementIdempotencyKey(account.id, action),
          },
        },
      );
      setPoints('');
      setNote('');
      onNotice(
        result.replayed
          ? `Replayed — points were already moved. Balance ${result.pointsBalance}.`
          : `Balance is now ${result.pointsBalance}.`,
      );
      onChanged();
    } catch (err) {
      setCardError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED') {
    setBusy(true);
    setCardError(null);
    try {
      await api(`/loyalty/accounts/${account.id}`, {
        method: 'PATCH',
        body: { status },
      });
      onChanged();
    } catch (err) {
      setCardError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const ledger = movements.data?.items ?? [];

  return (
    <Card>
      <h3>
        {account.memberCode} <StatusBadge status={account.status} />
      </h3>
      <p>
        {account.displayName ?? '—'} · balance{' '}
        <strong>{entry.pointsBalance}</strong> points ·{' '}
        {entry.movementCount} movements · enrolled{' '}
        {formatDate(account.enrolledAt)}
      </p>
      {ledger.length > 0 &&
      balanceFromLedger(ledger) !== entry.pointsBalance ? (
        <Notice tone="warn">
          The listed page of movements does not end at the reported balance —
          older movements are on a later page.
        </Notice>
      ) : null}

      {account.status === 'ACTIVE' ? (
        <Disclosure summary="Move points">
          <FormRow>
            <Field label="Points" required>
              <input
                value={points}
                onChange={(event) => setPoints(event.target.value)}
                inputMode="numeric"
                placeholder="100"
              />
            </Field>
            <Field label="Reason code" required>
              <input
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value)}
                placeholder="PURCHASE"
              />
            </Field>
            <Field label="Note" hint="Screened; also stored in the audit log">
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </FormRow>
          <button type="button" disabled={busy} onClick={() => post('accrue')}>
            Accrue
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => post('redeem')}>
            Redeem
          </button>
          <p>
            A redemption larger than the balance is refused. It can never
            overdraw.
          </p>
        </Disclosure>
      ) : null}

      <Disclosure summary={`Ledger (${ledger.length} shown)`}>
        {ledger.length === 0 ? (
          <EmptyState>No movements yet.</EmptyState>
        ) : (
          <DataTable
            rows={ledger}
            rowKey={(movement) => movement.id}
            columns={[
              { key: 'seq', header: '#', numeric: true, render: (m) => m.sequenceNumber },
              { key: 'type', header: 'Type', render: (m) => <StatusBadge status={m.type} /> },
              { key: 'points', header: 'Points', numeric: true, render: (m) => formatPoints(m.points) },
              { key: 'balance', header: 'Balance after', numeric: true, render: (m) => m.balanceAfter },
              { key: 'reason', header: 'Reason', render: (m) => m.reasonCode },
              { key: 'when', header: 'When', render: (m) => formatDate(m.createdAt) },
            ]}
          />
        )}
      </Disclosure>

      {account.status !== 'CLOSED' ? (
        <p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setStatus(account.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE')
            }
          >
            {account.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => setStatus('CLOSED')}>
            Close
          </button>
        </p>
      ) : null}
      {cardError ? <Notice tone="critical">{cardError}</Notice> : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Promotions                                                          */
/* ------------------------------------------------------------------ */

function CreatePromotionForm({
  stores,
  onCreated,
}: {
  stores: Store[];
  onCreated: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<'ALL_SHOPPERS' | 'LOYALTY_MEMBERS'>(
    'ALL_SHOPPERS',
  );
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await api('/loyalty/promotions', {
        method: 'POST',
        body: {
          code,
          name,
          audience,
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
      title="New promotion"
      description="A promotion scoped to a store beats the tenant-wide one there, exactly as a price book does. It never changes the shelf price: a discount an operator wants on the shelf is a price book version with reason PROMOTION_BASE."
    >
      <Card>
        <form onSubmit={submit}>
          <FormRow>
            <Field label="Code" required>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="SUMMER-10"
                required
              />
            </Field>
            <Field label="Name" required>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Summer 10% off"
                required
              />
            </Field>
            <Field label="Audience" required>
              <select
                value={audience}
                onChange={(event) =>
                  setAudience(
                    event.target.value as 'ALL_SHOPPERS' | 'LOYALTY_MEMBERS',
                  )
                }
              >
                <option value="ALL_SHOPPERS">Everyone</option>
                <option value="LOYALTY_MEMBERS">Members only</option>
              </select>
            </Field>
            <Field label="Store" hint="Leave empty for every store">
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
            {busy ? 'Creating…' : 'Create promotion'}
          </button>
        </form>
      </Card>
    </Section>
  );
}

function PromotionSection({
  promotions,
  products,
  onChanged,
  onNotice,
}: {
  promotions: Promotion[];
  products: Product[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  return (
    <Section
      title="Promotions"
      description="Changing a discount means creating a new version and activating it. Activated versions are immutable, and any earlier one can be rolled back to — the rollback copies it forward rather than reopening it."
    >
      {promotions.length === 0 ? (
        <EmptyState>
          No promotions yet. Create one above, add rules to its draft version,
          then activate it — basket lines pick the discount up from there.
        </EmptyState>
      ) : null}
      {promotions.map((promotion) => (
        <PromotionCard
          key={promotion.id}
          promotion={promotion}
          products={products}
          onChanged={onChanged}
          onNotice={onNotice}
        />
      ))}
    </Section>
  );
}

function PromotionCard({
  promotion,
  products,
  onChanged,
  onNotice,
}: {
  promotion: Promotion;
  products: Product[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const current = activeVersion(promotion);
  const draft = latestDraft(promotion);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setCardError(null);
    try {
      await action();
      onNotice(message);
      onChanged();
    } catch (err) {
      setCardError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h3>
        {promotion.code} <StatusBadge status={promotion.status} />{' '}
        <StatusBadge status={promotion.audience} />
      </h3>
      <p>
        {promotion.name} · {promotion.location?.name ?? 'all stores'} · priority{' '}
        {promotion.priority}
      </p>
      <p>
        In force:{' '}
        {current
          ? `version ${current.versionNumber} since ${formatDate(current.effectiveFrom)}`
          : 'nothing — no active version'}
      </p>

      <p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(
              () =>
                api(`/loyalty/promotions/${promotion.id}/versions`, {
                  method: 'POST',
                  body: {
                    reason: 'RULE_CHANGE',
                    ...(current ? { copyFromVersionId: current.id } : {}),
                  },
                }),
              'Draft version created.',
            )
          }
        >
          New draft version
        </button>
      </p>

      {draft ? (
        <DraftVersionEditor
          promotionId={promotion.id}
          version={draft}
          products={products}
          onChanged={onChanged}
          onNotice={onNotice}
        />
      ) : null}

      <Disclosure summary={`Versions (${promotion.versions?.length ?? 0})`}>
        <DataTable
          rows={promotion.versions ?? []}
          rowKey={(version) => version.id}
          columns={[
            { key: 'number', header: 'Version', numeric: true, render: (v) => v.versionNumber },
            { key: 'status', header: 'Status', render: (v) => <StatusBadge status={v.status} /> },
            { key: 'from', header: 'From', render: (v) => formatDate(v.effectiveFrom) },
            {
              key: 'to',
              header: 'To',
              render: (v) => (v.effectiveTo ? formatDate(v.effectiveTo) : '—'),
            },
            { key: 'reason', header: 'Reason', render: (v) => v.reason },
            {
              key: 'rollback',
              header: '',
              render: (v: PromotionVersion) =>
                v.status === 'SUPERSEDED' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          api(
                            `/loyalty/promotions/${promotion.id}/versions/${v.id}/rollback`,
                            { method: 'POST', body: {} },
                          ),
                        `Rolled back to version ${v.versionNumber} by copying it forward.`,
                      )
                    }
                  >
                    Roll back to this
                  </button>
                ) : null,
            },
          ]}
        />
      </Disclosure>

      <p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(
              () =>
                api(`/loyalty/promotions/${promotion.id}`, {
                  method: 'PATCH',
                  body: {
                    status:
                      promotion.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
                  },
                }),
              promotion.status === 'ACTIVE'
                ? 'Promotion archived — its versions stop applying.'
                : 'Promotion reactivated.',
            )
          }
        >
          {promotion.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
        </button>
      </p>
      {cardError ? <Notice tone="critical">{cardError}</Notice> : null}
    </Card>
  );
}

function DraftVersionEditor({
  promotionId,
  version,
  products,
  onChanged,
  onNotice,
}: {
  promotionId: string;
  version: PromotionVersion;
  products: Product[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [productId, setProductId] = useState('');
  const [kind, setKind] = useState<
    'PERCENT_OFF' | 'AMOUNT_OFF' | 'FIXED_UNIT_PRICE'
  >('PERCENT_OFF');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const rules = useLoad<PromotionRule[] | null>(
    () =>
      api<PromotionRule[]>(
        `/loyalty/promotions/${promotionId}/versions/${version.id}/rules`,
      ).catch(() => null),
    [promotionId, version.id],
  );

  async function replaceRules(event: FormEvent) {
    event.preventDefault();
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 1) {
      setEditorError('Enter a whole number, 1 or more.');
      return;
    }
    setBusy(true);
    setEditorError(null);
    try {
      await api(
        `/loyalty/promotions/${promotionId}/versions/${version.id}/rules`,
        {
          method: 'POST',
          body: {
            rules: [
              {
                ...(productId ? { productId } : {}),
                kind,
                value: numeric,
              },
            ],
          },
        },
      );
      onNotice(`Draft version ${version.versionNumber} rules replaced.`);
      onChanged();
    } catch (err) {
      setEditorError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setBusy(true);
    setEditorError(null);
    try {
      await api(
        `/loyalty/promotions/${promotionId}/versions/${version.id}/activate`,
        { method: 'POST', body: {} },
      );
      onNotice(
        `Version ${version.versionNumber} is in force. Shelf prices are unchanged — a promotion applies at the basket.`,
      );
      onChanged();
    } catch (err) {
      setEditorError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Disclosure summary={`Draft version ${version.versionNumber}`}>
      {rules.data && rules.data.length > 0 ? (
        <DataTable
          rows={rules.data}
          rowKey={(rule) => rule.id}
          columns={[
            { key: 'scope', header: 'Applies to', render: (rule) => describeRuleScope(rule) },
            { key: 'effect', header: 'Effect', render: (rule) => describeRule(rule) },
          ]}
        />
      ) : (
        <EmptyState>
          No rules yet. A version with no rules cannot be activated.
        </EmptyState>
      )}
      <form onSubmit={replaceRules}>
        <FormRow>
          <Field label="Product" hint="Leave empty for every product">
            <select
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="">Every product</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.sku} — {product.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effect" required>
            <select
              value={kind}
              onChange={(event) =>
                setKind(
                  event.target.value as
                    | 'PERCENT_OFF'
                    | 'AMOUNT_OFF'
                    | 'FIXED_UNIT_PRICE',
                )
              }
            >
              <option value="PERCENT_OFF">Percent off (basis points)</option>
              <option value="AMOUNT_OFF">Amount off (minor units)</option>
              <option value="FIXED_UNIT_PRICE">
                Fixed unit price (minor units)
              </option>
            </select>
          </Field>
          <Field
            label="Value"
            required
            hint="1000 basis points = 10%. Minor units: 250 = 2.50"
          >
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              inputMode="numeric"
              required
            />
          </Field>
        </FormRow>
        {editorError ? <Notice tone="critical">{editorError}</Notice> : null}
        <button type="submit" disabled={busy}>
          Replace rules
        </button>{' '}
        <button type="button" disabled={busy} onClick={activate}>
          Activate this version
        </button>
      </form>
      <p>
        Activating supersedes the version in force by closing its window. No
        row is rewritten, and no price book is touched.
      </p>
    </Disclosure>
  );
}
