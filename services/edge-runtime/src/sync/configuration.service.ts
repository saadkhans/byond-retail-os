import { Inject, Injectable } from '@nestjs/common';
import { NodeIdentityService } from '../config/node-identity.service';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { COLLECTIONS, CURSOR_IDS, LOGS } from '../store/store-names';
import {
  ConfigurationRecord,
  ConfigurationResourceType,
  ConflictRecord,
  InboxEntry,
  configurationKey,
} from './sync.types';

interface ConfigurationCursor {
  readonly appliedVersion: number;
}

/**
 * Cloud-owned configuration, applied to the local working set.
 *
 * The conflict rule for this direction is simply "the cloud wins", and the
 * version number is what makes it safe: an entry whose version is not greater
 * than the one already applied is stale and ignored. That single check is what
 * makes applying the same batch twice — after a crash, or a duplicated push —
 * a no-op, and therefore makes reconnection convergent.
 *
 * A stale entry is still recorded as a conflict rather than dropped quietly,
 * because repeated staleness means the control plane and the node disagree
 * about ordering, and an operator should see that.
 *
 * "The cloud wins" stops at the tenant boundary. An entry that names a tenant
 * other than the one this node's store is sealed to is never applied, however
 * new its version: tenant isolation is not something a node delegates to the
 * caller. It is recorded as a conflict and the watermark still advances past
 * it, so one misrouted resource cannot wedge the node into re-pulling it
 * forever. Nor does its payload reach the inbox log — a misrouted resource
 * leaves a receipt saying one arrived, never the other tenant's data.
 */
@Injectable()
export class ConfigurationService {
  constructor(
    @Inject(EDGE_STORE) private readonly store: EdgeStorePort,
    private readonly identity: NodeIdentityService,
  ) {}

  private async cursor(): Promise<ConfigurationCursor> {
    const stored = await this.store.get<ConfigurationCursor>(
      COLLECTIONS.cursors,
      CURSOR_IDS.configurationVersion,
    );
    return stored ?? { appliedVersion: 0 };
  }

  async appliedVersion(): Promise<number> {
    return (await this.cursor()).appliedVersion;
  }

  async get(
    resourceType: ConfigurationResourceType,
    resourceId: string,
  ): Promise<ConfigurationRecord | null> {
    return this.store.get<ConfigurationRecord>(
      COLLECTIONS.configuration,
      configurationKey(resourceType, resourceId),
    );
  }

  async all(): Promise<ReadonlyArray<ConfigurationRecord>> {
    const records = await this.store.list<ConfigurationRecord>(
      COLLECTIONS.configuration,
    );
    return records.map((record) => record.value);
  }

  /**
   * Applies a batch, oldest version first. Returns how many entries actually
   * changed local state — zero on a replay, which is the convergence property
   * the reconciliation tests assert.
   */
  async apply(entries: readonly InboxEntry[]): Promise<number> {
    let applied = 0;
    let highest = (await this.cursor()).appliedVersion;
    const ordered = [...entries].sort((left, right) => left.version - right.version);

    for (const entry of ordered) {
      const key = configurationKey(entry.resourceType, entry.resourceId);
      if (
        entry.tenantId !== undefined &&
        entry.tenantId !== this.identity.tenantId
      ) {
        // A receipt, not the entry. Writing the misrouted entry verbatim would
        // leave another tenant's catalog, planogram or prices sitting on this
        // retailer's box forever — the same disclosure the conflict detail is
        // careful to avoid, through a different file. What an operator needs
        // is that something arrived, for what, and when; the payload and the
        // foreign tenant id are not part of that.
        await this.store.append(LOGS.inbox, {
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          version: entry.version,
          rejected: 'FOREIGN_TENANT',
        });
        await this.recordConflict({
          kind: 'FOREIGN_TENANT_CONFIGURATION',
          detectedAt: new Date().toISOString(),
          detail: {
            resourceType: entry.resourceType,
            resourceId: entry.resourceId,
            incomingVersion: entry.version,
          },
        });
        highest = Math.max(highest, entry.version);
        continue;
      }
      await this.store.append(LOGS.inbox, entry);
      const current = await this.store.get<ConfigurationRecord>(
        COLLECTIONS.configuration,
        key,
      );
      if (current !== null && entry.version <= current.version) {
        await this.recordConflict({
          kind: 'STALE_CONFIGURATION',
          detectedAt: new Date().toISOString(),
          detail: {
            resourceType: entry.resourceType,
            resourceId: entry.resourceId,
            incomingVersion: entry.version,
            appliedVersion: current.version,
          },
        });
        highest = Math.max(highest, entry.version);
        continue;
      }
      if (entry.deleted === true) {
        await this.store.remove(COLLECTIONS.configuration, key);
      } else {
        await this.store.put<ConfigurationRecord>(COLLECTIONS.configuration, key, {
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          version: entry.version,
          payload: entry.payload,
          appliedAt: new Date().toISOString(),
        });
      }
      applied += 1;
      highest = Math.max(highest, entry.version);
    }

    await this.store.put<ConfigurationCursor>(
      COLLECTIONS.cursors,
      CURSOR_IDS.configurationVersion,
      { appliedVersion: highest },
    );
    return applied;
  }

  private async recordConflict(record: ConflictRecord): Promise<void> {
    await this.store.append(LOGS.conflicts, record);
  }
}
