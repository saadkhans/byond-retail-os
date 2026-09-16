import { AuditEntry } from '../common/audit/audit-log.service';
import { LoyaltyRepository } from './loyalty.repository';

/**
 * Two invariants are pinned here.
 *
 * 1. TENANT ISOLATION AT THE DATA LAYER (AGENTS.md, and the rule
 *    locations.repository.spec.ts pins): every destructive write carries the
 *    tenant IN the write predicate through the `id_tenantId` composite key.
 *    Relying on the tenant-scoped lookup that preceded the write is exactly
 *    the bug that has been found repeatedly in sibling phases.
 *
 * 2. THE POINTS LEDGER IS APPEND-ONLY, IDEMPOTENT, AND CANNOT OVERDRAW. The
 *    repository never exposes an update or delete for a movement, the
 *    balance is always a SUM over the ledger, and a redemption larger than
 *    that SUM is rejected before the insert — with the database CHECK behind
 *    it if this code were ever wrong.
 */

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const auditEntry = () => ({}) as AuditEntry;

interface Seed {
  account?: Record<string, unknown> | null;
  promotion?: Record<string, unknown> | null;
  version?: Record<string, unknown> | null;
  activeVersion?: Record<string, unknown> | null;
  movements?: { sum: number | null; max: number | null; count?: number };
  replay?: Record<string, unknown> | null;
  ruleCount?: number;
}

function buildHarness(seed: Seed = {}) {
  const created: Record<string, unknown>[] = [];
  const versionFindFirst = jest.fn(
    async (args: { where: Record<string, unknown> }) =>
      args.where.status === 'ACTIVE'
        ? (seed.activeVersion ?? null)
        : (seed.version ?? null),
  );
  const tx = {
    $queryRaw: jest.fn(async () => []),
    loyaltyAccount: {
      findFirst: jest.fn(async () => seed.account ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'acc-new',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(seed.account ?? {}),
        ...data,
      })),
    },
    loyaltyPointMovement: {
      findFirst: jest.fn(async () => seed.replay ?? null),
      aggregate: jest.fn(async () => ({
        _sum: { points: seed.movements?.sum ?? 0 },
        _max: { sequenceNumber: seed.movements?.max ?? 0 },
        _count: { _all: seed.movements?.count ?? 0 },
      })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'mov-new', ...data };
      }),
    },
    promotion: {
      findFirst: jest.fn(async () => seed.promotion ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'promo-new',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...(seed.promotion ?? {}),
        ...data,
      })),
    },
    promotionVersion: {
      findFirst: versionFindFirst,
      aggregate: jest.fn(async () => ({ _max: { versionNumber: 2 } })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'pver-new',
        ...data,
      })),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => ({ ...(seed.version ?? {}), ...data, _where: where }),
      ),
    },
    promotionRule: {
      count: jest.fn(async () => seed.ruleCount ?? 1),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
    },
    product: { count: jest.fn(async () => 1) },
    location: { findFirst: jest.fn(async () => ({ id: 'loc-1' })) },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const repository = new LoyaltyRepository(prisma as never, audit as never);
  return { repository, tx, audit, created };
}

const ACCOUNT = {
  id: 'acc-1',
  tenantId: TENANT,
  memberCode: 'MEM-001',
  status: 'ACTIVE',
};
const PROMOTION = { id: 'promo-1', tenantId: TENANT, code: 'SUMMER', status: 'ACTIVE' };
const DRAFT_VERSION = {
  id: 'pver-1',
  tenantId: TENANT,
  promotionId: 'promo-1',
  status: 'DRAFT',
  versionNumber: 3,
  note: null,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
};

