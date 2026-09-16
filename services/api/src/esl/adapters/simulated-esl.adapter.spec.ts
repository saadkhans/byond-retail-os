import { EslUpdateErrorCode } from '@prisma/client';
import { SIMULATED_VENDOR_CODE } from '../esl.constants';
import { EslGatewayContext, EslLabelContent } from '../ports';
import { EslVendorRegistry } from './esl-vendor.registry';
import { SimulatedEslAdapter } from './simulated-esl.adapter';

const ctx: EslGatewayContext = {
  gatewayCode: 'STORE-01',
  vendorCode: SIMULATED_VENDOR_CODE,
  credentialRef: 'STORE_01_KEY',
  metadata: null,
};

const content: EslLabelContent = {
  sku: 'WATER-500',
  productName: 'Drinking Water 500ml',
  unitPriceMinor: 250,
  currencyCode: 'AED',
};

describe('simulated ESL adapter', () => {
  const adapter = new SimulatedEslAdapter();

  it('reports labels derived from the gateway code', async () => {
    const labels = await adapter.discoverLabels(ctx);
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label.vendorLabelId.startsWith('STORE-01-SIM-')).toBe(true);
    }
  });

  it('does not collide between two gateways in one tenant', async () => {
    const other = await adapter.discoverLabels({ ...ctx, gatewayCode: 'S2' });
    const first = await adapter.discoverLabels(ctx);
    const ids = new Set([
      ...other.map((label) => label.vendorLabelId),
      ...first.map((label) => label.vendorLabelId),
    ]);
    expect(ids.size).toBe(6);
  });

  it('reports stable health, so a label never looks like it is flapping', async () => {
    const first = await adapter.readHealth(ctx, 'STORE-01-SIM-1');
    const second = await adapter.readHealth(ctx, 'STORE-01-SIM-1');
    expect(first).toEqual(second);
    expect(first?.batteryPercent).toBeGreaterThanOrEqual(40);
    expect(first?.batteryPercent).toBeLessThanOrEqual(100);
  });

  it('pushes to every label it was given', async () => {
    const outcomes = await adapter.pushBatch(ctx, [
      { vendorLabelId: 'A', content },
      { vendorLabelId: 'B', content },
    ]);
    expect(outcomes.map((o) => o.vendorLabelId)).toEqual(['A', 'B']);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it.each([
    ['LBL-UNREACHABLE', EslUpdateErrorCode.LABEL_UNREACHABLE],
    ['LBL-REJECT', EslUpdateErrorCode.VENDOR_REJECTED],
    ['LBL-TIMEOUT', EslUpdateErrorCode.VENDOR_TIMEOUT],
  ])('fails %s deterministically', async (vendorLabelId, expected) => {
    const [outcome] = await adapter.pushBatch(ctx, [
      { vendorLabelId, content },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe(expected);
    }
  });

  it('fails one label of a batch without touching the others', async () => {
    const outcomes = await adapter.pushBatch(ctx, [
      { vendorLabelId: 'GOOD-1', content },
      { vendorLabelId: 'BAD-REJECT', content },
      { vendorLabelId: 'GOOD-2', content },
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
  });

  it('never returns the credential it was handed', async () => {
    const outcomes = await adapter.pushBatch(ctx, [
      { vendorLabelId: 'LBL-REJECT', content },
    ]);
    expect(JSON.stringify(outcomes)).not.toContain('STORE_01_KEY');
  });
});

describe('ESL vendor registry', () => {
  const registry = new EslVendorRegistry(new SimulatedEslAdapter());

  it('always offers the simulated adapter', () => {
    expect(registry.vendorCodes()).toContain(SIMULATED_VENDOR_CODE);
    expect(registry.resolve(SIMULATED_VENDOR_CODE)).not.toBeNull();
  });

  it('resolves case-insensitively', () => {
    expect(registry.resolve('simulated')).not.toBeNull();
    expect(registry.resolve(' Simulated ')).not.toBeNull();
  });

  it('returns null for an unknown vendor rather than throwing', () => {
    // One misconfigured gateway must never take a processing pass down.
    expect(registry.resolve('ACME')).toBeNull();
  });
});
