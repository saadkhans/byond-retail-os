import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeConfigService } from '../src/config/edge-config.service';
import { NodeIdentityService } from '../src/config/node-identity.service';
import { StructuredLogger } from '../src/logging/structured-logger';
import { EdgeStorePort } from '../src/store/edge-store.port';
import { FileEdgeStore } from '../src/store/file-edge-store.adapter';

/** A real, isolated store on disk — the adapter's durability is under test. */
export async function temporaryStore(): Promise<{
  store: FileEdgeStore;
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'byond-edge-'));
  const store = new FileEdgeStore(root);
  await store.open();
  return {
    store,
    root,
    cleanup: async (): Promise<void> => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function fakeConfig(
  overrides: Record<string, unknown> = {},
): EdgeConfigService {
  const values: Record<string, unknown> = {
    EDGE_TENANT_ID: 'tenant-test',
    EDGE_LOCATION_ID: 'location-test',
    EDGE_DEVICE_ID: 'device-test',
    EDGE_STORE_ROOT: './.edge-store-test',
    ...overrides,
  };
  const config = {
    get: (key: string): unknown => values[key],
    getOrThrow: (key: string): unknown => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`missing ${key}`);
      }
      return value;
    },
  } as unknown as ConfigService;
  return new EdgeConfigService(config);
}

/** A logger that captures instead of printing, so suites stay quiet. */
export function silentLogger(): StructuredLogger {
  const logger = new StructuredLogger();
  logger.setSink(() => undefined);
  return logger;
}

/** A sealed identity over a store, for services that need the tenant binding. */
export async function sealedIdentity(
  store: EdgeStorePort,
  overrides: Record<string, unknown> = {},
): Promise<NodeIdentityService> {
  const identity = new NodeIdentityService(store, fakeConfig(overrides));
  await identity.seal();
  return identity;
}
