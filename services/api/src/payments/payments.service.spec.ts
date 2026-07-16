import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';

// Secret-shaped test strings are BUILT AT RUNTIME so no static secret/PAN is
// ever committed (Gitleaks-safe). '4111 1111 1111 1111' is Luhn-valid.
const TEST_PAN = ['4111', '1111', '1111', '1111'].join('');
const TEST_SECRET_TOKEN = ['sk', 'live', 'abcd1234efgh5678ijkl'].join('_');

function makeRepo(): jest.Mocked<PaymentsRepository> {
  return {
    createIntent: jest.fn(),
    findIntentById: jest.fn(),
    findIntentByIdempotencyKey: jest.fn(),
    searchIntents: jest.fn(),
    searchCaptures: jest.fn(),
    findCaptureByIdempotencyKey: jest.fn(),
    findAuthorizationByIdempotencyKey: jest.fn(),
    authorize: jest.fn(),
    capture: jest.fn(),
    cancel: jest.fn(),
    fail: jest.fn(),
  } as unknown as jest.Mocked<PaymentsRepository>;
}

const actor = { id: 'user-1', email: 'user@tenant.example' };
const intentDetail = { id: 'pi-1', status: PaymentStatus.CAPTURED } as never;

describe('PaymentsService', () => {
  let repo: jest.Mocked<PaymentsRepository>;
  let service: PaymentsService;

  beforeEach(() => {
    repo = makeRepo();
    service = new PaymentsService(repo);
  });

  const baseCreate = {
    amountMinor: 1500,
    currencyCode: 'SAR',
  };

  it('rejects a providerRef that carries a raw card number before any write', async () => {
    await expect(
      service.create('tenant-a', { ...baseCreate, providerRef: TEST_PAN }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.createIntent).not.toHaveBeenCalled();
  });

  it('rejects a description that carries a secret token before any write', async () => {
    await expect(
      service.create(
        'tenant-a',
        { ...baseCreate, description: `ref ${TEST_SECRET_TOKEN}` },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.createIntent).not.toHaveBeenCalled();
  });

  it('rejects an instrumentLast4 that is not exactly four digits', async () => {
    await expect(
      service.create(
        'tenant-a',
        { ...baseCreate, instrumentLast4: '123456' },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.createIntent).not.toHaveBeenCalled();
  });

  it('maps order-not-found to a controlled 400', async () => {
    repo.createIntent.mockResolvedValue('order-not-found');
    await expect(
      service.create('tenant-a', { ...baseCreate, orderId: 'nope' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replays the winner intent on a create idempotency-key P2002 race', async () => {
    repo.createIntent.mockRejectedValue({ code: 'P2002' });
    repo.findIntentByIdempotencyKey.mockResolvedValue(intentDetail);
    const result = await service.create(
      'tenant-a',
      { ...baseCreate, idempotencyKey: 'key-1' },
      actor,
    );
    expect(result).toBe(intentDetail);
    expect(repo.findIntentByIdempotencyKey).toHaveBeenCalledWith(
      'tenant-a',
      'key-1',
    );
  });

  it('returns the created intent on success', async () => {
    repo.createIntent.mockResolvedValue({
      intent: intentDetail,
      replayed: false,
    });
    await expect(
      service.create('tenant-a', baseCreate, actor),
    ).resolves.toBe(intentDetail);
  });

  it('maps capture terminal-blocked to a 409', async () => {
    repo.capture.mockResolvedValue('terminal-blocked');
    await expect(
      service.capture('tenant-a', 'pi-1', {}, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps capture invalid-state to a 409', async () => {
    repo.capture.mockResolvedValue('invalid-state');
    await expect(
      service.capture('tenant-a', 'pi-1', {}, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a missing intent to a 404', async () => {
    repo.capture.mockResolvedValue(null);
    await expect(
      service.capture('tenant-a', 'pi-1', {}, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replays a capture whose key already captured THIS intent (P2002)', async () => {
    repo.capture.mockRejectedValue({ code: 'P2002' });
    repo.findCaptureByIdempotencyKey.mockResolvedValue({
      id: 'cap-1',
      intentId: 'pi-1',
    } as never);
    repo.findIntentById.mockResolvedValue(intentDetail);
    const result = await service.capture(
      'tenant-a',
      'pi-1',
      { idempotencyKey: 'k' },
      actor,
    );
    expect(result).toBe(intentDetail);
  });

  it('rejects a capture key already used by a DIFFERENT intent (P2002 conflict)', async () => {
    repo.capture.mockRejectedValue({ code: 'P2002' });
    repo.findCaptureByIdempotencyKey.mockResolvedValue({
      id: 'cap-1',
      intentId: 'pi-OTHER',
    } as never);
    await expect(
      service.capture('tenant-a', 'pi-1', { idempotencyKey: 'k' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a cancellation reason carrying a raw card number', async () => {
    await expect(
      service.cancel('tenant-a', 'pi-1', { reason: `void ${TEST_PAN}` }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.cancel).not.toHaveBeenCalled();
  });

  it('rejects an authorize providerRef carrying credentials', async () => {
    await expect(
      service.authorize(
        'tenant-a',
        'pi-1',
        { providerRef: `https://api.example.com/?api_key=${TEST_SECRET_TOKEN}` },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.authorize).not.toHaveBeenCalled();
  });
});
