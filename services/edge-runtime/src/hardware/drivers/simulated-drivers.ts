import {
  AnyEdgeDriver,
  CameraDriver,
  DriverFactory,
  EslDriver,
  GateDriver,
  PosPeripheralDriver,
  ScaleDriver,
} from '../hardware.port';

/**
 * Simulated drivers for every device kind.
 *
 * They exist so the runtime's tests — and a development node on a desk — need
 * no hardware at all, and so disconnect and reconnect behaviour can be
 * exercised deterministically. Each one can be told to fail, which is how the
 * registry's reconnect path is tested without unplugging anything.
 */
abstract class SimulatedDriver {
  readonly adapterKey = 'simulated';
  readonly version = '1.0.0';

  /** Set true to make connect() and ping() throw, simulating a fault. */
  faulty = false;
  connected = false;

  constructor(readonly deviceId: string) {}

  async checkReady(): Promise<boolean> {
    return !this.faulty;
  }

  async connect(): Promise<void> {
    if (this.faulty) {
      throw new Error('simulated device unreachable');
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async ping(): Promise<void> {
    if (this.faulty || !this.connected) {
      throw new Error('simulated device unreachable');
    }
  }
}

export class SimulatedCameraDriver
  extends SimulatedDriver
  implements CameraDriver
{
  readonly kind = 'camera' as const;

  async describeStream(): Promise<{
    width: number;
    height: number;
    framesPerSecond: number;
  }> {
    await this.ping();
    return { width: 640, height: 360, framesPerSecond: 15 };
  }
}

export class SimulatedScaleDriver extends SimulatedDriver implements ScaleDriver {
  readonly kind = 'scale' as const;

  private grams = 0;

  /** Test seam: stage the next reading. */
  setWeightGrams(grams: number): void {
    this.grams = grams;
  }

  async readWeightGrams(): Promise<number> {
    await this.ping();
    return this.grams;
  }

  async tare(): Promise<void> {
    await this.ping();
    this.grams = 0;
  }
}

export class SimulatedEslDriver extends SimulatedDriver implements EslDriver {
  readonly kind = 'esl' as const;

  readonly rendered = new Map<string, Readonly<Record<string, string>>>();

  async render(
    labelId: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.ping();
    this.rendered.set(labelId, { ...fields });
  }
}

export class SimulatedGateDriver extends SimulatedDriver implements GateDriver {
  readonly kind = 'gate' as const;

  private gate: 'OPEN' | 'CLOSED' = 'CLOSED';

  async open(): Promise<void> {
    await this.ping();
    this.gate = 'OPEN';
  }

  async close(): Promise<void> {
    await this.ping();
    this.gate = 'CLOSED';
  }

  async state(): Promise<'OPEN' | 'CLOSED'> {
    await this.ping();
    return this.gate;
  }
}

export class SimulatedPosPeripheralDriver
  extends SimulatedDriver
  implements PosPeripheralDriver
{
  readonly kind = 'pos' as const;

  readonly printed: string[][] = [];
  drawerOpenCount = 0;

  async printLines(lines: readonly string[]): Promise<void> {
    await this.ping();
    this.printed.push([...lines]);
  }

  async openDrawer(): Promise<void> {
    await this.ping();
    this.drawerOpenCount += 1;
  }
}

export const SIMULATED_DRIVER_FACTORIES: readonly DriverFactory[] = [
  {
    kind: 'camera',
    adapterKey: 'simulated',
    create: (deviceId): AnyEdgeDriver => new SimulatedCameraDriver(deviceId),
  },
  {
    kind: 'scale',
    adapterKey: 'simulated',
    create: (deviceId): AnyEdgeDriver => new SimulatedScaleDriver(deviceId),
  },
  {
    kind: 'esl',
    adapterKey: 'simulated',
    create: (deviceId): AnyEdgeDriver => new SimulatedEslDriver(deviceId),
  },
  {
    kind: 'gate',
    adapterKey: 'simulated',
    create: (deviceId): AnyEdgeDriver => new SimulatedGateDriver(deviceId),
  },
  {
    kind: 'pos',
    adapterKey: 'simulated',
    create: (deviceId): AnyEdgeDriver => new SimulatedPosPeripheralDriver(deviceId),
  },
];
