import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LoyaltyService } from './loyalty.service';

const TENANT = 'tenant-a';
const ACTOR = { id: 'user-1', email: 'ops@tenant.test' };

/** A PAN-shaped string: the strict free-text predicate must reject it. */
const CARD_LIKE = 'refund to 4111 1111 1111 1111';

// Typed as variadic so the assertions below can index mock.calls; an inferred
// zero-argument signature makes calls[0][n] a type error.
const stub = <T>(value: T) =>
  jest.fn(async (..._args: unknown[]): Promise<T> => value);

function buildService(
  repositoryOver: Partial<Record<string, unknown>> = {},
  promotionsOver: Partial<Record<string, unknown>> = {},
) {
  const repository = {
    createAccount: stub({ id: 'acc-1', memberCode: 'MEM-001' }),
    findAccounts: stub({ items: [], total: 0 }),
    findAccountById: stub(null),
    updateAccount: stub({ id: 'acc-1', memberCode: 'MEM-001' }),
    findMovements: stub({ items: [], total: 0 }),
    appendMovement: stub({
      movement: { id: 'mov-1', type: 'ACCRUAL', points: 10 },
      pointsBalance: 10,
      replayed: false,
    }),
    createPromotion: stub({ id: 'promo-1', code: 'SUMMER' }),
    findPromotions: stub({ items: [], total: 0 }),
    findPromotionById: stub(null),
    updatePromotion: stub({ id: 'promo-1', code: 'SUMMER' }),
    createVersion: stub({ id: 'pver-1', versionNumber: 1 }),
    findVersion: stub(null),
    findRules: stub([]),
    setRules: stub({ id: 'pver-1', versionNumber: 1 }),
    activateVersion: stub({ id: 'pver-1', versionNumber: 1 }),
    rollbackToVersion: stub({ id: 'pver-2', versionNumber: 2 }),
    ...repositoryOver,
  };
  const promotions = { quote: stub(null), ...promotionsOver };
  const service = new LoyaltyService(
    repository as never,
    promotions as never,
  );
  return { service, repository, promotions };
}

