import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PaymentProvider } from '@prisma/client';
import { SimulatedRefundGateway } from './simulated-refund.gateway';

const request = {
  refundId: 'rf-1',
  intentId: 'pi-1',
  provider: PaymentProvider.SIMULATED as string,
  amountMinor: 500,
  currencyCode: 'SAR',
  providerRef: 'prov-cap-1',
};

describe('SimulatedRefundGateway', () => {
  const gateway = new SimulatedRefundGateway();

  it('answers deterministically, so settlement can be replayed safely', async () => {
    const first = await gateway.execute(request);
    const second = await gateway.execute(request);
    expect(first).toEqual(second);
    expect(first.status).toBe('SUCCEEDED');
    expect(first.providerRefundRef).toBe('sim-refund-rf-1');
  });

  it('derives its reference only from our own identifier', async () => {
    const result = await gateway.execute({ ...request, amountMinor: 999 });
    // No amount, no customer, no instrument — an opaque reference only.
    expect(result.providerRefundRef).toBe('sim-refund-rf-1');
  });

  it('answers for the MANUAL provider too', async () => {
    const result = await gateway.execute({
      ...request,
      provider: PaymentProvider.MANUAL,
    });
    expect(result.status).toBe('SUCCEEDED');
  });

  it('fails rather than inventing a success for a provider it does not model', async () => {
    // A future gateway must not look refunded because the simulator said yes.
    const result = await gateway.execute({
      ...request,
      provider: 'SOME_FUTURE_GATEWAY',
    });
    expect(result.status).toBe('FAILED');
    expect(result.providerRefundRef).toBeUndefined();
  });
});

describe('the refund gateway is a port, not a vendor', () => {
  const portSource = readFileSync(
    join(__dirname, 'refund-gateway.port.ts'),
    'utf8',
  );
  const adapterSource = readFileSync(
    join(__dirname, 'simulated-refund.gateway.ts'),
    'utf8',
  );

  it('never carries card data across the boundary', () => {
    // A real adapter looks the instrument up on its own side by providerRef;
    // it is never handed one (AGENTS.md payments invariant).
    for (const forbidden of [
      'pan',
      'cardNumber',
      'cvv',
      'cvc',
      'track',
      'last4',
      'expiry',
    ]) {
      expect(portSource.toLowerCase()).not.toContain(
        `readonly ${forbidden.toLowerCase()}`,
      );
    }
  });

  it('imports no vendor SDK anywhere in the adapter', () => {
    const imports = [...adapterSource.matchAll(/from '([^']+)'/g)].map(
      (match) => match[1],
    );
    for (const specifier of imports) {
      expect(
        specifier.startsWith('.') ||
          specifier === '@nestjs/common' ||
          specifier === '@prisma/client',
      ).toBe(true);
    }
  });

  it('makes no network call of any kind', () => {
    for (const forbidden of ['fetch(', 'http', 'axios', 'request(']) {
      expect(adapterSource).not.toContain(forbidden);
    }
  });
});
