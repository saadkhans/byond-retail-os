import { Inject, Injectable } from '@nestjs/common';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { COLLECTIONS, IDENTITY_ID } from '../store/store-names';
import { EdgeConfigService } from './edge-config.service';

export interface NodeIdentity {
  readonly tenantId: string;
  readonly locationId: string;
  readonly deviceId: string;
  readonly sealedAt: string;
}

/**
 * The node's tenant binding, sealed into its own store.
 *
 * AGENTS.md requires tenant isolation at the data-access layer rather than by
 * convention. A cloud service does that per query; an edge node has a simpler
 * and stricter option, because it serves exactly one tenant at one location:
 * seal the store to that identity the first time it is opened and refuse to
 * open it as anyone else afterwards.
 *
 * That closes the isolation hole this deployment shape actually has. A box
 * re-provisioned to a second retailer — or pointed at a store directory
 * restored from another site — would otherwise resume the previous tenant's
 * ledger, review queue and catalog, and push their facts up under the new
 * device's credential. Refusing to start is the only safe answer: the
 * directory is evidence, so it is never rewritten or cleared automatically.
 *
 * The mismatch error names the FIELD that differs and never its values, so a
 * misconfigured node cannot disclose the other tenant's identifiers through
 * its own logs.
 */
@Injectable()
export class NodeIdentityService {
  private identity: NodeIdentity | null = null;

  constructor(
    @Inject(EDGE_STORE) private readonly store: EdgeStorePort,
    private readonly config: EdgeConfigService,
  ) {}

  private configured(): Omit<NodeIdentity, 'sealedAt'> {
    return {
      tenantId: this.config.tenantId,
      locationId: this.config.locationId,
      deviceId: this.config.deviceId,
    };
  }

  /**
   * Seals the store on first use and verifies it on every later start.
   * Returns the identity the store is bound to.
   */
  async seal(): Promise<NodeIdentity> {
    const expected = this.configured();
    const existing = await this.store.get<NodeIdentity>(
      COLLECTIONS.identity,
      IDENTITY_ID.node,
    );
    if (existing === null) {
      const sealed: NodeIdentity = {
        ...expected,
        sealedAt: new Date().toISOString(),
      };
      await this.store.put(COLLECTIONS.identity, IDENTITY_ID.node, sealed);
      this.identity = sealed;
      return sealed;
    }
    const mismatched = (
      ['tenantId', 'locationId', 'deviceId'] as const
    ).filter((field) => existing[field] !== expected[field]);
    if (mismatched.length > 0) {
      throw new Error(
        `Edge store is sealed to a different node; ${mismatched.join(
          ', ',
        )} does not match this configuration`,
      );
    }
    this.identity = existing;
    return existing;
  }

  /** The sealed identity. Throws if `seal()` has not run — never guesses. */
  current(): NodeIdentity {
    if (this.identity === null) {
      throw new Error('NodeIdentityService.seal() must run before use');
    }
    return this.identity;
  }

  /** The tenant this node is bound to, without requiring the seal to be read. */
  get tenantId(): string {
    return this.identity?.tenantId ?? this.config.tenantId;
  }
}
