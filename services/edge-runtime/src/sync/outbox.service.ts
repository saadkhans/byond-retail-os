import { Inject, Injectable } from '@nestjs/common';
import { EdgeConfigService } from '../config/edge-config.service';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { CURSOR_IDS, COLLECTIONS, LOGS } from '../store/store-names';
import {
  CloudPushResult,
  ConflictRecord,
  OutboxEntry,
  OutboxOperation,
} from './sync.types';

interface OutboxCursor {
  readonly ackedThrough: number;
  readonly attempts: Record<string, number>;
}

const EMPTY_CURSOR: OutboxCursor = { ackedThrough: 0, attempts: {} };

/**
 * The outbox of locally-originated facts awaiting delivery.
 *
 * The log itself is append-only and is never truncated — not even on
 * overflow. "Dropping" an entry only ever means advancing the delivery cursor
 * past it and recording why; the fact stays on disk for an operator. Losing a
 * locally-observed fact silently is the one outcome this design refuses.
 *
 * Delivery is strictly in order, so the cursor is a single number. A head
 * entry the cloud will never accept would otherwise block the queue forever,
 * which is what the attempt budget and the dead-letter log exist to break.
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(EDGE_STORE) private readonly store: EdgeStorePort,
    private readonly config: EdgeConfigService,
  ) {}

  private async cursor(): Promise<OutboxCursor> {
    const stored = await this.store.get<OutboxCursor>(
      COLLECTIONS.cursors,
      CURSOR_IDS.outboxAckedThrough,
    );
    return stored ?? EMPTY_CURSOR;
  }

  private async saveCursor(cursor: OutboxCursor): Promise<void> {
    await this.store.put(
      COLLECTIONS.cursors,
      CURSOR_IDS.outboxAckedThrough,
      cursor,
    );
  }

  private async recordConflict(record: ConflictRecord): Promise<void> {
    await this.store.append(LOGS.conflicts, record);
  }

  /** Appends a fact and returns its sequence. */
  async enqueue(operation: OutboxOperation): Promise<number> {
    const sequence = await this.store.append(LOGS.outbox, operation);
    await this.enforceBound();
    return sequence;
  }

  /**
   * Keeps the UNDELIVERED backlog within its bound by skipping the oldest
   * entries, each one recorded as a conflict and dead-lettered first.
   */
  private async enforceBound(): Promise<void> {
    const max = this.config.outboxMaxEntries;
    const cursor = await this.cursor();
    const last = await this.store.lastSequence(LOGS.outbox);
    const pending = last - cursor.ackedThrough;
    if (pending <= max) {
      return;
    }
    const overflow = pending - max;
    const doomed = await this.store.read<OutboxOperation>(
      LOGS.outbox,
      cursor.ackedThrough,
      overflow,
    );
    for (const item of doomed) {
      await this.store.append(LOGS.deadletter, {
        ...item.entry,
        sequence: item.sequence,
        reasonCode: 'OUTBOX_OVERFLOW',
      });
      await this.recordConflict({
        kind: 'DELIVERY_BUDGET_EXHAUSTED',
        detectedAt: new Date().toISOString(),
        detail: {
          idempotencyKey: item.entry.idempotencyKey,
          sequence: item.sequence,
          reasonCode: 'OUTBOX_OVERFLOW',
        },
      });
    }
    const advanceTo =
      doomed.length === 0
        ? cursor.ackedThrough
        : doomed[doomed.length - 1].sequence;
    await this.saveCursor({ ...cursor, ackedThrough: advanceTo });
  }

  /** The next batch to deliver, oldest first. */
  async nextBatch(): Promise<OutboxEntry[]> {
    const cursor = await this.cursor();
    const page = await this.store.read<OutboxOperation>(
      LOGS.outbox,
      cursor.ackedThrough,
      this.config.syncBatchSize,
    );
    return page.map((item) => ({ ...item.entry, sequence: item.sequence }));
  }

  async pendingCount(): Promise<number> {
    const cursor = await this.cursor();
    const last = await this.store.lastSequence(LOGS.outbox);
    return Math.max(0, last - cursor.ackedThrough);
  }

  /** Attempts recorded against the current head entry, for backoff. */
  async headAttempts(): Promise<number> {
    const [cursor, batch] = await Promise.all([this.cursor(), this.nextBatch()]);
    if (batch.length === 0) {
      return 0;
    }
    return cursor.attempts[batch[0].idempotencyKey] ?? 0;
  }

  /**
   * Applies a push result. Walks the batch in order and advances the cursor
   * over every entry that is resolved — accepted, rejected, or out of
   * attempts — stopping at the first that is still undelivered.
   */
  async settle(
    batch: readonly OutboxEntry[],
    result: CloudPushResult,
  ): Promise<void> {
    const accepted = new Set(result.accepted);
    const rejected = new Map(
      result.rejected.map((item) => [item.idempotencyKey, item.reasonCode]),
    );
    const cursor = await this.cursor();
    const attempts = { ...cursor.attempts };
    let ackedThrough = cursor.ackedThrough;

    for (const entry of batch) {
      if (accepted.has(entry.idempotencyKey)) {
        delete attempts[entry.idempotencyKey];
        ackedThrough = entry.sequence;
        continue;
      }
      const reasonCode = rejected.get(entry.idempotencyKey);
      if (reasonCode !== undefined) {
        await this.store.append(LOGS.deadletter, { ...entry, reasonCode });
        await this.recordConflict({
          kind: 'CLOUD_REJECTED_FACT',
          detectedAt: new Date().toISOString(),
          detail: {
            idempotencyKey: entry.idempotencyKey,
            sequence: entry.sequence,
            reasonCode,
          },
        });
        delete attempts[entry.idempotencyKey];
        ackedThrough = entry.sequence;
        continue;
      }
      const seen = (attempts[entry.idempotencyKey] ?? 0) + 1;
      if (seen >= this.config.syncMaxAttempts) {
        await this.store.append(LOGS.deadletter, {
          ...entry,
          reasonCode: 'ATTEMPT_BUDGET_EXHAUSTED',
        });
        await this.recordConflict({
          kind: 'DELIVERY_BUDGET_EXHAUSTED',
          detectedAt: new Date().toISOString(),
          detail: {
            idempotencyKey: entry.idempotencyKey,
            sequence: entry.sequence,
            attempts: seen,
          },
        });
        delete attempts[entry.idempotencyKey];
        ackedThrough = entry.sequence;
        continue;
      }
      attempts[entry.idempotencyKey] = seen;
      break;
    }

    await this.saveCursor({ ackedThrough, attempts });
  }

  /** Records a failed delivery attempt against the head entry. */
  async recordDeliveryFailure(batch: readonly OutboxEntry[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    await this.settle(batch, { accepted: [], rejected: [] });
  }
}
