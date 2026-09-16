import { fakeConfig, silentLogger, temporaryStore } from '../../test/helpers';
import { LOGS } from '../store/store-names';
import { OutboxService } from '../sync/outbox.service';
import { OutboxOperation } from '../sync/sync.types';
import { DriverRegistryService } from './driver-registry.service';
import {
  SIMULATED_DRIVER_FACTORIES,
  SimulatedEslDriver,
  SimulatedGateDriver,
  SimulatedPosPeripheralDriver,
  SimulatedScaleDriver,
} from './drivers/simulated-drivers';

describe('DriverRegistryService', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;
  let outbox: OutboxService;

  function registry(drivers?: string): DriverRegistryService {
    const config = fakeConfig(
      drivers === undefined ? {} : { EDGE_DRIVERS: drivers },
    );
    return new DriverRegistryService(
      SIMULATED_DRIVER_FACTORIES,
      config,
      outbox,
      silentLogger(),
    );
  }

  beforeEach(async () => {
    context = await temporaryStore();
    outbox = new OutboxService(context.store, fakeConfig());
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('registers every configured driver kind', async () => {
    const registered = registry(
      'camera:simulated,scale:simulated,esl:simulated,gate:simulated,pos:simulated',
    );
    registered.registerConfigured();
    await registered.connectAll();
    expect(registered.health().map((entry) => entry.kind)).toEqual([
      'camera',
      'esl',
      'gate',
      'pos',
      'scale',
    ]);
    expect(
      registered.health().every((entry) => entry.state === 'CONNECTED'),
    ).toBe(true);
  });

  it('skips an unknown adapter without taking the runtime down', () => {
    const registered = registry('camera:acme-vendor');
    registered.registerConfigured();
    expect(registered.health()).toEqual([]);
  });

  it('reports a device that will not connect as disconnected', async () => {
    const registered = registry();
    const scale = new SimulatedScaleDriver('scale-1');
    scale.faulty = true;
    registered.register(scale);
    await registered.connectAll();
    const [health] = registered.health();
    expect(health.state).toBe('DISCONNECTED');
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastErrorClass).toBe('Error');
  });

  it('degrades on the first missed ping and disconnects on the second', async () => {
    const registered = registry();
    const gate = new SimulatedGateDriver('gate-1');
    registered.register(gate);
    await registered.connectAll();

    gate.faulty = true;
    await registered.heartbeat();
    expect(registered.health()[0].state).toBe('DEGRADED');

    await registered.heartbeat();
    expect(registered.health()[0].state).toBe('DISCONNECTED');
  });

  it('reconnects automatically once the device comes back', async () => {
    const registered = registry();
    const esl = new SimulatedEslDriver('esl-1');
    registered.register(esl);
    await registered.connectAll();

    esl.faulty = true;
    await registered.heartbeat();
    await registered.heartbeat();
    expect(registered.health()[0].state).toBe('DISCONNECTED');

    esl.faulty = false;
    await registered.heartbeat();
    const [health] = registered.health();
    expect(health.state).toBe('CONNECTED');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastErrorClass).toBeUndefined();
  });

  it('forwards a heartbeat fact to the cloud', async () => {
    const registered = registry();
    registered.register(new SimulatedScaleDriver('scale-1'));
    await registered.connectAll();
    await registered.heartbeat();
    const entries = await context.store.read<OutboxOperation>(LOGS.outbox, 0, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].entry.type).toBe('DEVICE_HEARTBEAT');
  });

  it('disconnects everything on shutdown, even a faulty device', async () => {
    const registered = registry();
    const pos = new SimulatedPosPeripheralDriver('pos-1');
    registered.register(pos);
    await registered.connectAll();
    pos.faulty = true;
    await expect(registered.disconnectAll()).resolves.toBeUndefined();
    expect(registered.health()[0].state).toBe('DISCONNECTED');
  });

  it('exposes drivers by kind for the callers that need one', async () => {
    const registered = registry();
    const esl = new SimulatedEslDriver('esl-1');
    registered.register(esl);
    await registered.connectAll();
    const found = registered.first<SimulatedEslDriver>('esl');
    expect(found).toBe(esl);
    expect(registered.get('esl', 'esl-1')).toBe(esl);
    expect(registered.get('esl', 'missing')).toBeNull();
    expect(registered.first('camera')).toBeNull();
  });
});

describe('simulated drivers', () => {
  it('serve readings only while connected', async () => {
    const scale = new SimulatedScaleDriver('scale-1');
    await expect(scale.readWeightGrams()).rejects.toThrow(/unreachable/);
    await scale.connect();
    scale.setWeightGrams(450);
    await expect(scale.readWeightGrams()).resolves.toBe(450);
    await scale.tare();
    await expect(scale.readWeightGrams()).resolves.toBe(0);
  });

  it('records what an electronic shelf label was asked to show', async () => {
    const esl = new SimulatedEslDriver('esl-1');
    await esl.connect();
    await esl.render('label-1', { price: '1.50', name: 'Water' });
    expect(esl.rendered.get('label-1')).toEqual({ price: '1.50', name: 'Water' });
  });

  it('tracks gate state and point-of-sale activity', async () => {
    const gate = new SimulatedGateDriver('gate-1');
    await gate.connect();
    await expect(gate.state()).resolves.toBe('CLOSED');
    await gate.open();
    await expect(gate.state()).resolves.toBe('OPEN');

    const pos = new SimulatedPosPeripheralDriver('pos-1');
    await pos.connect();
    await pos.printLines(['BYOND', 'Water 1.50']);
    await pos.openDrawer();
    expect(pos.printed).toEqual([['BYOND', 'Water 1.50']]);
    expect(pos.drawerOpenCount).toBe(1);
  });
});
