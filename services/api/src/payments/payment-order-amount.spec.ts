import { PrismaService } from '../prisma/prisma.service';
import { PaymentsRepository } from './payments.repository';

/**
 * Phase 25: a priced order is the authority on what may be charged.
 *
 * Before pricing existed, `amountMinor` was whatever the caller sent and
 * nothing could contradict it. Now an order that states a total vetoes an
 * intent for a different figure — while an order with no total (a tenant
 * without price books, or an order created before this phase) keeps the old
 * behaviour exactly.
 */
describe('payment intent amount vs order total', () => {
  function buildRepository(order: Record<string, unknown> | null) {
    const tx = {
      paymentIntent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'intent-1', ...data }),
          ),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'intent-1' }),
      },
      order: { findFirst: jest.fn().mockResolvedValue(order) },
      checkoutSession: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService;
    const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
    return {
      tx,
      repository: new PaymentsRepository(prisma, auditLog as never),
    };
  }

  const intentInput = (amountMinor: number, currencyCode = 'AED') => ({
    orderId: 'order-1',
    provider: 'SIMULATED' as const,
    amountMinor,
    currencyCode,
  });

  it('rejects an intent for less than the order total', async () => {
    const { repository, tx } = buildRepository({
      id: 'order-1',
      checkoutSessionId: 'sess-1',
      totalMinor: 2250,
      currencyCode: 'AED',
    });

    const result = await repository.createIntent(
      'tenant-a',
      intentInput(1) as never,
      () => ({}) as never,
    );

    expect(result).toBe('order-amount-mismatch');
    expect(tx.paymentIntent.create).not.toHaveBeenCalled();
  });

  it('rejects an intent in a different currency', async () => {
    const { repository } = buildRepository({
      id: 'order-1',
      checkoutSessionId: 'sess-1',
      totalMinor: 2250,
      currencyCode: 'AED',
    });

    const result = await repository.createIntent(
      'tenant-a',
      intentInput(2250, 'SAR') as never,
      () => ({}) as never,
    );

    expect(result).toBe('order-amount-mismatch');
  });

  it('accepts an intent that matches the order total exactly', async () => {
    const { repository, tx } = buildRepository({
      id: 'order-1',
      checkoutSessionId: 'sess-1',
      totalMinor: 2250,
      currencyCode: 'AED',
    });

    await repository.createIntent(
      'tenant-a',
      intentInput(2250) as never,
      () => ({}) as never,
    );

    expect(tx.paymentIntent.create).toHaveBeenCalled();
  });

  it('leaves an order with no total to the caller-supplied amount', async () => {
    const { repository, tx } = buildRepository({
      id: 'order-1',
      checkoutSessionId: 'sess-1',
      totalMinor: null,
      currencyCode: null,
    });

    await repository.createIntent(
      'tenant-a',
      intentInput(999) as never,
      () => ({}) as never,
    );

    expect(tx.paymentIntent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amountMinor: 999 }),
      }),
    );
  });

  it('does not constrain an intent with no linked order', async () => {
    const { repository, tx } = buildRepository(null);

    await repository.createIntent(
      'tenant-a',
      {
        provider: 'SIMULATED',
        amountMinor: 500,
        currencyCode: 'AED',
      } as never,
      () => ({}) as never,
    );

    expect(tx.paymentIntent.create).toHaveBeenCalled();
  });
});
