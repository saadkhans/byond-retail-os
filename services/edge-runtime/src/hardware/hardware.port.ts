/**
 * The hardware abstraction layer.
 *
 * ARCHITECTURE.md: "Cameras, scales, ESLs, POS hardware, and gates sit behind
 * hardware abstraction interfaces in the edge runtime. Supporting a new vendor
 * means writing a new driver, not touching core logic." So every port here is
 * owned by this repository, carries `adapterKey` and `version` like the CV
 * ports do, and no vendor type appears in any signature.
 *
 * A driver is allowed to be absent or broken. `checkReady()` reporting false
 * must degrade the runtime, never fabricate a reading.
 */

export type DeviceKind = 'camera' | 'scale' | 'esl' | 'gate' | 'pos';

export type ConnectionState = 'CONNECTED' | 'DISCONNECTED' | 'DEGRADED';

export interface DriverHealth {
  readonly deviceId: string;
  readonly kind: DeviceKind;
  readonly adapterKey: string;
  readonly state: ConnectionState;
  readonly lastSeenAt: string | null;
  readonly consecutiveFailures: number;
  /** Error CLASS of the most recent failure — never a message with detail. */
  readonly lastErrorClass?: string;
}

export interface EdgeDriver {
  readonly kind: DeviceKind;
  readonly deviceId: string;
  readonly adapterKey: string;
  readonly version: string;

  checkReady(): Promise<boolean>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Cheap liveness probe run on every heartbeat. */
  ping(): Promise<void>;
}

/**
 * Cameras. Frame transport and tracking belong to the CV pipeline service;
 * the edge runtime only needs to know a camera exists, is reachable, and what
 * it is pointed at.
 */
export interface CameraDriver extends EdgeDriver {
  readonly kind: 'camera';
  describeStream(): Promise<{
    readonly width: number;
    readonly height: number;
    readonly framesPerSecond: number;
  }>;
}

export interface ScaleDriver extends EdgeDriver {
  readonly kind: 'scale';
  readWeightGrams(): Promise<number>;
  tare(): Promise<void>;
}

/**
 * Electronic shelf labels. `render` takes already-resolved display fields, so
 * the driver never needs to know how a price was decided — the pricing phase
 * supplies the values through this same call.
 */
export interface EslDriver extends EdgeDriver {
  readonly kind: 'esl';
  render(
    labelId: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<void>;
}

export interface GateDriver extends EdgeDriver {
  readonly kind: 'gate';
  open(): Promise<void>;
  close(): Promise<void>;
  state(): Promise<'OPEN' | 'CLOSED'>;
}

/** Receipt printers, cash drawers and similar point-of-sale peripherals. */
export interface PosPeripheralDriver extends EdgeDriver {
  readonly kind: 'pos';
  printLines(lines: readonly string[]): Promise<void>;
  openDrawer(): Promise<void>;
}

export type AnyEdgeDriver =
  | CameraDriver
  | ScaleDriver
  | EslDriver
  | GateDriver
  | PosPeripheralDriver;

export const DRIVER_FACTORIES = Symbol('DRIVER_FACTORIES');

export interface DriverFactory {
  readonly kind: DeviceKind;
  readonly adapterKey: string;
  create(deviceId: string): AnyEdgeDriver;
}
