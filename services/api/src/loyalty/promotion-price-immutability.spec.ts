import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuditEntry } from '../common/audit/audit-log.service';
import { LoyaltyRepository } from './loyalty.repository';
import { PromotionResolutionService } from './promotion-resolution.service';

/**
 * THE PHASE 29 INVARIANT, PINNED: a promotion must not bypass price
 * versioning.
 *
 * Phase 25 made a price an immutable entry inside a versioned price book, and
 * Phase 28 made activation the event that drives shelf labels. A promotion is
 * therefore allowed to READ a resolved price VALUE and subtract from it, and
 * nothing else. It may never write, supersede, or shadow a price row.
 *
 * Two guards, because each catches what the other cannot:
 *
 *  1. A STRUCTURAL BOOBY-TRAP. The whole promotion lifecycle — create,
 *     version, set rules, activate, roll back, resolve — is driven against a
 *     Prisma stand-in whose `priceBook`, `priceBookVersion` and
 *     `priceBookEntry` models are Proxies that THROW ON ANY PROPERTY ACCESS.
 *     Not on `.update()`; on `.update` itself, and on `.findFirst`, and on
 *     `Symbol.toPrimitive`. A future edit that so much as reaches for a price
 *     model from a promotion path fails this spec loudly, instead of quietly
 *     acquiring the ability to rewrite price history.
 *
 *  2. A STATIC GREP GUARD, in the style of the Phase 9/10/28 guards. The
 *     booby-trap only covers the code paths the spec drives; the grep covers
 *     every line in the directory, including ones nobody has called yet.
 */

const TENANT = 'tenant-a';
const auditEntry = () => ({}) as AuditEntry;

/** Any touch at all explodes — reads included. */
function forbiddenModel(name: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `promotion path touched the price model "${name}" ` +
            `(property: ${String(property)}). A promotion composes ON TOP of ` +
            `a resolved price; it never reads or writes a price row.`,
        );
      },
      set(_target, property) {
        throw new Error(
          `promotion path wrote to the price model "${name}" ` +
            `(property: ${String(property)}).`,
        );
      },
    },
  );
}

const DRAFT_VERSION = {
  id: 'pver-1',
  tenantId: TENANT,
  promotionId: 'promo-1',
  status: 'DRAFT',
  versionNumber: 2,
  note: null,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  rules: [
    { productId: null, kind: 'AMOUNT_OFF', value: 150, maxDiscountMinor: null },
  ],
};

const SUPERSEDED_VERSION = { ...DRAFT_VERSION, id: 'pver-0', status: 'SUPERSEDED' };

function buildTrappedHarness() {
  const tx = {
    $queryRaw: jest.fn(async () => []),
    // The trap. Reaching for any of these from a promotion path throws.
    priceBook: forbiddenModel('priceBook'),
    priceBookVersion: forbiddenModel('priceBookVersion'),
    priceBookEntry: forbiddenModel('priceBookEntry'),
    loyaltyAccount: {
      findFirst: jest.fn(async () => ({
        id: 'acc-1',
        tenantId: TENANT,
        status: 'ACTIVE',
        memberCode: 'MEM-001',
      })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'acc-new',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'acc-1',
        ...data,
      })),
    },
    loyaltyPointMovement: {
      findFirst: jest.fn(async () => null),
      aggregate: jest.fn(async () => ({
        _sum: { points: 500 },
        _max: { sequenceNumber: 4 },
        _count: { _all: 4 },
      })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'mov-new',
        ...data,
      })),
    },
    promotion: {
      findFirst: jest.fn(async () => ({
        id: 'promo-1',
        tenantId: TENANT,
        code: 'SUMMER',
        status: 'ACTIVE',
      })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'promo-new',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'promo-1',
        ...data,
      })),
    },
    promotionVersion: {
      findFirst: jest.fn(
        async (args: { where: Record<string, unknown> }) =>
          args.where.status === 'ACTIVE' ? null : SUPERSEDED_VERSION,
      ),
      findMany: jest.fn(async () => [
        {
          id: 'pver-1',
          versionNumber: 1,
          status: 'ACTIVE',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          effectiveTo: null,
          promotion: {
            id: 'promo-1',
            code: 'SUMMER',
            locationId: null,
            audience: 'ALL_SHOPPERS',
            priority: 0,
          },
          rules: [
            {
              id: 'rule-1',
              productId: null,
              kind: 'AMOUNT_OFF',
              value: 150,
              maxDiscountMinor: null,
            },
          ],
        },
      ]),
      aggregate: jest.fn(async () => ({ _max: { versionNumber: 2 } })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'pver-new',
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'pver-1',
        ...data,
      })),
    },
    promotionRule: {
      count: jest.fn(async () => 1),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => []),
    },
    product: { count: jest.fn(async () => 1) },
    location: { findFirst: jest.fn(async () => ({ id: 'loc-1' })) },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const repository = new LoyaltyRepository(prisma as never, audit as never);
  return { repository, prisma, tx };
}

