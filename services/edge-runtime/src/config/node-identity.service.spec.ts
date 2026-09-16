import { fakeConfig, temporaryStore } from '../../test/helpers';
import { COLLECTIONS, IDENTITY_ID } from '../store/store-names';
import { NodeIdentity, NodeIdentityService } from './node-identity.service';

describe('NodeIdentityService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;

  beforeEach(async () => {
    context = await temporaryStore();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  function identity(overrides: Record<string, unknown> = {}): NodeIdentityService {
    return new NodeIdentityService(context.store, fakeConfig(overrides));
  }

  it('seals an empty store to the configured node', async () => {
    const sealed = await identity().seal();
    expect(sealed).toMatchObject({
      tenantId: 'tenant-test',
      locationId: 'location-test',
      deviceId: 'device-test',
    });
    await expect(
      context.store.get<NodeIdentity>(COLLECTIONS.identity, IDENTITY_ID.node),
    ).resolves.toMatchObject({ tenantId: 'tenant-test' });
  });

  it('re-opens the same store without resealing it', async () => {
    const first = await identity().seal();
    const second = await identity().seal();
    expect(second).toEqual(first);
  });

  it('refuses to open a store sealed to another tenant', async () => {
    await identity().seal();
    await expect(
      identity({ EDGE_TENANT_ID: 'tenant-other' }).seal(),
    ).rejects.toThrow(/sealed to a different node/);
  });

  it('refuses a store sealed to another location or device', async () => {
    await identity().seal();
    await expect(
      identity({ EDGE_LOCATION_ID: 'location-other' }).seal(),
    ).rejects.toThrow(/locationId/);
    await expect(
      identity({ EDGE_DEVICE_ID: 'device-other' }).seal(),
    ).rejects.toThrow(/deviceId/);
  });

  it('names the mismatched fields without disclosing either value', async () => {
    await identity().seal();
    const mismatch = identity({
      EDGE_TENANT_ID: 'tenant-other',
      EDGE_DEVICE_ID: 'device-other',
    });
    await expect(mismatch.seal()).rejects.toThrow(/tenantId, deviceId/);
    await expect(mismatch.seal()).rejects.not.toThrow(/tenant-test/);
    await expect(mismatch.seal()).rejects.not.toThrow(/tenant-other/);
  });

  it('leaves the sealed store untouched after a refusal', async () => {
    const sealed = await identity().seal();
    await expect(
      identity({ EDGE_TENANT_ID: 'tenant-other' }).seal(),
    ).rejects.toThrow();
    await expect(
      context.store.get<NodeIdentity>(COLLECTIONS.identity, IDENTITY_ID.node),
    ).resolves.toEqual(sealed);
  });

  it('refuses to report an identity it has not read', () => {
    expect(() => identity().current()).toThrow(/seal\(\) must run/);
  });

  it('falls back to the configured tenant before the seal is read', async () => {
    const service = identity();
    expect(service.tenantId).toBe('tenant-test');
    await service.seal();
    expect(service.tenantId).toBe('tenant-test');
    expect(service.current().tenantId).toBe('tenant-test');
  });
});
