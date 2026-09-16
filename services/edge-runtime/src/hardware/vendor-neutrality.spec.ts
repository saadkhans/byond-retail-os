import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { SIMULATED_DRIVER_FACTORIES } from './drivers/simulated-drivers';

/**
 * Pins the hardware-abstraction invariant this phase exists to establish.
 *
 * ARCHITECTURE.md: "Cameras, scales, ESLs, POS hardware, and gates sit behind
 * hardware abstraction interfaces in the edge runtime. Supporting a new vendor
 * means writing a new driver, not touching core logic." AGENTS.md says the same
 * from the other side: "Do not hardcode one LLM, CV model, ERP, POS, payment
 * provider, ESL vendor, or hardware vendor."
 *
 * That is an invariant about the whole service, not about one file, so it is
 * checked by grep the way the API's inference and video-ingest modules check
 * theirs. A vendor name in a port signature, a driver selected by brand, or a
 * vendor SDK in `dependencies` all fail here — long before a reviewer has to
 * notice it by eye.
 */
describe('edge runtime hardware vendor neutrality', () => {
  /**
   * Device vendors and their SDK/protocol markers, across every kind the HAL
   * covers: cameras, scales, electronic shelf labels, gates and point-of-sale
   * peripherals. Tokens are deliberately distinctive — a short one such as
   * "ncr" or "elo" is a substring of ordinary English ("increment", "below")
   * and would fail on innocent prose.
   */
  const FORBIDDEN = [
    // Cameras and vision hardware.
    'hikvision',
    'dahua',
    'hanwha',
    'axis communications',
    'basler',
    'luxonis',
    'realsense',
    'jetson',
    'nvidia',
    'deepstream',
    'gstreamer',
    'ffmpeg',
    'hailo',
    'ambarella',
    'onvif',
    // Scales.
    'mettler',
    'toledo',
    'bizerba',
    'berkel',
    'datalogic',
    'shinko',
    // Electronic shelf labels.
    'imagotag',
    'vusion',
    'pricer',
    'hanshow',
    'displaydata',
    'altierre',
    'solum newton',
    // Gates and access control.
    'gunnebo',
    'boon edam',
    'dormakaba',
    'nedap',
    'fastlane',
    // Point-of-sale peripherals and payment terminals.
    'verifone',
    'ingenico',
    'epson',
    'star micronics',
    'diebold',
    'toshiba',
    'zebra',
    'honeywell',
    'opticon',
    'escpos',
    'esc/pos',
  ];

  /** Packages that would put a vendor transport inside this service. */
  const FORBIDDEN_DEPENDENCIES = [
    'serialport',
    'node-hid',
    'usb',
    'onvif',
    'escpos',
    'modbus',
    'node-thermal-printer',
    'rtsp',
  ];

  const sourceRoot = join(__dirname, '..');

  const collectSources = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...collectSources(full));
      } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
    return files;
  };

  const sources = collectSources(sourceRoot);

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it.each(sources.map((file) => [relative(sourceRoot, file)]))(
    'keeps src/%s free of vendor-specific names',
    (file) => {
      const source = readFileSync(join(sourceRoot, file), 'utf8').toLowerCase();
      for (const vendor of FORBIDDEN) {
        expect(source).not.toContain(vendor);
      }
    },
  );

  it('keeps vendor SDKs and device transports out of the dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(join(sourceRoot, '..', 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ].map((name) => name.toLowerCase());
    for (const name of names) {
      for (const vendor of [...FORBIDDEN, ...FORBIDDEN_DEPENDENCIES]) {
        expect(name).not.toContain(vendor);
      }
    }
  });

  /**
   * "Supporting a new vendor means writing a new driver, not touching core
   * logic" only holds while core logic cannot see a concrete driver. The
   * composition root wires one; nothing else may import one.
   */
  it('lets only the hardware module import a concrete driver', () => {
    const driversDir = join(sourceRoot, 'hardware', 'drivers');
    const importers = sources.filter(
      (file) =>
        !file.startsWith(driversDir + sep) &&
        /from '.*drivers\//.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((file) => relative(sourceRoot, file))).toEqual([
      join('hardware', 'hardware.module.ts'),
    ]);
  });

  /**
   * Every kind in the HAL ships a driver that needs no hardware, which is what
   * lets the whole suite run with no devices, no network and no database.
   */
  it('ships a simulated driver for every device kind the port declares', () => {
    const port = readFileSync(join(sourceRoot, 'hardware', 'hardware.port.ts'), 'utf8');
    const union = /export type DeviceKind =([^;]+);/.exec(port);
    expect(union).not.toBeNull();
    const declared = [...(union?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    const simulated = SIMULATED_DRIVER_FACTORIES.map((factory) => factory.kind);
    expect([...simulated].sort()).toEqual([...declared].sort());
    for (const factory of SIMULATED_DRIVER_FACTORIES) {
      expect(factory.adapterKey).toBe('simulated');
    }
  });
});
