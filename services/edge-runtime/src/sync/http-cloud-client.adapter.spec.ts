import { normaliseInbox, normalisePushResult } from './http-cloud-client.adapter';
import { OutboxEntry } from './sync.types';

const BATCH: OutboxEntry[] = [
  {
    sequence: 1,
    type: 'INVENTORY_MOVEMENT',
    idempotencyKey: 'a',
    occurredAt: '2026-09-16T10:00:00.000Z',
    payload: {},
  },
  {
    sequence: 2,
    type: 'INVENTORY_MOVEMENT',
    idempotencyKey: 'b',
    occurredAt: '2026-09-16T10:00:00.000Z',
    payload: {},
  },
];

describe('normalisePushResult', () => {
  it('reads a well-formed answer', () => {
    expect(
      normalisePushResult(
        { accepted: ['a'], rejected: [{ idempotencyKey: 'b', reasonCode: 'X' }] },
        BATCH,
      ),
    ).toEqual({
      accepted: ['a'],
      rejected: [{ idempotencyKey: 'b', reasonCode: 'X' }],
    });
  });

  it('accepts nothing when the body is unreadable, so no fact is lost', () => {
    for (const body of [null, undefined, 'nonsense', {}, { accepted: 'a' }]) {
      expect(normalisePushResult(body, BATCH).accepted).toEqual([]);
    }
  });

  it('ignores keys that were never in the batch', () => {
    expect(
      normalisePushResult({ accepted: ['a', 'not-ours'] }, BATCH).accepted,
    ).toEqual(['a']);
  });

  it('defaults a missing reason code rather than dropping the rejection', () => {
    expect(
      normalisePushResult({ rejected: [{ idempotencyKey: 'a' }] }, BATCH)
        .rejected,
    ).toEqual([{ idempotencyKey: 'a', reasonCode: 'UNSPECIFIED' }]);
  });
});

describe('normaliseInbox', () => {
  it('keeps well-formed entries and drops malformed ones', () => {
    const entries = normaliseInbox({
      entries: [
        {
          resourceType: 'PRODUCT',
          resourceId: 'sku-1',
          version: 2,
          payload: { name: 'Water' },
        },
        { resourceType: 'PRODUCT', resourceId: 'sku-2' },
        { resourceType: 'UNIT', resourceId: 'u', version: 'three', payload: {} },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resourceId: 'sku-1', version: 2 });
  });

  it('carries the deleted flag through when set', () => {
    const [entry] = normaliseInbox({
      entries: [
        {
          resourceType: 'PRODUCT',
          resourceId: 'sku-1',
          version: 3,
          payload: {},
          deleted: true,
        },
      ],
    });
    expect(entry.deleted).toBe(true);
  });

  it('carries a declared tenant through so the node can refuse a foreign one', () => {
    const [entry] = normaliseInbox({
      entries: [
        {
          resourceType: 'PRODUCT',
          resourceId: 'sku-1',
          version: 3,
          payload: {},
          tenantId: 'tenant-a',
        },
      ],
    });
    expect(entry.tenantId).toBe('tenant-a');
  });

  it('treats an absent or unusable tenant as unstated rather than empty', () => {
    const entries = normaliseInbox({
      entries: [
        { resourceType: 'PRODUCT', resourceId: 'a', version: 1, payload: {} },
        {
          resourceType: 'PRODUCT',
          resourceId: 'b',
          version: 2,
          payload: {},
          tenantId: '',
        },
        {
          resourceType: 'PRODUCT',
          resourceId: 'c',
          version: 3,
          payload: {},
          tenantId: 42,
        },
      ],
    });
    expect(entries.map((entry) => entry.tenantId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('returns nothing for an unreadable body', () => {
    expect(normaliseInbox(null)).toEqual([]);
    expect(normaliseInbox({ entries: 'nope' })).toEqual([]);
  });
});
