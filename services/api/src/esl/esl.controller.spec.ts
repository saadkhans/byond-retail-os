import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import {
  CreateGatewayDto,
  ProcessJobsDto,
  QueryLabelsDto,
  RegisterLabelDto,
  UpdateLabelDto,
} from './dto/esl.dto';
import { EslController } from './esl.controller';

/**
 * Access-policy pin for the ESL surface: tenant-scoped, gated on the esl
 * module, and split so that reading label health does not imply the right to
 * rebind hardware or drive the queue.
 */
describe('ESL controller access policy', () => {
  it('is tenant-only and gated on the esl module', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, EslController)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, EslController)).toBe('esl');
  });

  it.each([
    ['vendors', ['esl-gateway:read']],
    ['listGateways', ['esl-gateway:read']],
    ['findGateway', ['esl-gateway:read']],
    ['createGateway', ['esl-gateway:manage']],
    ['updateGateway', ['esl-gateway:manage']],
    ['discover', ['esl-gateway:manage']],
    ['registerLabel', ['esl-label:manage']],
    ['listLabels', ['esl-label:read']],
    ['findLabel', ['esl-label:read']],
    ['updateLabel', ['esl-label:manage']],
    ['render', ['esl-label:manage']],
    ['listJobs', ['esl-job:read']],
    ['process', ['esl-job:process']],
    ['reclaim', ['esl-job:process']],
    ['reconcile', ['esl-job:process']],
  ] as const)('requires %s permissions', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        EslController.prototype[handler],
      ),
    ).toEqual(expected);
  });

  it('never lets a read permission drive the queue', () => {
    const readOnly = ['esl-gateway:read', 'esl-label:read', 'esl-job:read'];
    for (const handler of ['process', 'reclaim', 'reconcile'] as const) {
      const required: string[] = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        EslController.prototype[handler],
      );
      expect(required.some((code) => readOnly.includes(code))).toBe(false);
    }
  });
});

describe('ESL controller delegates with the caller’s tenant', () => {
  // Typed as variadic so the assertions below can index mock.calls; an
  // inferred zero-argument signature makes calls[0][n] a type error.
  const stub = <T>(value: T) =>
    jest.fn(async (..._args: unknown[]): Promise<T> => value);
  const service = {
    vendorCodes: jest.fn(() => ['SIMULATED']),
    findGateways: stub({ items: [], total: 0 }),
    createGateway: stub({ id: 'gw-1' }),
    findGatewayById: stub({ id: 'gw-1' }),
    updateGateway: stub({ id: 'gw-1' }),
    discoverLabels: stub({ registered: 0, labels: [] }),
    registerLabel: stub({ id: 'lbl-1' }),
    findLabels: stub({ items: [], total: 0 }),
    findLabelById: stub({ id: 'lbl-1' }),
    updateLabel: stub({ id: 'lbl-1' }),
    requestRender: stub({ enqueued: 1 }),
    findJobs: stub({ items: [], total: 0 }),
    processBatch: stub({ claimed: 0 }),
    reclaimExpired: stub({ requeued: 0, failed: 0 }),
    reconcile: stub({ inspected: 0, enqueued: 0 }),
  };
  const controller = new EslController(service as never);
  const actor = {
    userId: 'user-1',
    email: 'ops@tenant.test',
  } as never;

  beforeEach(() => jest.clearAllMocks());

  it('passes the authenticated tenant, never one from the body', async () => {
    await controller.listGateways('tenant-1', {});
    expect(service.findGateways).toHaveBeenCalledWith('tenant-1', {});

    await controller.createGateway(
      'tenant-1',
      {
        code: 'S1',
        name: 'Store 1',
        vendorCode: 'SIMULATED',
        locationId: 'loc-1',
      },
      actor,
    );
    expect(service.createGateway.mock.calls[0][0]).toBe('tenant-1');
  });

  it('attributes every mutation to the authenticated user', async () => {
    await controller.updateLabel('tenant-1', 'lbl-1', {}, actor);
    expect(service.updateLabel.mock.calls[0][3]).toEqual({
      id: 'user-1',
      email: 'ops@tenant.test',
    });

    await controller.render('tenant-1', 'lbl-1', actor);
    expect(service.requestRender.mock.calls[0][2]).toEqual({
      id: 'user-1',
      email: 'ops@tenant.test',
    });
  });

  it('forwards the processing limit', async () => {
    await controller.process('tenant-1', { limit: 5 });
    expect(service.processBatch).toHaveBeenCalledWith('tenant-1', 5);
  });
});

describe('ESL DTO validation', () => {
  async function errorsFor<T extends object>(
    cls: new () => T,
    payload: Record<string, unknown>,
  ): Promise<string[]> {
    const instance = plainToInstance(cls, payload);
    const errors = await validate(instance as object);
    return errors.map((error) => error.property);
  }

  it('accepts a well-formed gateway', async () => {
    expect(
      await errorsFor(CreateGatewayDto, {
        code: 'STORE-01',
        name: 'Store 1 gateway',
        vendorCode: 'SIMULATED',
        locationId: 'loc-1',
      }),
    ).toEqual([]);
  });

  it('rejects a gateway code outside the shared charset', async () => {
    expect(
      await errorsFor(CreateGatewayDto, {
        code: 'store 01/../etc',
        name: 'Store 1',
        vendorCode: 'SIMULATED',
        locationId: 'loc-1',
      }),
    ).toContain('code');
  });

  it('requires a location, because labels live in a store', async () => {
    expect(
      await errorsFor(CreateGatewayDto, {
        code: 'S1',
        name: 'Store 1',
        vendorCode: 'SIMULATED',
      }),
    ).toContain('locationId');
  });

  it('rejects a vendor label id with a path separator', async () => {
    expect(
      await errorsFor(RegisterLabelDto, { vendorLabelId: '../../etc/passwd' }),
    ).toContain('vendorLabelId');
  });

  it('rejects an unknown label status', async () => {
    expect(await errorsFor(UpdateLabelDto, { status: 'MELTED' })).toContain(
      'status',
    );
  });

  it('caps the page size and the processing batch', async () => {
    expect(await errorsFor(QueryLabelsDto, { take: 5000 })).toContain('take');
    expect(await errorsFor(ProcessJobsDto, { limit: 5000 })).toContain(
      'limit',
    );
  });

  it('coerces numeric query strings', async () => {
    const query = plainToInstance(QueryLabelsDto, { take: '10', skip: '5' });
    expect(await validate(query as object)).toEqual([]);
    expect(query.take).toBe(10);
    expect(query.skip).toBe(5);
  });
});
