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

  // Each optional system-binary name is confined to its adapter file plus
  // the module wiring that selects it behind its env opt-in
  // (VIDEO_FFMPEG_ENABLED / VIDEO_OCR_ENABLED) — the strings may appear
  // nowhere else.
  const OPTIONAL_BINARY_CONFINEMENT: Record<string, string[]> = {
    ffmpeg: ['ffmpeg-extractor.adapter.ts', 'video-ingest.module.ts'],
    ffprobe: ['ffmpeg-extractor.adapter.ts', 'video-ingest.module.ts'],
    tesseract: ['tesseract-recognizer.adapter.ts', 'video-ingest.module.ts'],
  };

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
      // Each optional-system-binary name is confined to its adapter file
      // and the module wiring. The OPERATOR-FACING opt-in flag names
      // (VIDEO_FFMPEG_ENABLED, VIDEO_OCR_ENABLED) are different: they are
      // documented public configuration surface (README, Swagger, the
      // controlled 503s naming them), so referencing a FLAG is allowed
      // anywhere — only the binary names themselves stay confined.
      const neutralized = source
        .split('video_ffmpeg_enabled')
        .join('')
        .split('video_ocr_enabled')
        .join('');
      for (const [binary, allowedFiles] of Object.entries(
        OPTIONAL_BINARY_CONFINEMENT,
      )) {
        if (!allowedFiles.includes(basename(file))) {
          expect(neutralized).not.toContain(binary);
        }
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
    for (const vendor of [
      ...FORBIDDEN,
      'ffmpeg',
      'fluent-ffmpeg',
      'opencv4nodejs',
      'tesseract',
    ]) {
      for (const name of dependencyNames) {
        expect(name).not.toContain(vendor);
      }
    }
  });
});
