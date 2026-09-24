import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  OrderReturnKind,
  OrderReturnStatus,
  PaymentRefundStatus,
  PaymentStatus,
  RefundSkipReason,
} from '@prisma/client';
import { ReturnsService } from './returns.service';
import { ReturnStockRejected } from './returns.repository';

// Secret-shaped test strings are BUILT AT RUNTIME so no static secret/PAN is
// ever committed (Gitleaks-safe). '4111 1111 1111 1111' is Luhn-valid.
const TEST_PAN = ['4111', '1111', '1111', '1111'].join('');
const DOTTED_PAN = ['4111', '1111', '1111', '1111'].join('.');

const actor = { id: 'user-1', email: 'user@tenant.example' };

function recorded(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ret-1',
    orderId: 'order-1',
    status: OrderReturnStatus.RECORDED,
    refundId: null,
    refundSkipReason: null,
    refundAmountMinor: 500,
    currencyCode: 'SAR',
    ...overrides,
  };
}

function buildHarness(
  options: {
    recordResult?: unknown;
    capturedIntent?: Record<string, unknown> | null;
    refund?: Record<string, unknown>;
  } = {},
) {
  const repository = {
    recordReturn: jest.fn(async () => {
      if (options.recordResult !== undefined) {
        return options.recordResult;
      }
      return { orderReturn: recorded(), replayed: false };
    }),
    linkRefund: jest.fn(
      async (
        _tenantId: string,
        _id: string,
        linkage: Record<string, unknown>,
      ) => recorded(linkage),
    ),
    findById: jest.fn(),
    search: jest.fn(),
  };
  const payments = {
    findCapturedIntentForOrder: jest.fn(async () =>
      options.capturedIntent === undefined
        ? {
            id: 'pi-1',
            status: PaymentStatus.CAPTURED,
            capturedAmountMinor: 1500,
            refundedAmountMinor: 0,
          }
        : options.capturedIntent,
    ),
    refund: jest.fn(async () => ({
      id: 'rf-1',
      status: PaymentRefundStatus.SUCCEEDED,
      ...options.refund,
    })),
  };
  const service = new ReturnsService(
    repository as never,
    payments as never,
  );
  return { service, repository, payments };
}

const baseDto = {
  orderId: 'order-1',
  kind: OrderReturnKind.CUSTOMER_RETURN,
  reference: 'RET-1',
  reason: 'Customer changed their mind',
  lines: [{ orderLineId: 'ol-1', quantity: 2 }],
};

