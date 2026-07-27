import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the Phase 9 provider-neutrality invariant: the inference core
 * (contracts, queue, adapters, service, controller) never names a specific
 * camera/detector/model/queue vendor or runtime. Vendors may appear in
 * docs as FUTURE adapters only — never in code identifiers or strings —
 * and no runtime ML/video/broker dependency exists.
 */
describe('inference module vendor neutrality', () => {
  const FORBIDDEN = [
    'nvidia',
    'deepstream',
    'triton',
    'gstreamer',
    'ffmpeg',
    'hailo',
    'ambarella',
    'yolo',
    'rt-detr',
    'ultralytics',
    'opencv',
    'pytorch',
    'paligemma',
    'paddleocr',
    'qwen',
    'celery',
    'redis',
    'kafka',
    'mqtt',
    'nats',
  ];

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

  it.each(collectSources(__dirname).map((file) => [file]))(
    'keeps %s free of vendor-specific names',
    (file) => {
      const source = readFileSync(file, 'utf8').toLowerCase();
      for (const vendor of FORBIDDEN) {
        expect(source).not.toContain(vendor);
      }
    },
  );

  it('keeps the API free of runtime ML/video/broker dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const dependencyNames = Object.keys(packageJson.dependencies ?? {}).map(
      (name) => name.toLowerCase(),
    );
    for (const vendor of FORBIDDEN) {
      for (const name of dependencyNames) {
        expect(name).not.toContain(vendor);
      }
    }
  });
});
