import { Inject, Injectable } from '@nestjs/common';
import { EdgeConfigService } from '../config/edge-config.service';
import { StructuredLogger, errorClass } from '../logging/structured-logger';
import { OutboxService } from '../sync/outbox.service';
import {
  AnyEdgeDriver,
  ConnectionState,
  DRIVER_FACTORIES,
  DeviceKind,
  DriverFactory,
  DriverHealth,
} from './hardware.port';

interface DriverEntry {
  readonly driver: AnyEdgeDriver;
  state: ConnectionState;
  lastSeenAt: string | null;
  consecutiveFailures: number;
  lastErrorClass?: string;
}

/**
 * Registry, heartbeat and reconnect for every attached device.
 *
 * Disconnect behaviour is deliberate: a failing device degrades to
 * DISCONNECTED and the runtime keeps going. A store does not stop trading
 * because a shelf label lost power, so nothing here throws into the caller's
 * path — failures surface through health and the metrics snapshot.
 */
@Injectable()
export class DriverRegistryService {
  private readonly entries = new Map<string, DriverEntry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIVER_FACTORIES) private readonly factories: readonly DriverFactory[],
    private readonly config: EdgeConfigService,
    private readonly outbox: OutboxService,
    private readonly logger: StructuredLogger,
  ) {}

  private static key(kind: DeviceKind, deviceId: string): string {
    return `${kind}:${deviceId}`;
  }

  /** Instantiates the drivers named by EDGE_DRIVERS. Unknown pairs are logged. */
  registerConfigured(): void {
    for (const selection of this.config.drivers) {
      const factory = this.factories.find(
        (candidate) =>
          candidate.kind === selection.kind &&
          candidate.adapterKey === selection.adapterKey,
      );
      if (factory === undefined) {
        this.logger.detail(
          'warn',
          'no driver registered for configured device',
          { kind: selection.kind, adapterKey: selection.adapterKey },
          'DriverRegistryService',
        );
        continue;
      }
      const deviceId = `${this.config.deviceId}-${selection.kind}`;
      this.register(factory.create(deviceId));
    }
  }

  register(driver: AnyEdgeDriver): void {
    this.entries.set(DriverRegistryService.key(driver.kind, driver.deviceId), {
      driver,
      state: 'DISCONNECTED',
      lastSeenAt: null,
      consecutiveFailures: 0,
    });
  }

  get<T extends AnyEdgeDriver>(kind: DeviceKind, deviceId: string): T | null {
    const entry = this.entries.get(DriverRegistryService.key(kind, deviceId));
    return entry === undefined ? null : (entry.driver as T);
  }

  first<T extends AnyEdgeDriver>(kind: DeviceKind): T | null {
    for (const entry of this.entries.values()) {
      if (entry.driver.kind === kind) {
        return entry.driver as T;
      }
    }
    return null;
  }

  async connectAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => this.connectOne(entry)),
    );
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        try {
          await entry.driver.disconnect();
        } catch {
          // Shutdown must not be blocked by a device that is already gone.
        }
        entry.state = 'DISCONNECTED';
      }),
    );
  }

  /**
   * Attempts a connection. On success the entry is marked healthy; on failure
   * only the error class is recorded, leaving the CALLER to decide what the
   * failure means — a first missed ping is a blip, a second is an outage.
   */
  private async tryConnect(entry: DriverEntry): Promise<boolean> {
    try {
      await entry.driver.connect();
      entry.state = 'CONNECTED';
      entry.lastSeenAt = new Date().toISOString();
      entry.consecutiveFailures = 0;
      delete entry.lastErrorClass;
      return true;
    } catch (cause) {
      entry.lastErrorClass = errorClass(cause);
      return false;
    }
  }

  private async connectOne(entry: DriverEntry): Promise<void> {
    if (await this.tryConnect(entry)) {
      return;
    }
    entry.state = 'DISCONNECTED';
    entry.consecutiveFailures += 1;
  }

  /**
   * One heartbeat round: ping every device, reconnect the ones that failed,
   * and forward a health fact to the cloud.
   */
  async heartbeat(): Promise<ReadonlyArray<DriverHealth>> {
    for (const entry of this.entries.values()) {
      try {
        await entry.driver.ping();
        entry.state = 'CONNECTED';
        entry.lastSeenAt = new Date().toISOString();
        entry.consecutiveFailures = 0;
        delete entry.lastErrorClass;
      } catch (cause) {
        entry.consecutiveFailures += 1;
        entry.lastErrorClass = errorClass(cause);
        if (await this.tryConnect(entry)) {
          continue;
        }
        // One missed ping is a blip; a second means the device is gone.
        entry.state =
          entry.consecutiveFailures === 1 ? 'DEGRADED' : 'DISCONNECTED';
      }
    }
    const snapshot = this.health();
    const observedAt = new Date().toISOString();
    await this.outbox.enqueue({
      type: 'DEVICE_HEARTBEAT',
      idempotencyKey: `heartbeat:${this.config.deviceId}:${observedAt}`,
      occurredAt: observedAt,
      payload: { deviceId: this.config.deviceId, devices: snapshot },
    });
    return snapshot;
  }

  health(): ReadonlyArray<DriverHealth> {
    return [...this.entries.values()]
      .map((entry) => ({
        deviceId: entry.driver.deviceId,
        kind: entry.driver.kind,
        adapterKey: entry.driver.adapterKey,
        state: entry.state,
        lastSeenAt: entry.lastSeenAt,
        consecutiveFailures: entry.consecutiveFailures,
        ...(entry.lastErrorClass === undefined
          ? {}
          : { lastErrorClass: entry.lastErrorClass }),
      }))
      .sort((left, right) =>
        `${left.kind}:${left.deviceId}`.localeCompare(
          `${right.kind}:${right.deviceId}`,
        ),
      );
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.heartbeat().catch((cause) => {
        this.logger.failure('heartbeat failed', cause, 'DriverRegistryService');
      });
    }, this.config.heartbeatIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
