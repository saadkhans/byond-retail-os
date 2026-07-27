import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Pins the Phase 10 provider-neutrality invariant: the video-ingest core
 * (storage port, extraction port, service, controllers, DTOs) never names a
 * production camera/streaming/model/queue vendor or runtime, and no runtime
 * media/broker npm dependency exists. The ONE sanctioned exception is the
 * OPTIONAL local system-binary adapter file, which necessarily names the
 * ffmpeg/ffprobe binaries it shells out to (behind an env opt-in, args as a
 * vector, no shell) — that string may appear NOWHERE else.
 */
describe('video-ingest module vendor neutrality', () => {
  const FORBIDDEN = [
    'nvidia',
    'deepstream',
    'triton',
    'gstreamer',
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

  // The adapter itself plus the module wiring that selects it behind the
  // VIDEO_FFMPEG_ENABLED opt-in — the string may appear nowhere else.
  const OPTIONAL_BINARY_FILES = [
    'ffmpeg-extractor.adapter.ts',
    'video-ingest.module.ts',
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
      // The optional-system-binary name is confined to its adapter file
      // and the module wiring.
      if (!OPTIONAL_BINARY_FILES.includes(basename(file))) {
        expect(source).not.toContain('ffmpeg');
        expect(source).not.toContain('ffprobe');
      }
    },
  );

  it('keeps the API free of runtime media/broker dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const dependencyNames = Object.keys(packageJson.dependencies ?? {}).map(
      (name) => name.toLowerCase(),
    );
    for (const vendor of [...FORBIDDEN, 'ffmpeg', 'fluent-ffmpeg', 'opencv4nodejs']) {
      for (const name of dependencyNames) {
        expect(name).not.toContain(vendor);
      }
    }
  });
});
