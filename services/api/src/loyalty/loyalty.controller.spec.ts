import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { CreateLoyaltyAccountDto } from './dto/loyalty-account.dto';
import { AdjustPointsDto, RedeemPointsDto } from './dto/points.dto';
import {
  PromotionRuleDto,
  QuotePriceDto,
  SetPromotionRulesDto,
} from './dto/promotion.dto';
import { LoyaltyController } from './loyalty.controller';

/**
 * Access-policy pin for the loyalty surface: tenant-scoped, gated on the
 * loyalty module, and split so that reading a balance does not imply the
 * right to move points, and managing a promotion does not imply the right to
 * make it take effect.
 */
describe('Loyalty controller access policy', () => {
  it('is tenant-only and gated on the loyalty module', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, LoyaltyController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, LoyaltyController)).toBe(
      'loyalty',
    );
  });

  it.each([
    ['listAccounts', ['loyalty-account:read']],
    ['findAccount', ['loyalty-account:read']],
    ['createAccount', ['loyalty-account:manage']],
    ['updateAccount', ['loyalty-account:manage']],
    ['listMovements', ['loyalty-points:read']],
    ['accrue', ['loyalty-points:post']],
    ['redeem', ['loyalty-points:post']],
    ['adjust', ['loyalty-points:adjust']],
    ['listPromotions', ['promotion:read']],
    ['findPromotion', ['promotion:read']],
    ['findVersion', ['promotion:read']],
    ['findRules', ['promotion:read']],
    ['quote', ['promotion:read']],
    ['createPromotion', ['promotion:manage']],
    ['updatePromotion', ['promotion:manage']],
    ['createVersion', ['promotion:manage']],
    ['setRules', ['promotion:manage']],
    ['activateVersion', ['promotion:activate']],
    ['rollbackVersion', ['promotion:activate']],
  ] as const)('requires %s permissions', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        LoyaltyController.prototype[handler],
      ),
    ).toEqual(expected);
  });

  it('never lets a read permission move points or start a discount', () => {
    const readOnly = [
      'loyalty-account:read',
      'loyalty-points:read',
      'promotion:read',
    ];
    for (const handler of [
      'accrue',
      'redeem',
      'adjust',
      'activateVersion',
      'rollbackVersion',
    ] as const) {
      const required: string[] = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        LoyaltyController.prototype[handler],
      );
      expect(required.some((code) => readOnly.includes(code))).toBe(false);
    }
  });

  it('separates editing a promotion from making it take effect', () => {
    for (const handler of ['activateVersion', 'rollbackVersion'] as const) {
      const required: string[] = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        LoyaltyController.prototype[handler],
      );
      expect(required).not.toContain('promotion:manage');
    }
  });
});

describe('Loyalty controller delegates with the caller’s tenant', () => {
  const stub = <T>(value: T) =>
    jest.fn(async (..._args: unknown[]): Promise<T> => value);

  function build() {
    const loyalty = {
      findAccounts: stub({ items: [], total: 0 }),
      createAccount: stub({ id: 'acc-1' }),
      findAccountById: stub({ account: { id: 'acc-1' }, pointsBalance: 0, movementCount: 0 }),
      updateAccount: stub({ id: 'acc-1' }),
      findMovements: stub({ items: [], total: 0 }),
      accrue: stub({ movement: { id: 'm' }, pointsBalance: 1, replayed: false }),
      redeem: stub({ movement: { id: 'm' }, pointsBalance: 1, replayed: false }),
      adjust: stub({ movement: { id: 'm' }, pointsBalance: 1, replayed: false }),
      findPromotions: stub({ items: [], total: 0 }),
      createPromotion: stub({ id: 'promo-1' }),
      findPromotionById: stub({ id: 'promo-1' }),
      updatePromotion: stub({ id: 'promo-1' }),
      createVersion: stub({ id: 'pver-1' }),
      findVersion: stub({ id: 'pver-1' }),
      findRules: stub([]),
      setRules: stub({ id: 'pver-1' }),
      activateVersion: stub({ id: 'pver-1' }),
      rollbackToVersion: stub({ id: 'pver-2' }),
      quote: stub(null),
    };
    return {
      controller: new LoyaltyController(loyalty as never),
      loyalty,
    };
  }

  const actor = { userId: 'user-1', email: 'ops@tenant.test' } as never;

  it('passes the authenticated tenant, never a body value', async () => {
    const { controller, loyalty } = build();
    await controller.createAccount(
      'tenant-a',
      { memberCode: 'MEM-001' },
      actor,
    );
    expect(loyalty.createAccount.mock.calls[0][0]).toBe('tenant-a');
    expect(loyalty.createAccount.mock.calls[0][2]).toEqual({
      id: 'user-1',
      email: 'ops@tenant.test',
    });
  });

  it('passes the tenant on every points route', async () => {
    const { controller, loyalty } = build();
    const body = {
      points: 5,
      reasonCode: 'PURCHASE',
      idempotencyKey: 'k1',
    };
    await controller.accrue('tenant-a', 'acc-1', body, actor);
    await controller.redeem('tenant-a', 'acc-1', body, actor);
    await controller.adjust(
      'tenant-a',
      'acc-1',
      { ...body, type: 'ADJUSTMENT', points: -5 },
      actor,
    );
    for (const fn of [loyalty.accrue, loyalty.redeem, loyalty.adjust]) {
      expect(fn.mock.calls[0][0]).toBe('tenant-a');
      expect(fn.mock.calls[0][1]).toBe('acc-1');
    }
  });
});