describe('LoyaltyRepository destructive writes are tenant-scoped', () => {
  it('updates an account through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness({ account: ACCOUNT });
    await repository.updateAccount(
      TENANT,
      'acc-1',
      { status: 'SUSPENDED' },
      auditEntry,
    );
    expect(tx.loyaltyAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'acc-1', tenantId: TENANT } },
      }),
    );
  });

  it('updates a promotion through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness({ promotion: PROMOTION });
    await repository.updatePromotion(
      TENANT,
      'promo-1',
      { name: 'Renamed' },
      auditEntry,
    );
    expect(tx.promotion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'promo-1', tenantId: TENANT } },
      }),
    );
  });

  it('activates and supersedes versions through the id_tenantId composite key', async () => {
    const { repository, tx } = buildHarness({
      promotion: PROMOTION,
      version: DRAFT_VERSION,
      activeVersion: {
        id: 'pver-0',
        tenantId: TENANT,
        promotionId: 'promo-1',
        status: 'ACTIVE',
        versionNumber: 2,
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      },
    });
    await repository.activateVersion(
      TENANT,
      'promo-1',
      'pver-1',
      { effectiveFrom: new Date('2026-06-01T00:00:00Z') },
      { activated: auditEntry, superseded: auditEntry },
    );
    const wheres = tx.promotionVersion.update.mock.calls.map(
      (call) => (call[0] as { where: unknown }).where,
    );
    expect(wheres).toEqual([
      { id_tenantId: { id: 'pver-0', tenantId: TENANT } },
      { id_tenantId: { id: 'pver-1', tenantId: TENANT } },
    ]);
  });

  it('a foreign tenant finds nothing and never reaches the write', async () => {
    const { repository, tx } = buildHarness({ account: null, promotion: null });
    expect(
      await repository.updateAccount(OTHER, 'acc-1', { status: 'CLOSED' }, auditEntry),
    ).toBe('account-not-found');
    expect(tx.loyaltyAccount.update).not.toHaveBeenCalled();
    expect(
      await repository.updatePromotion(OTHER, 'promo-1', { name: 'X' }, auditEntry),
    ).toBe('promotion-not-found');
    expect(tx.promotion.update).not.toHaveBeenCalled();
  });

  it('scopes every rule delete by tenant, not by version id alone', async () => {
    const { repository, tx } = buildHarness({
      promotion: PROMOTION,
      version: DRAFT_VERSION,
    });
    await repository.setRules(
      TENANT,
      'promo-1',
      'pver-1',
      [{ productId: null, kind: 'AMOUNT_OFF', value: 100 }],
      auditEntry,
    );
    expect(tx.promotionRule.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, versionId: 'pver-1' },
    });
  });

  it('rejects an empty tenant id outright rather than querying wide open', () => {
    const { repository, tx } = buildHarness({ account: ACCOUNT });
    // Thrown synchronously, before the transaction even opens: a missing
    // tenant is an error, never a wildcard.
    expect(() =>
      repository.updateAccount('', 'acc-1', { status: 'CLOSED' }, auditEntry),
    ).toThrow(/tenantId is required/);
    expect(tx.loyaltyAccount.update).not.toHaveBeenCalled();
  });
});

describe('LoyaltyRepository points ledger', () => {
  it('exposes no way to update or delete a movement', () => {
    const surface = Object.getOwnPropertyNames(LoyaltyRepository.prototype);
    expect(
      surface.filter((name) => /movement/i.test(name)).sort(),
    ).toEqual(['appendMovement', 'findMovements']);
  });

  it('takes the per-account advisory lock before reading the ledger tail', async () => {
    const { repository, tx } = buildHarness({
      account: ACCOUNT,
      movements: { sum: 100, max: 2 },
    });
    await repository.appendMovement(
      TENANT,
      'acc-1',
      {
        type: 'ACCRUAL',
        points: 25,
        reasonCode: 'PURCHASE',
        idempotencyKey: 'key-1',
      },
      auditEntry,
    );
    expect(tx.$queryRaw).toHaveBeenCalled();
    const lockCallOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    const aggregateOrder =
      tx.loyaltyPointMovement.aggregate.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(aggregateOrder);
  });

  it('derives the balance from the ledger and stamps it on the new row', async () => {
    const { repository, created } = buildHarness({
      account: ACCOUNT,
      movements: { sum: 100, max: 2 },
    });
    const result = await repository.appendMovement(
      TENANT,
      'acc-1',
      {
        type: 'ACCRUAL',
        points: 25,
        reasonCode: 'PURCHASE',
        idempotencyKey: 'key-1',
      },
      auditEntry,
    );
    expect(typeof result === 'string' ? result : result.pointsBalance).toBe(125);
    expect(created[0]).toMatchObject({
      tenantId: TENANT,
      accountId: 'acc-1',
      sequenceNumber: 3,
      points: 25,
      balanceAfter: 125,
    });
  });

  it('REFUSES TO OVERDRAW and writes nothing', async () => {
    const { repository, tx } = buildHarness({
      account: ACCOUNT,
      movements: { sum: 40, max: 1 },
    });
    expect(
      await repository.appendMovement(
        TENANT,
        'acc-1',
        {
          type: 'REDEMPTION',
          points: -41,
          reasonCode: 'REWARD',
          idempotencyKey: 'key-2',
        },
        auditEntry,
      ),
    ).toBe('insufficient-points');
    expect(tx.loyaltyPointMovement.create).not.toHaveBeenCalled();
  });

  it('replays an idempotency key instead of moving points twice', async () => {
    const replay = {
      id: 'mov-1',
      accountId: 'acc-1',
      tenantId: TENANT,
      points: -30,
    };
    const { repository, tx } = buildHarness({
      account: ACCOUNT,
      movements: { sum: 70, max: 4 },
      replay,
    });
    const result = await repository.appendMovement(
      TENANT,
      'acc-1',
      {
        type: 'REDEMPTION',
        points: -30,
        reasonCode: 'REWARD',
        idempotencyKey: 'key-3',
      },
      auditEntry,
    );
    expect(typeof result === 'string' ? result : result.replayed).toBe(true);
    expect(typeof result === 'string' ? null : result.movement).toBe(replay);
    expect(tx.loyaltyPointMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a key that already belongs to a different account', async () => {
    const { repository, tx } = buildHarness({
      account: ACCOUNT,
      replay: { id: 'mov-1', accountId: 'acc-other', tenantId: TENANT },
    });
    expect(
      await repository.appendMovement(
        TENANT,
        'acc-1',
        {
          type: 'ACCRUAL',
          points: 5,
          reasonCode: 'PURCHASE',
          idempotencyKey: 'key-4',
        },
        auditEntry,
      ),
    ).toBe('idempotency-key-conflict');
    expect(tx.loyaltyPointMovement.create).not.toHaveBeenCalled();
  });

  it('refuses to move points on a suspended account', async () => {
    const { repository, tx } = buildHarness({
      account: { ...ACCOUNT, status: 'SUSPENDED' },
    });
    expect(
      await repository.appendMovement(
        TENANT,
        'acc-1',
        {
          type: 'ACCRUAL',
          points: 5,
          reasonCode: 'PURCHASE',
          idempotencyKey: 'key-5',
        },
        auditEntry,
      ),
    ).toBe('account-not-active');
    expect(tx.loyaltyPointMovement.create).not.toHaveBeenCalled();
  });

  it('commits the audit row inside the same transaction as the append', async () => {
    const { repository, tx, audit } = buildHarness({
      account: ACCOUNT,
      movements: { sum: 0, max: 0 },
    });
    await repository.appendMovement(
      TENANT,
      'acc-1',
      {
        type: 'ACCRUAL',
        points: 5,
        reasonCode: 'PURCHASE',
        idempotencyKey: 'key-6',
      },
      auditEntry,
    );
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), tx);
  });
});