describe('ReturnsService — free text never reaches the ledger unscreened', () => {
  it.each([
    ['reason', { ...baseDto, reason: `refund to ${TEST_PAN}` }],
    ['a dot-grouped PAN in the reason', { ...baseDto, reason: DOTTED_PAN }],
    ['reference', { ...baseDto, reference: DOTTED_PAN }],
    [
      'a line note',
      {
        ...baseDto,
        lines: [{ orderLineId: 'ol-1', quantity: 1, note: TEST_PAN }],
      },
    ],
  ])('rejects a card number in %s before any write', async (_label, dto) => {
    const { service, repository } = buildHarness();
    await expect(
      service.recordReturn('tenant-a', dto as never, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.recordReturn).not.toHaveBeenCalled();
  });

  it('requires a customer return to name its lines', async () => {
    const { service, repository } = buildHarness();
    await expect(
      service.recordReturn(
        'tenant-a',
        { ...baseDto, lines: [] } as never,
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.recordReturn).not.toHaveBeenCalled();
  });
});

describe('ReturnsService — goods first, money second', () => {
  it('refunds the value of the returned goods through the payment abstraction', async () => {
    const { service, payments, repository } = buildHarness();
    const result = await service.recordReturn('tenant-a', baseDto, actor);
    expect(payments.refund).toHaveBeenCalledWith(
      'tenant-a',
      'pi-1',
      expect.objectContaining({
        amountMinor: 500,
        // Derived from the RETURN id, which is itself guarded by the caller's
        // tenant-scoped reference — so a replay lands on the same refund row.
        idempotencyKey: 'return-refund-ret-1',
      }),
      actor,
    );
    expect(repository.linkRefund).toHaveBeenCalledWith(
      'tenant-a',
      'ret-1',
      {
        status: OrderReturnStatus.REFUNDED,
        refundId: 'rf-1',
        refundSkipReason: null,
      },
      expect.any(Function),
    );
    expect(result.status).toBe(OrderReturnStatus.REFUNDED);
  });

  it('never refunds more than the payment has left to give', async () => {
    const { service, payments } = buildHarness({
      capturedIntent: {
        id: 'pi-1',
        capturedAmountMinor: 1500,
        refundedAmountMinor: 1200,
      },
    });
    await service.recordReturn('tenant-a', baseDto, actor);
    // The goods were worth 500; only 300 of the capture is left.
    expect(payments.refund).toHaveBeenCalledWith(
      'tenant-a',
      'pi-1',
      expect.objectContaining({ amountMinor: 300 }),
      actor,
    );
  });

  it('records ALREADY_FULLY_REFUNDED rather than asking for money twice', async () => {
    const { service, payments, repository } = buildHarness({
      capturedIntent: {
        id: 'pi-1',
        capturedAmountMinor: 1500,
        refundedAmountMinor: 1500,
      },
    });
    const result = await service.recordReturn('tenant-a', baseDto, actor);
    expect(payments.refund).not.toHaveBeenCalled();
    expect(result.refundSkipReason).toBe(
      RefundSkipReason.ALREADY_FULLY_REFUNDED,
    );
    expect(repository.linkRefund).toHaveBeenCalled();
  });

  it('records NO_CAPTURED_PAYMENT when nothing was ever taken', async () => {
    // Phase 26's inherited thread: an order whose only intent ended CANCELLED /
    // FAILED / VOIDED / EXPIRED has no CAPTURED intent at all. The goods still
    // come back; the absence of a refund is STATED, not thrown.
    const { service, payments } = buildHarness({ capturedIntent: null });
    const result = await service.recordReturn('tenant-a', baseDto, actor);
    expect(payments.refund).not.toHaveBeenCalled();
    expect(result.status).toBe(OrderReturnStatus.RECORDED);
    expect(result.refundSkipReason).toBe(RefundSkipReason.NO_CAPTURED_PAYMENT);
  });

  it('records NO_PRICEABLE_LINES for a return that cannot be valued', async () => {
    const { service, payments } = buildHarness({
      recordResult: {
        orderReturn: recorded({ refundAmountMinor: null, currencyCode: null }),
        replayed: false,
      },
    });
    const result = await service.recordReturn('tenant-a', baseDto, actor);
    expect(payments.refund).not.toHaveBeenCalled();
    expect(result.refundSkipReason).toBe(RefundSkipReason.NO_PRICEABLE_LINES);
  });

  it('honours an explicit stock-only return', async () => {
    const { service, payments } = buildHarness();
    const result = await service.recordReturn(
      'tenant-a',
      { ...baseDto, refund: false },
      actor,
    );
    expect(payments.refund).not.toHaveBeenCalled();
    expect(result.refundSkipReason).toBe(RefundSkipReason.NOT_REQUESTED);
  });

  it('marks the return REFUND_FAILED when the gateway declined', async () => {
    const { service } = buildHarness({
      refund: { status: PaymentRefundStatus.FAILED },
    });
    const result = await service.recordReturn('tenant-a', baseDto, actor);
    expect(result.status).toBe(OrderReturnStatus.REFUND_FAILED);
    expect(result.refundId).toBe('rf-1');
  });

  it('pays nothing again for a replayed return that already has a refund', async () => {
    const { service, payments } = buildHarness({
      recordResult: {
        orderReturn: recorded({
          status: OrderReturnStatus.REFUNDED,
          refundId: 'rf-1',
        }),
        replayed: true,
      },
    });
    await service.recordReturn('tenant-a', baseDto, actor);
    expect(payments.refund).not.toHaveBeenCalled();
  });

  it('re-drives settlement for a replay that never got that far', async () => {
    // A crash between reversing the stock and settling the money leaves a
    // RECORDED return with no refund and no skip reason. Replaying the request
    // must pick it up rather than leaving the shopper unpaid forever.
    const { service, payments } = buildHarness({
      recordResult: { orderReturn: recorded(), replayed: true },
    });
    await service.recordReturn('tenant-a', baseDto, actor);
    expect(payments.refund).toHaveBeenCalledTimes(1);
  });
});

describe('ReturnsService — rejections become controlled responses', () => {
  it.each([
    ['quantity-exceeds-remaining'],
    ['nothing-left-to-return'],
    ['order-not-returnable'],
    ['reference-mismatch'],
    ['order-cancel-conflict'],
  ])('maps %s to a 409', async (rejection) => {
    const { service, payments } = buildHarness({ recordResult: rejection });
    await expect(
      service.recordReturn('tenant-a', baseDto, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(payments.refund).not.toHaveBeenCalled();
  });

  it.each([['line-not-on-order'], ['duplicate-line'], ['quantity-invalid']])(
    'maps %s to a 400',
    async (rejection) => {
      const { service } = buildHarness({ recordResult: rejection });
      await expect(
        service.recordReturn('tenant-a', baseDto, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('never moves money when the ledger refused the goods', async () => {
    const { service, payments } = buildHarness({
      recordResult: new ReturnStockRejected('product-archived', 'SKU-1'),
    });
    await expect(
      service.recordReturn('tenant-a', baseDto, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(payments.refund).not.toHaveBeenCalled();
  });
});
