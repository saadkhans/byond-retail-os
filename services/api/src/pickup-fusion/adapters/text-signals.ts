import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  LuminanceSource,
  MultiFormatReader,
} from '@zxing/library';
import { RgbImage } from '../../pickup-detection/analysis/product-matcher';
import { BarcodeReader, BarcodeResult, OcrReader, OcrResult } from '../ports';
import { normalizeText } from '../primitives';

// ------------------------------------------------------------ barcode

/** ZXing luminance source over our RGB24 buffers. */
class RgbLuminanceSource extends LuminanceSource {
  private readonly luminances: Uint8ClampedArray;

  constructor(private readonly image: RgbImage) {
    super(image.width, image.height);
    this.luminances = new Uint8ClampedArray(image.width * image.height);
    for (let index = 0; index < this.luminances.length; index += 1) {
      this.luminances[index] =
        (image.rgb[index * 3] * 299 +
          image.rgb[index * 3 + 1] * 587 +
          image.rgb[index * 3 + 2] * 114) /
        1000;
    }
  }

  override getRow(y: number, row?: Uint8ClampedArray): Uint8ClampedArray {
    const out = row && row.length >= this.getWidth() ? row : new Uint8ClampedArray(this.getWidth());
    out.set(this.luminances.subarray(y * this.getWidth(), (y + 1) * this.getWidth()));
    return out;
  }

  override getMatrix(): Uint8ClampedArray {
    return this.luminances;
  }

  override isCropSupported(): boolean {
    return false;
  }

  override crop(): LuminanceSource {
    throw new Error('crop not supported');
  }

  override isRotateSupported(): boolean {
    return false;
  }

  override invert(): LuminanceSource {
    throw new Error('invert not supported');
  }

  override rotateCounterClockwise(): LuminanceSource {
    throw new Error('rotate not supported');
  }

  override rotateCounterClockwise45(): LuminanceSource {
    throw new Error('rotate not supported');
  }
}

/**
 * Real 1D/2D barcode decoding (ZXing, pure JS) over the selected frames
 * and crops — EAN/UPC/Code128/QR out of the box. A decode is the single
 * strongest identification signal fusion can receive.
 */
@Injectable()
export class ZxingBarcodeReader implements BarcodeReader {
  readonly adapterKey = 'zxing';
  readonly version = '1.0.0';

  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  read(
    images: { image: RgbImage; timestampMs: number }[],
  ): Promise<BarcodeResult[]> {
    const reader = new MultiFormatReader();
    reader.setHints(new Map([[DecodeHintType.TRY_HARDER, true]]) as never);
    const results: BarcodeResult[] = [];
    const seen = new Set<string>();
    for (const { image, timestampMs } of images) {
      try {
        const bitmap = new BinaryBitmap(
          new HybridBinarizer(new RgbLuminanceSource(image)),
        );
        const decoded = reader.decodeWithState(bitmap);
        const value = decoded.getText();
        if (!seen.has(value)) {
          seen.add(value);
          results.push({
            value,
            format: String(decoded.getBarcodeFormat()),
            timestampMs,
          });
        }
      } catch {
        // NotFound is the normal case for frames without a visible code.
      }
    }
    return Promise.resolve(results);
  }
}

// ------------------------------------------------------------ OCR

const TESSERACT_BINARY = 'tesseract';
const OCR_TIMEOUT_MS = 20_000;

function runTesseract(png: Buffer, languages: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      TESSERACT_BINARY,
      ['stdin', 'stdout', '-l', languages],
      {
        encoding: 'buffer',
        maxBuffer: 1024 * 1024,
        timeout: OCR_TIMEOUT_MS,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(stdout.toString('utf8'));
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(png);
  });
}

/** Minimal PNG encoder for OCR input (grayscale8, no filters), reusing
 *  zlib — keeps the OCR path dependency-free. */
import { deflateSync } from 'node:zlib';

function crc32(bytes: Buffer): number {
  let table: number[] | null = (crc32 as unknown as { t?: number[] }).t ?? null;
  if (!table) {
    table = [];
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    (crc32 as unknown as { t?: number[] }).t = table;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, crc]);
}

