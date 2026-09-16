import { SupplierOrderRequest } from '../supplier-integration.port';
import { SimulatedSupplierAdapter } from './simulated-supplier.adapter';

const request = (
  overrides: Partial<SupplierOrderRequest> = {},
): SupplierOrderRequest => ({
  reference: 'PO-2026-0001',
  supplierCode: 'ACME',
  supplierName: 'Acme Trading',
  destinationCode: 'STORE-01',
  destinationName: 'Downtown',
  expectedAt: null,
  currencyCode: 'AED',
  totalCostMinor: 3297,
  lines: [
    {
      supplierSku: 'ACME-WTR-12',
      sku: 'WATER-BOTTLE-500ML',
      productName: 'Drinking Water 500ml',
      quantity: 3,
      packSize: 12,
      unitCostMinor: 1099,
      currencyCode: 'AED',
    },
  ],
  ...overrides,
});

describe('SimulatedSupplierAdapter', () => {
  const adapter = new SimulatedSupplierAdapter();

  it('identifies itself, so audit entries name the provider', () => {
    expect(adapter.providerCode).toBe('SIMULATED');
  });

  it('acknowledges a well-formed order', async () => {
    const result = await adapter.submitOrder(request());
    expect(result.status).toBe('ACCEPTED');
  });

  it('returns the same acknowledgement for the same order reference', async () => {
    const first = await adapter.submitOrder(request());
    const second = await adapter.submitOrder(request());
    expect(first.status).toBe('ACCEPTED');
    expect(second.status).toBe('ACCEPTED');
    if (first.status === 'ACCEPTED' && second.status === 'ACCEPTED') {
      expect(second.externalReference).toBe(first.externalReference);
    }
  });

  it('gives different orders different acknowledgements', async () => {
    const first = await adapter.submitOrder(request());
    const second = await adapter.submitOrder(
      request({ reference: 'PO-2026-0002' }),
    );
    if (first.status === 'ACCEPTED' && second.status === 'ACCEPTED') {
      expect(second.externalReference).not.toBe(first.externalReference);
    }
  });

  it('returns an acknowledgement that carries no URL or credential', async () => {
    const result = await adapter.submitOrder(request());
    if (result.status === 'ACCEPTED') {
      expect(result.externalReference).toMatch(/^SIM-[0-9A-F]{16}$/);
    }
  });

  it('rejects an order with no lines as a value, not an exception', async () => {
    const result = await adapter.submitOrder(request({ lines: [] }));
    expect(result).toEqual({ status: 'REJECTED', failure: 'INVALID_ORDER' });
  });

  it('rejects a line with no quantity', async () => {
    const result = await adapter.submitOrder(
      request({
        lines: [
          {
            supplierSku: 'ACME-WTR-12',
            sku: 'WATER-BOTTLE-500ML',
            productName: 'Drinking Water 500ml',
            quantity: 0,
            packSize: 12,
            unitCostMinor: 1099,
            currencyCode: 'AED',
          },
        ],
      }),
    );
    expect(result).toEqual({ status: 'REJECTED', failure: 'INVALID_ORDER' });
  });
});
