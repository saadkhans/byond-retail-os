import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test environment defaults. The edge runtime must never need hardware, a
 * network, or a database to run its suite: every port has a simulated adapter
 * and the store root is a temporary directory.
 *
 * The store root has to be set HERE rather than in a `beforeAll`, because
 * `ConfigModule.forRoot()` reads the environment while `app.module.ts` is
 * being imported — long before any hook runs. `setupFiles` executes once per
 * test file, so each file gets its own isolated directory and no suite can
 * inherit another's ledger.
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.EDGE_TENANT_ID = process.env.EDGE_TENANT_ID ?? 'tenant-test';
process.env.EDGE_LOCATION_ID = process.env.EDGE_LOCATION_ID ?? 'location-test';
process.env.EDGE_DEVICE_ID = process.env.EDGE_DEVICE_ID ?? 'device-test';
process.env.EDGE_STORE_ROOT = mkdtempSync(join(tmpdir(), 'byond-edge-suite-'));

// Defaults for suites that boot the real application (the end-to-end spec).
// Unit tests construct their services with an explicit fake configuration.
process.env.EDGE_DRIVERS =
  process.env.EDGE_DRIVERS ?? 'scale:simulated,esl:simulated';
process.env.EDGE_REVIEW_CONFIDENCE_THRESHOLD =
  process.env.EDGE_REVIEW_CONFIDENCE_THRESHOLD ?? '0.75';
// Long intervals so no background pass fires mid-test; syncs are driven
// explicitly by the specs that need them.
process.env.EDGE_SYNC_INTERVAL_MS = process.env.EDGE_SYNC_INTERVAL_MS ?? '3600000';
process.env.EDGE_HEARTBEAT_INTERVAL_MS =
  process.env.EDGE_HEARTBEAT_INTERVAL_MS ?? '3600000';