describe('LoyaltyService screens operator free text', () => {
  it.each([
    ['displayName on enrolment', async (s: LoyaltyService) =>
      s.createAccount(TENANT, { memberCode: 'MEM-001', displayName: CARD_LIKE }, ACTOR)],
    ['displayName on update', async (s: LoyaltyService) =>
      s.updateAccount(TENANT, 'acc-1', { displayName: CARD_LIKE }, ACTOR)],
    ['a promotion name', async (s: LoyaltyService) =>
      s.createPromotion(TENANT, { code: 'SUMMER', name: CARD_LIKE }, ACTOR)],
    ['a promotion version note', async (s: LoyaltyService) =>
      s.createVersion(TENANT, 'promo-1', { note: CARD_LIKE }, ACTOR)],
    ['an activation note', async (s: LoyaltyService) =>
      s.activateVersion(TENANT, 'promo-1', 'pver-1', { note: CARD_LIKE }, ACTOR)],
    ['a rollback note', async (s: LoyaltyService) =>
      s.rollbackToVersion(TENANT, 'promo-1', 'pver-1', { note: CARD_LIKE }, ACTOR)],
  ])('rejects payment-bearing text in %s', async (_label, run) => {
    const { service } = buildService();
    await expect(run(service)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a payment-bearing points note before anything is appended', async () => {
    const { service, repository } = buildService();
    await expect(
      service.accrue(
        TENANT,
        'acc-1',
        {
          points: 10,
          reasonCode: 'PURCHASE',
          note: CARD_LIKE,
          idempotencyKey: 'key-1',
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.appendMovement).not.toHaveBeenCalled();
  });

  it('copies a safe note into AuditLog.reason and keeps it out otherwise', async () => {
    const { service, repository } = buildService();
    await service.accrue(
      TENANT,
      'acc-1',
      {
        points: 10,
        reasonCode: 'purchase reward',
        note: 'Launch week bonus',
        idempotencyKey: 'key-1',
      },
      ACTOR,
    );
    const [, , input, buildAudit] = repository.appendMovement.mock.calls[0] as [
      string,
      string,
      { reasonCode: string; points: number },
      (movement: unknown, balance: number) => { reason?: string },
    ];
    expect(input.reasonCode).toBe('PURCHASE_REWARD');
    expect(buildAudit({ id: 'mov-1' }, 10).reason).toBe('Launch week bonus');
  });
});

describe('LoyaltyService points semantics', () => {
  it('sends an accrual as a POSITIVE delta and a redemption as a NEGATIVE one', async () => {
    const { service, repository } = buildService();
    await service.accrue(
      TENANT,
      'acc-1',
      { points: 40, reasonCode: 'PURCHASE', idempotencyKey: 'k1' },
      ACTOR,
    );
    await service.redeem(
      TENANT,
      'acc-1',
      { points: 40, reasonCode: 'REWARD', idempotencyKey: 'k2' },
      ACTOR,
    );
    const deltas = repository.appendMovement.mock.calls.map(
      (call) => (call[2] as { points: number }).points,
    );
    expect(deltas).toEqual([40, -40]);
  });

  it('keeps the caller-supplied sign on a manual adjustment', async () => {
    const { service, repository } = buildService();
    await service.adjust(
      TENANT,
      'acc-1',
      {
        type: 'REVERSAL',
        points: -15,
        reasonCode: 'CORRECTION',
        idempotencyKey: 'k3',
      },
      ACTOR,
    );
    expect(
      (repository.appendMovement.mock.calls[0][2] as { points: number }).points,
    ).toBe(-15);
  });

  it('turns an overdraw into a 409, never a negative balance', async () => {
    const { service } = buildService({
      appendMovement: stub('insufficient-points'),
    });
    await expect(
      service.redeem(
        TENANT,
        'acc-1',
        { points: 5000, reasonCode: 'REWARD', idempotencyKey: 'k4' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('turns a reused key on another account into a 409, not the other movement', async () => {
    const { service } = buildService({
      appendMovement: stub('idempotency-key-conflict'),
    });
    await expect(
      service.accrue(
        TENANT,
        'acc-1',
        { points: 5, reasonCode: 'PURCHASE', idempotencyKey: 'k5' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports a replay as a replay rather than a new movement', async () => {
    const { service } = buildService({
      appendMovement: stub({
        movement: { id: 'mov-1' },
        pointsBalance: 70,
        replayed: true,
      }),
    });
    const result = await service.redeem(
      TENANT,
      'acc-1',
      { points: 30, reasonCode: 'REWARD', idempotencyKey: 'k6' },
      ACTOR,
    );
    expect(result.replayed).toBe(true);
    expect(result.pointsBalance).toBe(70);
  });

  it('404s for an unknown account', async () => {
    const { service } = buildService({
      appendMovement: stub('account-not-found'),
    });
    await expect(
      service.accrue(
        TENANT,
        'nope',
        { points: 5, reasonCode: 'PURCHASE', idempotencyKey: 'k7' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('LoyaltyService promotion rules', () => {
  it('rejects two rules for the same product', async () => {
    const { service, repository } = buildService();
    await expect(
      service.setRules(
        TENANT,
        'promo-1',
        'pver-1',
        {
          rules: [
            { productId: 'p1', kind: 'AMOUNT_OFF', value: 10 },
            { productId: 'p1', kind: 'PERCENT_OFF', value: 500 },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.setRules).not.toHaveBeenCalled();
  });

  it('rejects two catalog-wide rules in one version', async () => {
    const { service } = buildService();
    await expect(
      service.setRules(
        TENANT,
        'promo-1',
        'pver-1',
        {
          rules: [
            { kind: 'AMOUNT_OFF', value: 10 },
            { kind: 'PERCENT_OFF', value: 500 },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a PERCENT_OFF above 100% expressed in basis points', async () => {
    const { service } = buildService();
    await expect(
      service.setRules(
        TENANT,
        'promo-1',
        'pver-1',
        { rules: [{ kind: 'PERCENT_OFF', value: 10001 }] },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a discount ceiling on a rule kind that cannot use one', async () => {
    const { service } = buildService();
    await expect(
      service.setRules(
        TENANT,
        'promo-1',
        'pver-1',
        {
          rules: [
            { kind: 'AMOUNT_OFF', value: 100, maxDiscountMinor: 50 },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps every version rejection to a typed HTTP error', async () => {
    const cases: [string, unknown][] = [
      ['promotion-not-found', NotFoundException],
      ['version-not-found', NotFoundException],
      ['copy-source-not-found', NotFoundException],
      ['product-not-found', NotFoundException],
      ['promotion-archived', ConflictException],
      ['version-not-draft', ConflictException],
      ['version-not-activatable', ConflictException],
      ['version-empty', ConflictException],
      ['source-version-not-applicable', ConflictException],
      ['effective-from-not-after-active', ConflictException],
    ];
    for (const [rejection, expected] of cases) {
      const { service } = buildService({
        activateVersion: stub(rejection),
      });
      await expect(
        service.activateVersion(TENANT, 'promo-1', 'pver-1', {}, ACTOR),
      ).rejects.toBeInstanceOf(expected as never);
    }
  });

  it('audits an activation as PROMOTION_CHANGE, not as a price change', async () => {
    const { service, repository } = buildService();
    await service.activateVersion(TENANT, 'promo-1', 'pver-1', {}, ACTOR);
    const builders = repository.activateVersion.mock.calls[0][4] as {
      activated: (a: unknown, b: unknown) => { action: string; entityType: string };
    };
    const entry = builders.activated(
      { versionNumber: 1 },
      { id: 'pver-1', versionNumber: 1 },
    );
    expect(entry.action).toBe('PROMOTION_CHANGE');
    expect(entry.entityType).toBe('PromotionVersion');
  });

  it('rejects a malformed instant rather than silently defaulting to now', async () => {
    const { service } = buildService();
    await expect(
      service.activateVersion(
        TENANT,
        'promo-1',
        'pver-1',
        { effectiveFrom: 'not-a-date' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('normalizes codes to uppercase', async () => {
    const { service, repository } = buildService();
    await service.createPromotion(
      TENANT,
      { code: 'summer-10', name: 'Summer' },
      ACTOR,
    );
    expect(
      (repository.createPromotion.mock.calls[0][1] as { code: string }).code,
    ).toBe('SUMMER-10');
    await service.createAccount(TENANT, { memberCode: 'mem-001' }, ACTOR);
    expect(
      (repository.createAccount.mock.calls[0][1] as { memberCode: string })
        .memberCode,
    ).toBe('MEM-001');
  });

  it('404s when an account does not exist', async () => {
    const { service } = buildService();
    await expect(service.findAccountById(TENANT, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
