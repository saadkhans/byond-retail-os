import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { StoreFlowAutonomyLevel } from '@prisma/client';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { StoreFlowController } from './store-flow.controller';
import {
  IssueEntryTokenDto,
  PublishStoreFlowPolicyDto,
  RedeemEntryTokenDto,
  ReviewObservationDto,
} from './store-flow.dto';
import { StoreFlowService } from './store-flow.service';

/**
 * Access-policy pin for the store flow. This surface can move stock and take
 * money, so the permission split is asserted rather than assumed: reading is
 * separate from operating, operating is separate from changing how autonomous
 * a store is, and entering the store is its own narrow grant.
 */
describe('store-flow controller access policy', () => {
  it('is tenant-only and gated on the store-flow module', () => {
    expect(Reflect.getMetadata(TENANT_ONLY_KEY, StoreFlowController)).toBe(
      true,
    );
    expect(Reflect.getMetadata(REQUIRED_MODULE_KEY, StoreFlowController)).toBe(
      'store-flow',
    );
  });

  it.each([
    ['policies', ['store-flow:read']],
    ['effectivePolicy', ['store-flow:read']],
    ['entryTokens', ['store-flow:read']],
    ['journeys', ['store-flow:read']],
    ['journey', ['store-flow:read']],
    ['reviewQueue', ['store-flow:read']],
    ['publishPolicy', ['store-flow:manage']],
    ['issueEntryToken', ['store-flow:operate']],
    ['revokeEntryToken', ['store-flow:operate']],
    ['sync', ['store-flow:operate']],
    ['exit', ['store-flow:operate']],
    ['enter', ['store-flow:enter']],
    ['decide', ['store-flow:review']],
  ] as const)('gates %s behind %s', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        StoreFlowController.prototype[handler],
      ),
    ).toEqual(expected);
  });

  it('never lets a read permission reach a handler that changes something', () => {
    const mutating = [
      'publishPolicy',
      'issueEntryToken',
      'revokeEntryToken',
      'enter',
      'sync',
      'exit',
      'decide',
    ] as const;
    for (const handler of mutating) {
      const granted: string[] = Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        StoreFlowController.prototype[handler],
      );
      expect(granted).not.toContain('store-flow:read');
    }
  });
});

describe('store-flow controller delegates with the caller tenant and actor', () => {
  const service = {
    listPolicies: jest.fn(async () => []),
    effectivePolicy: jest.fn(async () => ({})),
    publishPolicy: jest.fn(async () => ({})),
    issueEntryToken: jest.fn(async () => ({})),
    listEntryTokens: jest.fn(async () => []),
    revokeEntryToken: jest.fn(async () => ({})),
    redeemEntryToken: jest.fn(async () => ({})),
    listJourneys: jest.fn(async () => []),
    journeyDetail: jest.fn(async () => ({})),
    syncJourney: jest.fn(async () => ({})),
    exitJourney: jest.fn(async () => ({})),
    reviewQueue: jest.fn(async () => []),
    reviewObservation: jest.fn(async () => ({})),
  } as unknown as StoreFlowService;
  const controller = new StoreFlowController(service);
  const user = {
    userId: 'user-7',
    email: 'ops@example.com',
  } as never;

  beforeEach(() => jest.clearAllMocks());

  it('passes the tenant and the actor through on a policy change', async () => {
    const body = {
      autonomyLevel: StoreFlowAutonomyLevel.PROPOSE,
    } as PublishStoreFlowPolicyDto;
    await controller.publishPolicy('tenant-9', body, user);
    expect(service.publishPolicy).toHaveBeenCalledWith('tenant-9', body, {
      id: 'user-7',
      email: 'ops@example.com',
    });
  });

  it('passes the tenant through on entry', async () => {
    await controller.enter('tenant-9', { token: 'abc' } as never, user);
    expect(service.redeemEntryToken).toHaveBeenCalledWith(
      'tenant-9',
      { token: 'abc' },
      { id: 'user-7', email: 'ops@example.com' },
    );
  });

  it('passes the tenant through on exit', async () => {
    await controller.exit('tenant-9', 'journey-1', user);
    expect(service.exitJourney).toHaveBeenCalledWith('tenant-9', 'journey-1', {
      id: 'user-7',
      email: 'ops@example.com',
    });
  });

  it('passes the tenant through on a queue decision', async () => {
    const body = { decision: 'APPROVE' } as never;
    await controller.decide('tenant-9', 'obs-1', body, user);
    expect(service.reviewObservation).toHaveBeenCalledWith(
      'tenant-9',
      'obs-1',
      body,
      { id: 'user-7', email: 'ops@example.com' },
    );
  });
});

describe('store-flow request validation', () => {
  const errorsFor = async <T extends object>(
    cls: new () => T,
    payload: Record<string, unknown>,
  ) => validate(plainToInstance(cls, payload));

  it('rejects an autonomy level that is not in the vocabulary', async () => {
    const errors = await errorsFor(PublishStoreFlowPolicyDto, {
      autonomyLevel: 'FULL_SEND',
    });
    expect(errors.map((error) => error.property)).toContain('autonomyLevel');
  });

  it('rejects a confidence threshold outside zero to one', async () => {
    const errors = await errorsFor(PublishStoreFlowPolicyDto, {
      autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
      autoApplyMinConfidence: 1.5,
    });
    expect(errors.map((error) => error.property)).toContain(
      'autoApplyMinConfidence',
    );
  });

  it('accepts a well-formed policy change', async () => {
    const errors = await errorsFor(PublishStoreFlowPolicyDto, {
      autonomyLevel: StoreFlowAutonomyLevel.AUTO_APPLY,
      autoApplyMinConfidence: 0.75,
      requireInventoryValidation: true,
      settleOnExit: true,
      note: 'pilot store, staffed hours only',
    });
    expect(errors).toHaveLength(0);
  });

  it('refuses an entry credential lifetime beyond the ceiling', async () => {
    const errors = await errorsFor(IssueEntryTokenDto, {
      locationId: 'store-1',
      unitId: 'unit-1',
      ttlSeconds: 86400,
    });
    expect(errors.map((error) => error.property)).toContain('ttlSeconds');
  });

  it('refuses an entry credential lifetime below the floor', async () => {
    const errors = await errorsFor(IssueEntryTokenDto, {
      locationId: 'store-1',
      unitId: 'unit-1',
      ttlSeconds: 1,
    });
    expect(errors.map((error) => error.property)).toContain('ttlSeconds');
  });

  it('refuses a token that is not base64url, so no separator can smuggle content', async () => {
    const errors = await errorsFor(RedeemEntryTokenDto, {
      token: 'not a token; drop table',
    });
    expect(errors.map((error) => error.property)).toContain('token');
  });

  it('refuses a review decision outside the vocabulary', async () => {
    const errors = await errorsFor(ReviewObservationDto, {
      decision: 'MAYBE',
    });
    expect(errors.map((error) => error.property)).toContain('decision');
  });

  it('caps a corrected quantity', async () => {
    const errors = await errorsFor(ReviewObservationDto, {
      decision: 'CORRECT',
      correctedProductId: 'prod-1',
      correctedQuantity: 10_000,
    });
    expect(errors.map((error) => error.property)).toContain(
      'correctedQuantity',
    );
  });
});