describe('Loyalty DTO validation', () => {
  const validateDto = async <T extends object>(
    cls: new () => T,
    payload: Record<string, unknown>,
  ) => validate(plainToInstance(cls, payload));

  it('rejects a member code with an unsupported charset', async () => {
    expect(
      await validateDto(CreateLoyaltyAccountDto, { memberCode: 'mem 001!' }),
    ).not.toHaveLength(0);
    expect(
      await validateDto(CreateLoyaltyAccountDto, { memberCode: 'MEM-001' }),
    ).toHaveLength(0);
  });

  it('requires an idempotency key on every points movement', async () => {
    const errors = await validateDto(RedeemPointsDto, {
      points: 10,
      reasonCode: 'REWARD',
    });
    expect(
      errors.some((error) => error.property === 'idempotencyKey'),
    ).toBe(true);
  });

  it('refuses a non-positive redemption magnitude', async () => {
    expect(
      await validateDto(RedeemPointsDto, {
        points: 0,
        reasonCode: 'REWARD',
        idempotencyKey: 'k1',
      }),
    ).not.toHaveLength(0);
    expect(
      await validateDto(RedeemPointsDto, {
        points: -5,
        reasonCode: 'REWARD',
        idempotencyKey: 'k1',
      }),
    ).not.toHaveLength(0);
  });

  it('refuses a zero adjustment, which would be a movement that moves nothing', async () => {
    expect(
      await validateDto(AdjustPointsDto, {
        type: 'ADJUSTMENT',
        points: 0,
        reasonCode: 'CORRECTION',
        idempotencyKey: 'k1',
      }),
    ).not.toHaveLength(0);
  });

  it('accepts a signed adjustment', async () => {
    expect(
      await validateDto(AdjustPointsDto, {
        type: 'REVERSAL',
        points: -25,
        reasonCode: 'CORRECTION',
        idempotencyKey: 'k1',
      }),
    ).toHaveLength(0);
  });

  it('refuses a promotion rule value of zero or below', async () => {
    expect(
      await validateDto(PromotionRuleDto, { kind: 'AMOUNT_OFF', value: 0 }),
    ).not.toHaveLength(0);
  });

  it('requires at least one rule in a rule set', async () => {
    const errors = await validate(
      plainToInstance(SetPromotionRulesDto, { rules: [] }),
    );
    expect(errors).not.toHaveLength(0);
  });

  it('accepts a quote for a product with no location and no member', async () => {
    expect(
      await validateDto(QuotePriceDto, { productId: 'prod-1' }),
    ).toHaveLength(0);
  });

  it('refuses a malformed quote instant at the DTO boundary', async () => {
    expect(
      await validateDto(QuotePriceDto, { productId: 'prod-1', at: 'yesterday' }),
    ).not.toHaveLength(0);
  });
});
