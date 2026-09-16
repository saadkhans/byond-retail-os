import {
  OrderPaymentStatus,
  OrderStatus,
  PaymentRefundStatus,
  PaymentStatus,
} from '@prisma/client';
import { PaymentsRepository } from './payments.repository';

/**
 * The two properties a refund path must never lose: it can only ever return
 * money that was actually taken, and a replayed request must not move money
 * twice. Both are decided in the repository, under the intent advisory lock,
 * so both are pinned here.
 */

const CAPTURED_INTENT = {
  id: 'pi-1',
  tenantId: 'tenant-a',
  orderId: 'order-1',
  checkoutSessionId: null,
  status: PaymentStatus.CAPTURED,
  provider: 'SIMULATED',
  amountMinor: 1500,
  capturedAmountMinor: 1500,
  refundedAmountMinor: 0,
  currencyCode: 'SAR',
};

const ORDER = {
  id: 'order-1',
  tenantId: 'tenant-a',
  status: OrderStatus.CONFIRMED,
  paymentStatus: OrderPaymentStatus.PAID,
  paidAt: new Date('2026-09-16T10:00:00.000Z'),
  checkoutSessionId: 'cs-1',
};

function buildHarness(
  options: {
    intent?: Record<string, unknown> | null;
    existingRefundByKey?: Record<string, unknown> | null;
    claimedSum?: number | null;
    succeededSum?: number | null;
    pendingCount?: number;
    refundRow?: Record<string, unknown> | null;
    flipCount?: number;
    orderPaymentStatus?: OrderPaymentStatus;
  } = {},
) {
  const refundRow = options.refundRow ?? {
    id: 'rf-1',
    tenantId: 'tenant-a',
    intentId: 'pi-1',
    status: PaymentRefundStatus.PENDING,
    amountMinor: 500,
    currencyCode: 'SAR',
  };
  const order = {
    ...ORDER,
    paymentStatus: options.orderPaymentStatus ?? OrderPaymentStatus.PAID,
  };
  const tx = {
    $queryRaw: jest.fn(async () => []),
    paymentIntent: {
      findFirst: jest.fn(async () =>
        options.intent === undefined ? CAPTURED_INTENT : options.intent,
      ),
      findFirstOrThrow: jest.fn(async () =>
        options.intent === undefined ? CAPTURED_INTENT : options.intent,
      ),
      update: jest.fn(async () => CAPTURED_INTENT),
    },
    paymentRefund: {
      // openRefund looks a refund up BY IDEMPOTENCY KEY; settleRefund looks
      // one up BY ID. One mock, dispatched on the predicate, so each path
      // sees the row it is actually asking for.
      findFirst: jest.fn(
        async (args: { where: { id?: string; idempotencyKey?: string } }) =>
          args.where.idempotencyKey !== undefined
            ? (options.existingRefundByKey ?? null)
            : refundRow,
      ),
      findFirstOrThrow: jest.fn(async () => ({
        ...refundRow,
        status: PaymentRefundStatus.SUCCEEDED,
      })),
      // openRefund sums PENDING + SUCCEEDED (the ceiling); settleRefund sums
      // SUCCEEDED only (the settled total). Dispatched on the predicate so
      // neither can accidentally read the other's figure.
      aggregate: jest.fn(
        async (args: { where: { status: unknown } }) => ({
          _sum: {
            amountMinor: Array.isArray(
              (args.where.status as { in?: unknown[] }).in,
            )
              ? (options.claimedSum ?? 0)
              : (options.succeededSum ?? 500),
          },
        }),
      ),
      count: jest.fn(async () => options.pendingCount ?? 0),
      create: jest.fn(async () => refundRow),
      updateMany: jest.fn(async () => ({ count: options.flipCount ?? 1 })),
    },
    paymentCapture: {
      findFirst: jest.fn(async () => ({
        id: 'cap-1',
        providerRef: 'prov-cap-1',
      })),
    },
    user: { findFirst: jest.fn(async () => ({ id: 'user-1' })) },
    order: {
      findFirst: jest.fn(async () => order),
      findFirstOrThrow: jest.fn(async () => order),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
    paymentRefund: { findFirst: jest.fn(async () => refundRow) },
    paymentIntent: { findFirst: jest.fn(async () => CAPTURED_INTENT) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const repository = new PaymentsRepository(prisma as never, audit as never);
  return { repository, tx, audit };
}

const openBuilders = {
  refundOpened: () => ({}) as never,
  orderUpdated: () => ({}) as never,
};
const settleBuilders = {
  refundSettled: () => ({}) as never,
  orderUpdated: () => ({}) as never,
};

describe('PaymentsRepository.openRefund — the ceiling', () => {
  it('opens a PENDING refund against the capture before any money is asked for', async () => {
    const { repository, tx } = buildHarness();
    const result = await repository.openRefund(
      'tenant-a',
      'pi-1',
      { amountMinor: 500, idempotencyKey: 'key-1' },
      openBuilders,
    );
    expect(result).toMatchObject({ replayed: false });
    expect(tx.paymentRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          intentId: 'pi-1',
          captureId: 'cap-1',
          status: PaymentRefundStatus.PENDING,
          amountMinor: 500,
          currencyCode: 'SAR',
        }),
      }),
    );
  });

  it('refuses to return more than the intent captured', async () => {
    const { repository, tx } = buildHarness();
    expect(
      await repository.openRefund(
        'tenant-a',
        'pi-1',
        { amountMinor: 1501 },
        openBuilders,
      ),
    ).toBe('refund-exceeds-capture');
    expect(tx.paymentRefund.create).not.toHaveBeenCalled();
  });

  it('counts refunds already in flight against the ceiling', async () => {
    // 1200 already claimed (PENDING + SUCCEEDED) leaves 300. Money that is
    // mid-flight is not available to be refunded a second time.
    const { repository, tx } = buildHarness({ claimedSum: 1200 });
    expect(
      await repository.openRefund(
        'tenant-a',
        'pi-1',
        { amountMinor: 301 },
        openBuilders,
      ),
    ).toBe('refund-exceeds-capture');
    expect(tx.paymentRefund.create).not.toHaveBeenCalled();
    expect(tx.paymentRefund.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED],
          },
        }),
      }),
    );
  });

  it.each([
    [PaymentStatus.AUTHORIZED],
    [PaymentStatus.CANCELLED],
    [PaymentStatus.FAILED],
    [PaymentStatus.VOIDED],
    [PaymentStatus.EXPIRED],
  ])('refuses to refund an intent in state %s', async (status) => {
    // CAPTURED is terminal too — and is the ONLY terminal state a refund is
    // legal from. Every other one means no money was ever taken.
    const { repository, tx } = buildHarness({
      intent: { ...CAPTURED_INTENT, status },
    });
    expect(
      await repository.openRefund(
        'tenant-a',
        'pi-1',
        { amountMinor: 100 },
        openBuilders,
      ),
    ).toBe('intent-not-captured');
    expect(tx.paymentRefund.create).not.toHaveBeenCalled();
  });

  it('refuses a captured intent that somehow captured nothing', async () => {
    const { repository } = buildHarness({
      intent: { ...CAPTURED_INTENT, capturedAmountMinor: 0 },
    });
    expect(
      await repository.openRefund(
        'tenant-a',
        'pi-1',
        { amountMinor: 100 },
        openBuilders,
      ),
    ).toBe('intent-not-captured');
  });

  it.each([[0], [-5], [1.5]])('refuses an amount of %p', async (amountMinor) => {
    const { repository } = buildHarness();
    expect(
      await repository.openRefund(
        'tenant-a',
        'pi-1',
        { amountMinor },
        openBuilders,
      ),
    ).toBe('refund-amount-invalid');
  });

  it('replays the original refund for a repeated idempotency key', async () => {
    const { repository, tx } = buildHarness({
      existingRefundByKey: {
        id: 'rf-1',
        intentId: 'pi-1',
        status: PaymentRefundStatus.SUCCEEDED,
      },
    });
    const result = await repository.openRefund(
      'tenant-a',
      'pi-1',
      { amountMinor: 500, idempotencyKey: 'key-1' },
      openBuilders,
    );
    expect(result).toMatchObject({ replayed: true });
    expect(tx.paymentRefund.create).not.toHaveBeenCalled();
  });

  it('refuses a key already used against a different intent', async () => {
    const { repository, tx } = buildHarness({
      existingRefundByKey: { id: 'rf-9', intentId: 'pi-other' },
    });
    expect(
      await repository.openRefund(
        'tenant-a',
        'pi-1',
        { amountMinor: 500, idempotencyKey: 'key-1' },
        openBuilders,
      ),
    ).toBe('idempotency-key-conflict');
    expect(tx.paymentRefund.create).not.toHaveBeenCalled();
  });

  it('scopes the intent lookup to the caller’s tenant', async () => {
    const { repository, tx } = buildHarness({ intent: null });
    expect(
      await repository.openRefund(
        'tenant-b',
        'pi-1',
        { amountMinor: 100 },
        openBuilders,
      ),
    ).toBeNull();
    expect(tx.paymentIntent.findFirst).toHaveBeenCalledWith({
      where: { id: 'pi-1', tenantId: 'tenant-b' },
    });
  });

  it('moves a PAID order to REFUND_PENDING, never an unpaid one', async () => {
    const { repository, tx } = buildHarness();
    await repository.openRefund(
      'tenant-a',
      'pi-1',
      { amountMinor: 500 },
      openBuilders,
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        tenantId: 'tenant-a',
        // A refund can never invent a payment: only an order that actually
        // took money may enter a refund state.
        paymentStatus: {
          in: [
            OrderPaymentStatus.PAID,
            OrderPaymentStatus.REFUND_PENDING,
            OrderPaymentStatus.REFUNDED,
          ],
        },
      },
      data: { paymentStatus: OrderPaymentStatus.REFUND_PENDING },
    });
  });

  it('takes the intent lock before deciding anything', async () => {
    const { repository, tx } = buildHarness();
    await repository.openRefund(
      'tenant-a',
      'pi-1',
      { amountMinor: 500 },
      openBuilders,
    );
    const locked = (tx.$queryRaw.mock.calls as unknown[][])
      .map((call) => String(call[1] ?? ''))
      .join('|');
    expect(locked).toContain('payment-intent:tenant-a:pi-1');
  });
});