describe('a promotion can never write a price version (structural trap)', () => {
  it('drives the WHOLE promotion lifecycle without touching a price model', async () => {
    const { repository } = buildTrappedHarness();

    // Every one of these would fail if it so much as reached for a price
    // model — the Proxy throws on property access, not only on a call.
    await expect(
      repository.createPromotion(
        TENANT,
        {
          code: 'SUMMER',
          name: 'Summer',
          audience: 'ALL_SHOPPERS',
          priority: 0,
        },
        auditEntry,
      ),
    ).resolves.toBeDefined();

    await expect(
      repository.createVersion(
        TENANT,
        'promo-1',
        { reason: 'RULE_CHANGE', effectiveFrom: new Date() },
        auditEntry,
      ),
    ).resolves.toBeDefined();

    await expect(
      repository.setRules(
        TENANT,
        'promo-1',
        'pver-1',
        [{ productId: null, kind: 'AMOUNT_OFF', value: 150 }],
        auditEntry,
      ),
    ).resolves.toBeDefined();

    await expect(
      repository.activateVersion(
        TENANT,
        'promo-1',
        'pver-1',
        { effectiveFrom: new Date('2026-06-01T00:00:00Z') },
        { activated: auditEntry, superseded: auditEntry },
      ),
    ).resolves.toBeDefined();

    await expect(
      repository.rollbackToVersion(
        TENANT,
        'promo-1',
        'pver-0',
        { at: new Date('2026-07-01T00:00:00Z') },
        { created: auditEntry, activated: auditEntry },
      ),
    ).resolves.toBeDefined();

    await expect(
      repository.findPromotionCandidates(
        TENANT,
        ['prod-1'],
        new Date('2026-06-15T00:00:00Z'),
        null,
      ),
    ).resolves.toHaveLength(1);

    await expect(repository.isActiveMember(TENANT, 'acc-1')).resolves.toBe(true);
  });

  it('appends points without touching a price model either', async () => {
    const { repository } = buildTrappedHarness();
    await expect(
      repository.appendMovement(
        TENANT,
        'acc-1',
        {
          type: 'REDEMPTION',
          points: -100,
          reasonCode: 'REWARD',
          idempotencyKey: 'key-1',
        },
        auditEntry,
      ),
    ).resolves.toMatchObject({ pointsBalance: 400 });
  });

  it('resolves a promoted line price from a VALUE, never from a price row', async () => {
    const { repository, tx } = buildTrappedHarness();
    const platformModules = { isEnabledForTenant: jest.fn(async () => true) };
    // Pricing is a stub here ON PURPOSE: the promotion service is only ever
    // handed a resolved price VALUE, so it has nothing to reach into.
    const priceResolution = {
      resolve: jest.fn(async () => ({
        unitPriceMinor: 1000,
        currencyCode: 'AED',
        priceBookId: 'book-1',
        priceBookVersionId: 'ver-1',
      })),
    };
    const service = new PromotionResolutionService(
      repository,
      priceResolution as never,
      platformModules as never,
    );
    const promoted = await service.resolveForLine(tx as never, {
      tenantId: TENANT,
      productId: 'prod-1',
      locationId: 'loc-1',
      at: new Date('2026-06-15T00:00:00Z'),
      base: {
        unitPriceMinor: 1000,
        currencyCode: 'AED',
        priceBookId: 'book-1',
        priceBookVersionId: 'ver-1',
      },
      loyaltyAccountId: null,
    });
    expect(promoted).toEqual({
      basePriceMinor: 1000,
      discountMinor: 150,
      unitPriceMinor: 850,
      currencyCode: 'AED',
      promotionId: 'promo-1',
      promotionVersionId: 'pver-1',
    });
  });

  it('proves the trap actually bites', () => {
    const { tx } = buildTrappedHarness();
    expect(() => (tx.priceBookVersion as { update: unknown }).update).toThrow(
      /never reads or writes a price row/,
    );
    expect(() => (tx.priceBookEntry as { findMany: unknown }).findMany).toThrow(
      /priceBookEntry/,
    );
  });
});

describe('a promotion can never write a price version (static guard)', () => {
  const collectSources = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...collectSources(full));
      } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
    return files;
  };

  const sources = collectSources(__dirname);

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources.map((file) => [file]))(
    'keeps %s free of any price-table access',
    (file) => {
      const source = readFileSync(file, 'utf8');
      // Any Prisma delegate for a price model, read or write.
      expect(source).not.toMatch(
        /\.(priceBook|priceBookVersion|priceBookEntry)\s*\./,
      );
      // And any mutation verb spelled against one, however it is reached.
      expect(source).not.toMatch(
        /(priceBook|priceBookVersion|priceBookEntry)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)/i,
      );
    },
  );

  it('imports nothing from pricing but the read-only resolver and its types', () => {
    // `pricing.module` is the Nest wiring and is allowed in the module file
    // ALONE: importing the module is how the resolver is provided, and it
    // exports nothing that can change a price.
    const allowed = new Set([
      '../pricing/price-resolution.service',
      '../pricing/pricing.logic',
    ]);
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      if (file.endsWith('loyalty.module.ts')) {
        allowed.add('../pricing/pricing.module');
      } else {
        allowed.delete('../pricing/pricing.module');
      }
      const pricingImports = [...source.matchAll(/from\s+'(\.\.\/pricing\/[^']+)'/g)].map(
        (match) => match[1],
      );
      for (const imported of pricingImports) {
        expect(allowed.has(imported)).toBe(true);
      }
      // The repository and the activation hub are the two ways to CHANGE
      // pricing. Neither may be reachable from here.
      expect(source).not.toContain('pricing/pricing.repository');
      expect(source).not.toContain('pricing/pricing.service');
      expect(source).not.toContain('price-activation.hub');
    }
  });

  it('never lets a promotion reach the price/ESL write surfaces', () => {
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of [
        'PricingRepository',
        'PricingService',
        'PriceActivationHub',
        'EslService',
        'EslRepository',
      ]) {
        expect(source.includes(forbidden)).toBe(false);
      }
    }
  });
});