describe('LoyaltyRepository promotion versioning', () => {
  it('refuses to edit the rules of a version that has been activated', async () => {
    const { repository, tx } = buildHarness({
      promotion: PROMOTION,
      version: { ...DRAFT_VERSION, status: 'ACTIVE' },
    });
    expect(
      await repository.setRules(
        TENANT,
        'promo-1',
        'pver-1',
        [{ productId: null, kind: 'AMOUNT_OFF', value: 1 }],
        auditEntry,
      ),
    ).toBe('version-not-draft');
    expect(tx.promotionRule.createMany).not.toHaveBeenCalled();
  });

  it('refuses to activate a version with no rules', async () => {
    const { repository } = buildHarness({
      promotion: PROMOTION,
      version: DRAFT_VERSION,
      ruleCount: 0,
    });
    expect(
      await repository.activateVersion(
        TENANT,
        'promo-1',
        'pver-1',
        { effectiveFrom: new Date() },
        { activated: auditEntry },
      ),
    ).toBe('version-empty');
  });

  it('refuses an effectiveFrom that would invert the active window', async () => {
    const { repository } = buildHarness({
      promotion: PROMOTION,
      version: DRAFT_VERSION,
      activeVersion: {
        id: 'pver-0',
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-06-01T00:00:00Z'),
      },
    });
    expect(
      await repository.activateVersion(
        TENANT,
        'promo-1',
        'pver-1',
        { effectiveFrom: new Date('2026-05-01T00:00:00Z') },
        { activated: auditEntry },
      ),
    ).toBe('effective-from-not-after-active');
  });

  it('rolls back by COPYING an old version forward, never reopening it', async () => {
    const { repository, tx } = buildHarness({
      promotion: PROMOTION,
      version: {
        id: 'pver-old',
        tenantId: TENANT,
        promotionId: 'promo-1',
        status: 'SUPERSEDED',
        versionNumber: 1,
        rules: [
          {
            productId: null,
            kind: 'AMOUNT_OFF',
            value: 150,
            maxDiscountMinor: null,
          },
        ],
      },
    });
    await repository.rollbackToVersion(
      TENANT,
      'promo-1',
      'pver-old',
      { at: new Date('2026-06-01T00:00:00Z') },
      { created: auditEntry, activated: auditEntry },
    );
    // A NEW version row is created carrying the old rules...
    expect(tx.promotionVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'ROLLBACK',
          rolledBackFromVersionId: 'pver-old',
        }),
      }),
    );
    // ...and the source row is never written to.
    const written = tx.promotionVersion.update.mock.calls.map(
      (call) =>
        (call[0] as unknown as { where: { id_tenantId: { id: string } } })
          .where.id_tenantId.id,
    );
    expect(written).not.toContain('pver-old');
  });

  it('refuses to roll back to a version that was never active', async () => {
    const { repository } = buildHarness({
      promotion: PROMOTION,
      version: { ...DRAFT_VERSION, rules: [] },
    });
    expect(
      await repository.rollbackToVersion(
        TENANT,
        'promo-1',
        'pver-1',
        { at: new Date() },
        { created: auditEntry, activated: auditEntry },
      ),
    ).toBe('source-version-not-applicable');
  });
});
