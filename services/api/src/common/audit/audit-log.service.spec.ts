import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditEntry, AuditLogService, SYSTEM_ACTOR_EMAIL } from './audit-log.service';

describe('AuditLogService', () => {
  const baseEntry: AuditEntry = {
    tenantId: 'tenant-a',
    actorEmail: SYSTEM_ACTOR_EMAIL,
    action: AuditAction.CREATE,
    entityType: 'User',
    entityId: 'user-1',
  };

  let prisma: { auditLog: { create: jest.Mock } };
  let service: AuditLogService;

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
    service = new AuditLogService(prisma as unknown as PrismaService);
  });

  function recordedData(): Record<string, unknown> {
    return prisma.auditLog.create.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
  }

  it('writes through the provided transaction client when given', async () => {
    const tx = { auditLog: { create: jest.fn().mockResolvedValue({}) } };

    await service.record(baseEntry, tx as never);

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('writes through the default client when no transaction is given', async () => {
    await service.record(baseEntry);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    'password',
    'passwordHash',
    'api_key',
    'apiKey',
    'access_token',
    'access-token',
    'access:token',
    'refresh_token',
    'refresh/token',
    'card_number',
    'card-number',
    'card.number',
    'Card Number',
    'credit_card_number',
    'secret',
    'secret.key',
    'secret_key',
    'client_secret',
    'private-key',
    'session_token',
    'id_token',
    'authorization',
    'bearer_token',
    'bearer',
    'cvv',
    'cvc',
    'pin',
    'iban',
    'apiToken',
    'paymentToken',
    'cardToken',
    'cardPan',
    'payment_token',
    'card_token',
    'card_pan',
    'primary_account_number',
    'webhookSecret',
    'bank_account_number',
  ])('redacts %j regardless of separator style or qualifier', async (key) => {
    await service.record({
      ...baseEntry,
      after: { [key]: 'sensitive-value', keepMe: 'visible' },
    });

    const after = recordedData().after as Record<string, unknown>;
    expect(after[key]).toBe('[REDACTED]');
    expect(after.keepMe).toBe('visible');
  });

  it.each(['timespan', 'tokenized', 'description', 'company', 'firstName'])(
    'does not over-redact harmless field %j',
    async (key) => {
      await service.record({
        ...baseEntry,
        after: { [key]: 'plain-value' },
      });

      const after = recordedData().after as Record<string, unknown>;
      expect(after[key]).toBe('plain-value');
    },
  );

  it('redacts qualified aliases nested in objects', async () => {
    await service.record({
      ...baseEntry,
      after: {
        payment: { paymentToken: 'tok_123', amount: 42 },
      },
    });

    const after = recordedData().after as {
      payment: Record<string, unknown>;
    };
    expect(after.payment.paymentToken).toBe('[REDACTED]');
    expect(after.payment.amount).toBe(42);
  });

  it('redacts qualified aliases inside array items', async () => {
    await service.record({
      ...baseEntry,
      after: { cards: [{ cardPan: '4111111111111111', brand: 'visa' }] },
    });

    const after = recordedData().after as {
      cards: Record<string, unknown>[];
    };
    expect(after.cards[0].cardPan).toBe('[REDACTED]');
    expect(after.cards[0].brand).toBe('visa');
  });

  it('redacts nested objects and arrays recursively', async () => {
    await service.record({
      ...baseEntry,
      after: {
        profile: { api_key: 'k', name: 'Jane' },
        cards: [{ card_number: '4111', label: 'main' }],
      },
    });

    const after = recordedData().after as {
      profile: Record<string, unknown>;
      cards: Record<string, unknown>[];
    };
    expect(after.profile.api_key).toBe('[REDACTED]');
    expect(after.profile.name).toBe('Jane');
    expect(after.cards[0].card_number).toBe('[REDACTED]');
    expect(after.cards[0].label).toBe('main');
  });

  it('serializes dates and preserves non-sensitive scalars', async () => {
    await service.record({
      ...baseEntry,
      after: { createdAt: new Date('2026-07-05T00:00:00Z'), count: 3 },
    });

    const after = recordedData().after as Record<string, unknown>;
    expect(after.createdAt).toBe('2026-07-05T00:00:00.000Z');
    expect(after.count).toBe(3);
  });
});