export function encodeGrayPng(image: RgbImage): Buffer {
  const { width, height, rgb } = image;
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const off = (y * width + x) * 3;
      raw[y * (width + 1) + 1 + x] = Math.round(
        0.299 * rgb[off] + 0.587 * rgb[off + 1] + 0.114 * rgb[off + 2],
      );
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Color PNG encoder (truecolor8) — VLM image payloads. */
export function encodeRgbPng(image: RgbImage): Buffer {
  const { width, height, rgb } = image;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(
      raw,
      y * (width * 3 + 1) + 1,
      y * width * 3,
      (y + 1) * width * 3,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Classified OCR execution status — the same pattern as the VLM verdict
 * classification: a fixed code only, NEVER raw error text (an execFile
 * error message can embed command output or filesystem paths). 'OK'
 * includes a successful pass that simply saw no text; every other value
 * means the OCR stage DID NOT complete, so its empty text must not be
 * treated as a verified "no text on the product" observation.
 * - UNAVAILABLE: tesseract (or every language pack) is missing.
 * - TIMEOUT: the process was killed at the OCR deadline.
 * - EXECUTION_FAILED: tesseract started but exited abnormally.
 */
export type OcrExecutionStatus =
  | 'OK'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'EXECUTION_FAILED';

/** The port's OcrResult plus the classified execution status. */
export interface ClassifiedOcrResult extends OcrResult {
  status: OcrExecutionStatus;
}

/** Maps an execFile failure onto the classified vocabulary. execFile's
 *  own timeout kills the child (error.killed / a kill signal); a missing
 *  binary surfaces as ENOENT. Everything else is an abnormal exit. */
export function classifyOcrFailure(error: unknown): OcrExecutionStatus {
  const failure = error as {
    killed?: boolean;
    signal?: string | null;
    code?: string | number | null;
  } | null;
  if (
    failure?.killed === true ||
    failure?.signal === 'SIGTERM' ||
    failure?.signal === 'SIGKILL'
  ) {
    return 'TIMEOUT';
  }
  if (failure?.code === 'ENOENT') {
    return 'UNAVAILABLE';
  }
  return 'EXECUTION_FAILED';
}

/**
 * Local OCR through the SAME system tesseract the screening pipeline
 * already requires. Languages: English always; Arabic joins automatically
 * when the `ara` traineddata is installed (checked once per process).
 * Output is normalized (Latin case-fold + Arabic diacritic/letter-form
 * normalization) for catalog-field comparison.
 */
@Injectable()
export class TesseractOcrReader implements OcrReader {
  readonly adapterKey = 'tesseract-local';
  readonly version = '1.0.0';

  private availableLanguages: string[] | null = null;

  async checkReady(): Promise<boolean> {
    return (await this.languages()).length > 0;
  }

  private async languages(): Promise<string[]> {
    if (this.availableLanguages) {
      return this.availableLanguages;
    }
    const list = await new Promise<string>((resolvePromise) => {
      execFile(
        TESSERACT_BINARY,
        ['--list-langs'],
        { timeout: 10_000, windowsHide: true, shell: false },
        (error, stdout) => resolvePromise(error ? '' : String(stdout)),
      );
    });
    const langs: string[] = [];
    if (/^eng$/m.test(list)) langs.push('eng');
    if (/^ara$/m.test(list)) langs.push('ara');
    this.availableLanguages = langs;
    return langs;
  }

  async recognize(image: RgbImage): Promise<ClassifiedOcrResult> {
    const languages = await this.languages();
    if (languages.length === 0) {
      // No tesseract / no language packs: the stage is UNAVAILABLE — a
      // classified state, not a successful "no text" pass.
      return { rawText: '', normalizedText: '', languages: [], status: 'UNAVAILABLE' };
    }
    try {
      const rawText = await runTesseract(
        encodeGrayPng(image),
        languages.join('+'),
      );
      return {
        rawText: rawText.trim(),
        normalizedText: normalizeText(rawText),
        languages,
        status: 'OK',
      };
    } catch (error) {
      // Timeout/crash must stay distinguishable from a no-text pass —
      // fusion demotes AUTO_PROPOSE when this advertised stage never ran.
      // Classified code only; the raw error text is never propagated.
      return {
        rawText: '',
        normalizedText: '',
        languages,
        status: classifyOcrFailure(error),
      };
    }
  }
}