describe('PaymentsRepository.settleRefund — exactly once', () => {
  it('flips PENDING to SUCCEEDED through a tenant-scoped conditional write', async () => {
    const { repository, tx } = buildHarness();
    await repository.settleRefund(
      'tenant-a',
      'rf-1',
      { status: 'SUCCEEDED', providerRefundRef: 'sim-refund-rf-1' },
      settleBuilders,
    );
    expect(tx.paymentRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'rf-1',
          tenantId: 'tenant-a',
          status: PaymentRefundStatus.PENDING,
        },
      }),
    );
  });

  it('recomputes the intent total from the refund rows, never incrementing', async () => {
    const { repository, tx } = buildHarness({ succeededSum: 500 });
    await repository.settleRefund(
      'tenant-a',
      'rf-1',
      { status: 'SUCCEEDED' },
      settleBuilders,
    );
    expect(tx.paymentIntent.update).toHaveBeenCalledWith({
      where: { id_tenantId: { id: 'pi-1', tenantId: 'tenant-a' } },
      data: { refundedAmountMinor: 500 },
    });
  });

  it('marks the order REFUNDED once everything captured has come back', async () => {
    const { repository, tx } = buildHarness({
      succeededSum: 1500,
      orderPaymentStatus: OrderPaymentStatus.REFUND_PENDING,
    });
    await repository.settleRefund(
      'tenant-a',
      'rf-1',
      { status: 'SUCCEEDED' },
      settleBuilders,
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { paymentStatus: OrderPaymentStatus.REFUNDED },
      }),
    );
  });

  it('leaves a partially refunded order PAID', async () => {
    const { repository, tx } = buildHarness({
      succeededSum: 500,
      orderPaymentStatus: OrderPaymentStatus.REFUND_PENDING,
    });
    await repository.settleRefund(
      'tenant-a',
      'rf-1',
      { status: 'SUCCEEDED' },
      settleBuilders,
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { paymentStatus: OrderPaymentStatus.PAID },
      }),
    );
  });

  it('keeps the order REFUND_PENDING while another refund is still in flight', async () => {
    const { repository, tx } = buildHarness({
      succeededSum: 500,
      pendingCount: 1,
      orderPaymentStatus: OrderPaymentStatus.PAID,
    });
    await repository.settleRefund(
      'tenant-a',
      'rf-1',
      { status: 'SUCCEEDED' },
      settleBuilders,
    );
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { paymentStatus: OrderPaymentStatus.REFUND_PENDING },
      }),
    );
  });

  it('is a no-op on a refund that has already settled', async () => {
    const { repository, tx } = buildHarness({
      refundRow: {
        id: 'rf-1',
        tenantId: 'tenant-a',
        intentId: 'pi-1',
        status: PaymentRefundStatus.SUCCEEDED,
        amountMinor: 500,
        currencyCode: 'SAR',
      },
    });
    const result = await repository.settleRefund(
      'tenant-a',
      'rf-1',
      { status: 'SUCCEEDED' },
      settleBuilders,
    );
    expect(result).toMatchObject({ replayed: true });
    expect(tx.paymentRefund.updateMany).not.toHaveBeenCalled();
    expect(tx.paymentIntent.update).not.toHaveBeenCalled();
  });

  it('reports the winner and changes nothing when it loses the flip race', async () => {
    const { repository, tx } = buildHarness({ flipCount: 0 });
    const result = await repository.settleRefund(
      'tenant-a',
      'rf-1',
      { status: 'SUCCEEDED' },
      settleBuilders,
    );
    expect(result).toMatchObject({ replayed: true });
    expect(tx.paymentIntent.update).not.toHaveBeenCalled();
  });

  it('returns null for a refund that does not belong to this tenant', async () => {
    const { repository, tx } = buildHarness();
    tx.paymentRefund.findFirst.mockResolvedValueOnce(null as never);
    expect(
      await repository.settleRefund(
        'tenant-b',
        'rf-1',
        { status: 'SUCCEEDED' },
        settleBuilders,
      ),
    ).toBeNull();
    expect(tx.paymentRefund.updateMany).not.toHaveBeenCalled();
  });
});
