import { Inject, Injectable } from '@nestjs/common';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { LOGS } from '../store/store-names';
import {
  EdgeLedgerEntry,
  StockLevel,
  projectStock,
  stockKey,
} from './ledger.types';

const REPLAY_PAGE = 500;

/**
 * Append-only local ledger with an in-memory projection.
 *
 * The projection is a cache and nothing more: `rebuild()` recomputes it from
 * the log, and the service exposes `replayAll()` so a test can prove the cache
 * equals a full replay. There is no code path that sets a quantity.
 */
@Injectable()
export class LocalLedgerService {
  private levels = new Map<string, StockLevel>();
  private projectedThrough = 0;

  constructor(@Inject(EDGE_STORE) private readonly store: EdgeStorePort) {}

  /** Recomputes the projection from the first entry. */
  async rebuild(): Promise<void> {
    this.levels = new Map();
    this.projectedThrough = 0;
    await this.catchUp();
  }

  private async catchUp(): Promise<void> {
    for (;;) {
      const page = await this.store.read<EdgeLedgerEntry>(
        LOGS.ledger,
        this.projectedThrough,
        REPLAY_PAGE,
      );
      if (page.length === 0) {
        return;
      }
      this.levels = projectStock(page, this.levels);
      this.projectedThrough = page[page.length - 1].sequence;
    }
  }

  /** Appends a movement and advances the projection. Returns its sequence. */
  async record(entry: EdgeLedgerEntry): Promise<number> {
    if (!Number.isInteger(entry.quantityDelta) || entry.quantityDelta === 0) {
      throw new Error('Ledger movement requires a non-zero integer delta');
    }
    const sequence = await this.store.append(LOGS.ledger, entry);
    await this.catchUp();
    return sequence;
  }

  async stockFor(productId: string, unitId: string): Promise<number> {
    await this.catchUp();
    return this.levels.get(stockKey(productId, unitId))?.quantity ?? 0;
  }

  async levelsSnapshot(): Promise<ReadonlyArray<StockLevel>> {
    await this.catchUp();
    return [...this.levels.values()].sort((left, right) =>
      stockKey(left.productId, left.unitId).localeCompare(
        stockKey(right.productId, right.unitId),
      ),
    );
  }

  /** Full replay from the log, independent of the cache. */
  async replayAll(): Promise<Map<string, StockLevel>> {
    let levels = new Map<string, StockLevel>();
    let after = 0;
    for (;;) {
      const page = await this.store.read<EdgeLedgerEntry>(
        LOGS.ledger,
        after,
        REPLAY_PAGE,
      );
      if (page.length === 0) {
        return levels;
      }
      levels = projectStock(page, levels);
      after = page[page.length - 1].sequence;
    }
  }
}
