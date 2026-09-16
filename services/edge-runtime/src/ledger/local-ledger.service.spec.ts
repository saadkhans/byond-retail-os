import { temporaryStore } from '../../test/helpers';
import { LOGS } from '../store/store-names';
import { LocalLedgerService } from './local-ledger.service';
import { EdgeLedgerEntry, projectStock, stockKey } from './ledger.types';

function movement(
  overrides: Partial<EdgeLedgerEntry> = {},
): EdgeLedgerEntry {
  return {
    movementId: `m-${Math.random().toString(36).slice(2)}`,
    type: 'SALE',
    productId: 'sku-water',
    unitId: 'unit-1',
    quantityDelta: -1,
    occurredAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('LocalLedgerService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let ledger: LocalLedgerService;

  beforeEach(async () => {
    context = await temporaryStore();
    ledger = new LocalLedgerService(context.store);
    await ledger.rebuild();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('derives stock from movements rather than storing a number', async () => {
    await ledger.record(movement({ type: 'RECEIPT', quantityDelta: 10 }));
    await ledger.record(movement({ quantityDelta: -3 }));
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(7);
  });

  it('keeps units separate', async () => {
    await ledger.record(movement({ type: 'RECEIPT', quantityDelta: 5 }));
    await ledger.record(
      movement({ type: 'RECEIPT', quantityDelta: 2, unitId: 'unit-2' }),
    );
    await expect(ledger.stockFor('sku-water', 'unit-1')).resolves.toBe(5);
    await expect(ledger.stockFor('sku-water', 'unit-2')).resolves.toBe(2);
  });

  it('reports zero for a product it has never seen', async () => {
    await expect(ledger.stockFor('sku-unknown', 'unit-1')).resolves.toBe(0);
  });

  it('refuses a zero or fractional movement', async () => {
    await expect(ledger.record(movement({ quantityDelta: 0 }))).rejects.toThrow(
      /non-zero integer/,
    );
    await expect(
      ledger.record(movement({ quantityDelta: 1.5 })),
    ).rejects.toThrow(/non-zero integer/);
  });

  it('matches a full replay of the log — the cache never drifts', async () => {
    for (let index = 0; index < 20; index += 1) {
      await ledger.record(
        movement({
          type: index % 3 === 0 ? 'RECEIPT' : 'SALE',
          quantityDelta: index % 3 === 0 ? 4 : -1,
          productId: index % 2 === 0 ? 'sku-water' : 'sku-coffee',
        }),
      );
    }
    const cached = new Map(
      (await ledger.levelsSnapshot()).map((level) => [
        stockKey(level.productId, level.unitId),
        level.quantity,
      ]),
    );
    const replayed = new Map(
      [...(await ledger.replayAll()).values()].map((level) => [
        stockKey(level.productId, level.unitId),
        level.quantity,
      ]),
    );
    expect(cached).toEqual(replayed);
  });

  it('rebuilds the projection from disk after a restart', async () => {
    await ledger.record(movement({ type: 'RECEIPT', quantityDelta: 6 }));
    const restarted = new LocalLedgerService(context.store);
    await restarted.rebuild();
    await expect(restarted.stockFor('sku-water', 'unit-1')).resolves.toBe(6);
  });

  it('appends to the ledger log and never rewrites an entry', async () => {
    await ledger.record(movement({ type: 'RECEIPT', quantityDelta: 2 }));
    await ledger.record(movement({ quantityDelta: -1 }));
    const entries = await context.store.read<EdgeLedgerEntry>(LOGS.ledger, 0, 10);
    expect(entries.map((item) => item.sequence)).toEqual([1, 2]);
    expect(entries[0].entry.quantityDelta).toBe(2);
  });
});

describe('projectStock', () => {
  it('is a pure fold over the entries', () => {
    const levels = projectStock([
      { sequence: 1, entry: { ...movement({ type: 'RECEIPT', quantityDelta: 5 }) } },
      { sequence: 2, entry: { ...movement({ quantityDelta: -2 }) } },
    ]);
    expect(levels.get(stockKey('sku-water', 'unit-1'))).toEqual({
      productId: 'sku-water',
      unitId: 'unit-1',
      quantity: 3,
      throughSequence: 2,
    });
  });
});
