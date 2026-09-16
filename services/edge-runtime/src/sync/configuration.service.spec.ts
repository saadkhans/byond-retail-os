import { sealedIdentity, temporaryStore } from '../../test/helpers';
import { LOGS } from '../store/store-names';
import { ConfigurationService } from './configuration.service';
import { InboxEntry } from './sync.types';

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    resourceType: 'PRODUCT',
    resourceId: 'sku-water',
    version: 1,
    payload: { name: 'Water 500ml' },
    ...overrides,
  };
}

describe('ConfigurationService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let configuration: ConfigurationService;

  beforeEach(async () => {
    context = await temporaryStore();
    configuration = new ConfigurationService(
      context.store,
      await sealedIdentity(context.store),
    );
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('applies a cloud entry and records the version reached', async () => {
    await expect(configuration.apply([entry()])).resolves.toBe(1);
    await expect(configuration.get('PRODUCT', 'sku-water')).resolves.toMatchObject(
      { version: 1, payload: { name: 'Water 500ml' } },
    );
    await expect(configuration.appliedVersion()).resolves.toBe(1);
  });

  it('lets the cloud overwrite local state — configuration is cloud-owned', async () => {
    await configuration.apply([entry()]);
    await configuration.apply([
      entry({ version: 2, payload: { name: 'Water 750ml' } }),
    ]);
    await expect(configuration.get('PRODUCT', 'sku-water')).resolves.toMatchObject(
      { version: 2, payload: { name: 'Water 750ml' } },
    );
  });

  it('ignores a stale version and surfaces it as a conflict', async () => {
    await configuration.apply([entry({ version: 5 })]);
    await expect(
      configuration.apply([entry({ version: 3, payload: { name: 'Old' } })]),
    ).resolves.toBe(0);
    await expect(configuration.get('PRODUCT', 'sku-water')).resolves.toMatchObject(
      { version: 5 },
    );
    const conflicts = await context.store.read<{ kind: string }>(
      LOGS.conflicts,
      0,
      10,
    );
    expect(conflicts[0].entry.kind).toBe('STALE_CONFIGURATION');
  });

  it('is idempotent: replaying the same batch changes nothing', async () => {
    const batch = [entry(), entry({ resourceId: 'sku-coffee', version: 2 })];
    await expect(configuration.apply(batch)).resolves.toBe(2);
    await expect(configuration.apply(batch)).resolves.toBe(0);
    await expect(configuration.all()).resolves.toHaveLength(2);
  });

  it('applies out-of-order entries oldest version first', async () => {
    await configuration.apply([
      entry({ version: 3, payload: { name: 'third' } }),
      entry({ version: 2, payload: { name: 'second' } }),
    ]);
    await expect(configuration.get('PRODUCT', 'sku-water')).resolves.toMatchObject(
      { version: 3, payload: { name: 'third' } },
    );
  });

  it('retires a resource the cloud marks deleted', async () => {
    await configuration.apply([entry()]);
    await configuration.apply([entry({ version: 2, deleted: true })]);
    await expect(configuration.get('PRODUCT', 'sku-water')).resolves.toBeNull();
  });

  it('keeps every received entry in the append-only inbox log', async () => {
    await configuration.apply([entry(), entry({ version: 2 })]);
    await expect(context.store.count(LOGS.inbox)).resolves.toBe(2);
  });

  it('never applies configuration addressed to another tenant', async () => {
    await expect(
      configuration.apply([entry({ tenantId: 'tenant-other' })]),
    ).resolves.toBe(0);
    await expect(configuration.get('PRODUCT', 'sku-water')).resolves.toBeNull();
    const conflicts = await context.store.read<{
      kind: string;
      detail: Record<string, unknown>;
    }>(LOGS.conflicts, 0, 10);
    expect(conflicts[0].entry.kind).toBe('FOREIGN_TENANT_CONFIGURATION');
    // The other tenant's id is not disclosed in this node's own conflict log.
    expect(JSON.stringify(conflicts[0].entry.detail)).not.toContain(
      'tenant-other',
    );
  });

  it('applies configuration that names this node as its tenant', async () => {
    await expect(
      configuration.apply([entry({ tenantId: 'tenant-test' })]),
    ).resolves.toBe(1);
    await expect(
      configuration.get('PRODUCT', 'sku-water'),
    ).resolves.not.toBeNull();
  });

  it('advances past a foreign entry so it is never re-pulled forever', async () => {
    await configuration.apply([entry({ version: 7, tenantId: 'tenant-other' })]);
    await expect(configuration.appliedVersion()).resolves.toBe(7);
  });

  it('leaves a receipt for a foreign entry, never the other tenant’s data', async () => {
    await configuration.apply([
      entry({ tenantId: 'tenant-other', payload: { name: 'Their Secret SKU' } }),
    ]);
    await expect(configuration.all()).resolves.toHaveLength(0);
    // An operator still learns that something misrouted arrived...
    const inbox = await context.store.read<Record<string, unknown>>(
      LOGS.inbox,
      0,
      10,
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0].entry).toEqual({
      resourceType: 'PRODUCT',
      resourceId: 'sku-water',
      version: 1,
      rejected: 'FOREIGN_TENANT',
    });
    // ...but the other tenant's payload and id never land on this node's disk.
    const written = JSON.stringify(inbox);
    expect(written).not.toContain('Their Secret SKU');
    expect(written).not.toContain('tenant-other');
  });

  it('keeps every entry it was entitled to receive in the inbox log', async () => {
    await configuration.apply([entry({ tenantId: 'tenant-test' })]);
    const inbox = await context.store.read<Record<string, unknown>>(
      LOGS.inbox,
      0,
      10,
    );
    expect(inbox[0].entry).toMatchObject({ payload: { name: 'Water 500ml' } });
  });

  it('keeps resource types in separate namespaces', async () => {
    await configuration.apply([
      entry({ resourceType: 'PRODUCT', resourceId: 'x', version: 1 }),
      entry({ resourceType: 'UNIT', resourceId: 'x', version: 2 }),
    ]);
    await expect(configuration.get('PRODUCT', 'x')).resolves.not.toBeNull();
    await expect(configuration.get('UNIT', 'x')).resolves.not.toBeNull();
    await expect(configuration.all()).resolves.toHaveLength(2);
  });
});
