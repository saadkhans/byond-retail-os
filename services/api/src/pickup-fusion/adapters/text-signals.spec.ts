import { execFile } from 'node:child_process';
import { RgbImage } from '../../pickup-detection/analysis/product-matcher';
import { classifyOcrFailure, TesseractOcrReader } from './text-signals';

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

/**
 * OCR execution failures are CLASSIFIED, never collapsed into an empty
 * (success-looking) result: a Tesseract timeout/crash must stay
 * distinguishable from a genuine no-text pass, so fusion can refuse to
 * auto-propose past an advertised stage that never ran. Same pattern as
 * the VLM verdict classification — codes only, no raw error text.
 */

const execFileMock = execFile as unknown as jest.Mock;

const IMAGE: RgbImage = { width: 4, height: 4, rgb: Buffer.alloc(48, 100) };

describe('classifyOcrFailure', () => {
  it('a killed child (execFile timeout) classifies as TIMEOUT', () => {
    expect(
      classifyOcrFailure(
        Object.assign(new Error('spawn timed out'), { killed: true, signal: 'SIGTERM' }),
      ),
    ).toBe('TIMEOUT');
    expect(classifyOcrFailure({ killed: false, signal: 'SIGKILL' })).toBe('TIMEOUT');
  });

  it('a missing binary (ENOENT) classifies as UNAVAILABLE', () => {
    expect(
      classifyOcrFailure(Object.assign(new Error('spawn tesseract ENOENT'), { code: 'ENOENT' })),
    ).toBe('UNAVAILABLE');
  });

  it('anything else — abnormal exits included — classifies as EXECUTION_FAILED', () => {
    expect(classifyOcrFailure(Object.assign(new Error('boom'), { code: 1 }))).toBe(
      'EXECUTION_FAILED',
    );
    expect(classifyOcrFailure(null)).toBe('EXECUTION_FAILED');
    expect(classifyOcrFailure('weird')).toBe('EXECUTION_FAILED');
  });
});

describe('TesseractOcrReader.recognize returns classified statuses', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  function mockTesseract(options: {
    langs: string;
    ocr: (callback: (error: Error | null, stdout: Buffer | string) => void) => void;
  }) {
    execFileMock.mockImplementation(
      (
        _binary: string,
        args: string[],
        _opts: unknown,
        callback: (error: Error | null, stdout: Buffer | string) => void,
      ) => {
        if (args[0] === '--list-langs') {
          callback(null, options.langs);
          return {};
        }
        options.ocr(callback);
        return { stdin: { on: jest.fn(), end: jest.fn() } };
      },
    );
  }

  it('no installed language packs is UNAVAILABLE — not a success-looking empty pass', async () => {
    mockTesseract({ langs: 'List of available languages (0):\n', ocr: () => undefined });
    const reader = new TesseractOcrReader();
    await expect(reader.recognize(IMAGE)).resolves.toEqual({
      rawText: '',
      normalizedText: '',
      languages: [],
      status: 'UNAVAILABLE',
    });
  });

  it('a Tesseract timeout surfaces as a classified TIMEOUT with no raw error text', async () => {
    mockTesseract({
      langs: 'List of available languages (1):\neng\n',
      ocr: (callback) =>
        callback(
          Object.assign(new Error('/usr/bin/tesseract stdin stdout timed out'), {
            killed: true,
            signal: 'SIGTERM',
          }),
          Buffer.alloc(0),
        ),
    });
    const reader = new TesseractOcrReader();
    const result = await reader.recognize(IMAGE);
    expect(result.status).toBe('TIMEOUT');
    expect(result.rawText).toBe('');
    expect(result.normalizedText).toBe('');
    expect(result.languages).toEqual(['eng']);
    // Classified code only — the error message (which can embed command
    // output/paths) never appears anywhere in the result.
    expect(JSON.stringify(result)).not.toContain('tesseract stdin');
  });

  it('a crash classifies as EXECUTION_FAILED; a successful pass is OK with recognized text', async () => {
    mockTesseract({
      langs: 'List of available languages (1):\neng\n',
      ocr: (callback) =>
        callback(Object.assign(new Error('segfault'), { code: 139 }), Buffer.alloc(0)),
    });
    const failing = new TesseractOcrReader();
    await expect(failing.recognize(IMAGE)).resolves.toMatchObject({
      status: 'EXECUTION_FAILED',
      rawText: '',
    });

    mockTesseract({
      langs: 'List of available languages (1):\neng\n',
      ocr: (callback) => callback(null, Buffer.from('Spring Water 500ml\n', 'utf8')),
    });
    const succeeding = new TesseractOcrReader();
    await expect(succeeding.recognize(IMAGE)).resolves.toMatchObject({
      status: 'OK',
      rawText: 'Spring Water 500ml',
    });
  });
});
