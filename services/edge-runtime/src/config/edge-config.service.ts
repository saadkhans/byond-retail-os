import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface DriverSelection {
  readonly kind: string;
  readonly adapterKey: string;
}

/**
 * Typed, defaulted access to the validated environment.
 *
 * Every `@IsInt`/`@IsNumber` key comes back from ConfigService already
 * coerced to a number by class-transformer, so nothing here re-parses a
 * string. Defaults live in one place so a missing key and a mistyped key
 * cannot diverge.
 */
@Injectable()
export class EdgeConfigService {
  constructor(private readonly config: ConfigService) {}

  private num(key: string, fallback: number): number {
    const raw = this.config.get<number | string>(key);
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  private str(key: string): string | undefined {
    const raw = this.config.get<string>(key);
    return raw === undefined || raw === '' ? undefined : raw;
  }

  get tenantId(): string {
    return this.config.getOrThrow<string>('EDGE_TENANT_ID');
  }

  get locationId(): string {
    return this.config.getOrThrow<string>('EDGE_LOCATION_ID');
  }

  get deviceId(): string {
    return this.config.getOrThrow<string>('EDGE_DEVICE_ID');
  }

  get storeRoot(): string {
    return this.config.getOrThrow<string>('EDGE_STORE_ROOT');
  }

  get cloudBaseUrl(): string | undefined {
    return this.str('EDGE_CLOUD_BASE_URL');
  }

  get cloudToken(): string | undefined {
    return this.str('EDGE_CLOUD_TOKEN');
  }

  get syncIntervalMs(): number {
    return this.num('EDGE_SYNC_INTERVAL_MS', 15_000);
  }

  get syncBatchSize(): number {
    return this.num('EDGE_SYNC_BATCH_SIZE', 50);
  }

  get syncMaxAttempts(): number {
    return this.num('EDGE_SYNC_MAX_ATTEMPTS', 8);
  }

  get syncBackoffBaseMs(): number {
    return this.num('EDGE_SYNC_BACKOFF_BASE_MS', 1_000);
  }

  get syncBackoffMaxMs(): number {
    return this.num('EDGE_SYNC_BACKOFF_MAX_MS', 300_000);
  }

  get outboxMaxEntries(): number {
    return this.num('EDGE_OUTBOX_MAX_ENTRIES', 10_000);
  }

  get reviewConfidenceThreshold(): number {
    return this.num('EDGE_REVIEW_CONFIDENCE_THRESHOLD', 0.75);
  }

  get heartbeatIntervalMs(): number {
    return this.num('EDGE_HEARTBEAT_INTERVAL_MS', 30_000);
  }

  get opsPort(): number {
    return this.num('EDGE_OPS_PORT', 3100);
  }

  /**
   * Loopback by default. The metrics snapshot describes the store's state and
   * is unauthenticated, so it must not be reachable from the shop floor
   * network unless an operator deliberately widens the bind address.
   */
  get opsBindAddress(): string {
    return this.str('EDGE_OPS_BIND_ADDRESS') ?? '127.0.0.1';
  }

  get drivers(): DriverSelection[] {
    const raw = this.str('EDGE_DRIVERS');
    if (raw === undefined) {
      return [];
    }
    return raw.split(',').map((pair) => {
      const [kind, adapterKey] = pair.split(':');
      return { kind, adapterKey };
    });
  }
}
