import type {
  ClipLabReport,
  CvTestScenario,
  GroundTruthEventKind,
  Product,
  VideoAsset,
} from './api';

/**
 * Clip Lab batch upload — PURE helpers (no React, no fetch).
 *
 * A lab clip's file name carries everything the batch needs except the
 * grab instant: `r1_<cell>_<sku>_<type>_<light>_<n>.mp4`. These helpers
 * parse that name, turn it into a ground-truth SUGGESTION the operator
 * confirms, resolve the SKU token to a catalog product, mirror the
 * server's validation rules so a bad row never hits the API, and score
 * a finished run against the saved truth.
 */

export const CLIP_NAME_CELLS = ['a1', 'a2', 'b1', 'b2', 'rack'] as const;
export const CLIP_NAME_TYPES = ['pickup', 'return', 'touch', 'wrongcell', 'double', 'nothing'] as const;
export const CLIP_NAME_LIGHTS = ['room', 'fridge'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg'];

export type ClipNameCell = (typeof CLIP_NAME_CELLS)[number];
export type ClipNameType = (typeof CLIP_NAME_TYPES)[number];
export type ClipNameLight = (typeof CLIP_NAME_LIGHTS)[number];

export interface ParsedClipName {
  run: string;
  cell: ClipNameCell;
  skuToken: string;
  type: ClipNameType;
  light: ClipNameLight;
  index: number;
  extension: string;
}

export type ClipNameParseReason =
  | 'NOT_VIDEO'
  | 'WRONG_TOKEN_COUNT'
  | 'UNKNOWN_CELL'
  | 'UNKNOWN_TYPE'
  | 'UNKNOWN_LIGHT'
  | 'BAD_INDEX';

export type ClipNameParse =
  | { ok: true; parsed: ParsedClipName }
  | { ok: false; reason: ClipNameParseReason };

export const PARSE_REASON_LABELS: Record<ClipNameParseReason, string> = {
  NOT_VIDEO: 'not a video file',
  WRONG_TOKEN_COUNT: 'expected r1_cell_sku_type_light_nn',
  UNKNOWN_CELL: 'cell must be a1, a2, b1, b2 or rack',
  UNKNOWN_TYPE: 'type must be pickup, return, touch, wrongcell, double or nothing',
  UNKNOWN_LIGHT: 'light must be room or fridge',
  BAD_INDEX: 'last token must be a number',
};

/** Strips any folder prefix (either separator). */
export function baseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return cut >= 0 ? name.slice(cut + 1) : name;
}

/** Lowercased ".ext" (last dot), or '' when the name has no extension. */
export function extensionOf(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot <= 0 || dot === base.length - 1 ? '' : base.slice(dot).toLowerCase();
}

export function isVideoFilename(name: string): boolean {
  return VIDEO_EXTENSIONS.includes(extensionOf(name));
}

/**
 * Mirrors the server's display sanitizer (`sanitizeOriginalFilename` in
 * video-ingest/media-safety.ts): anything outside [A-Za-z0-9._-] becomes
 * '_', keep the last 160 chars. Used ONLY to match already-uploaded
 * assets by name when a batch is resumed.
 */
export function sanitizeFilenameLikeServer(name: string): string {
  const sanitized = baseName(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length > 160 ? sanitized.slice(-160) : sanitized;
}

export function parseClipFilename(name: string): ClipNameParse {
  const base = baseName(name);
  if (!isVideoFilename(base)) {
    return { ok: false, reason: 'NOT_VIDEO' };
  }
  const extension = extensionOf(base);
  const stem = base.slice(0, base.length - extension.length).toLowerCase();
  const tokens = stem.split(/[_-]/).filter((token) => token.length > 0);
  if (tokens.length !== 6) {
    return { ok: false, reason: 'WRONG_TOKEN_COUNT' };
  }
  const [run, cell, skuToken, type, light, index] = tokens;
  if (!(CLIP_NAME_CELLS as readonly string[]).includes(cell)) {
    return { ok: false, reason: 'UNKNOWN_CELL' };
  }
  if (!(CLIP_NAME_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: 'UNKNOWN_TYPE' };
  }
  if (!(CLIP_NAME_LIGHTS as readonly string[]).includes(light)) {
    return { ok: false, reason: 'UNKNOWN_LIGHT' };
  }
  if (!/^\d{1,4}$/.test(index)) {
    return { ok: false, reason: 'BAD_INDEX' };
  }
  return {
    ok: true,
    parsed: {
      run,
      cell: cell as ClipNameCell,
      skuToken,
      type: type as ClipNameType,
      light: light as ClipNameLight,
      index: Number(index),
      extension,
    },
  };
}

// ------------------------------------------------- ground-truth suggestion

export const DEFAULT_TRUTH_TIMESTAMP_MS = 4500;

export interface GroundTruthSuggestion {
  eventKind: GroundTruthEventKind;
  testType: CvTestScenario | null;
  /** SKU token from the name, or null for "no product". */
  productToken: string | null;
  quantity: number;
  actualTimestampMs: number | null;
  note: string;
  confidence: 'EXACT' | 'APPROXIMATED' | 'NONE';
  hint: string | null;
}

interface TypeRule {
  eventKind: GroundTruthEventKind;
  testType: CvTestScenario | null;
  usesProduct: boolean;
  confidence: 'EXACT' | 'APPROXIMATED';
  hint: string | null;
  noteSuffix: string | null;
}

const TYPE_RULES: Record<ClipNameType, TypeRule> = {
  pickup: { eventKind: 'PICKUP', testType: 'PICKUP_SINGLE', usesProduct: true, confidence: 'EXACT', hint: null, noteSuffix: null },
  return: { eventKind: 'RETURN', testType: 'RETURN_SINGLE', usesProduct: true, confidence: 'EXACT', hint: null, noteSuffix: null },
  touch: { eventKind: 'NONE', testType: 'FALSE_TOUCH', usesProduct: false, confidence: 'EXACT', hint: null, noteSuffix: null },
  wrongcell: {
    eventKind: 'PICKUP',
    testType: 'PICKUP_SINGLE',
    usesProduct: true,
    confidence: 'APPROXIMATED',
    hint: 'No scenario exists for a wrong-cell pickup; kept as PICKUP_SINGLE, the note says wrongcell.',
    noteSuffix: 'wrongcell',
  },
  double: {
    eventKind: 'PICKUP',
    testType: 'PICKUP_SINGLE',
    usesProduct: true,
    confidence: 'APPROXIMATED',
    hint: 'Two takes in one clip: only the first take is recorded, per the capture guide.',
    noteSuffix: 'double: first take recorded',
  },
  nothing: { eventKind: 'NONE', testType: null, usesProduct: false, confidence: 'EXACT', hint: null, noteSuffix: null },
};

/** Plain ASCII, under 80 chars — it never trips the server's sensitive-text screen. */
export function noteFor(parsed: ParsedClipName, suffix: string | null = null): string {
  const base = `cell=${parsed.cell} light=${parsed.light} type=${parsed.type} sku=${parsed.skuToken}`;
  return suffix ? `${base} ${suffix}` : base;
}

export function suggestGroundTruth(parsed: ParsedClipName): GroundTruthSuggestion {
  const rule = TYPE_RULES[parsed.type];
  const tokenIsNone = parsed.skuToken === 'none';
  const productToken = rule.usesProduct && !tokenIsNone ? parsed.skuToken : null;
  const invalid = rule.usesProduct && tokenIsNone;
  return {
    eventKind: rule.eventKind,
    testType: rule.testType,
    productToken,
    quantity: 1,
    actualTimestampMs: rule.eventKind === 'NONE' ? null : DEFAULT_TRUTH_TIMESTAMP_MS,
    note: noteFor(parsed, rule.noteSuffix),
    confidence: invalid ? 'NONE' : rule.confidence,
    hint: invalid ? 'A pickup or return needs a product; the name says none.' : rule.hint,
  };
}

// ------------------------------------------------------- product resolution

export const DEFAULT_SKU_ALIASES: Record<string, string> = {
  water: 'WATER-BOTTLE-500ML',
  nescafe: 'SKU-LIME-GREEN',
};

export type ProductResolution =
  | { status: 'RESOLVED'; product: Product; via: 'ALIAS' | 'SKU' | 'NAME' }
  | { status: 'AMBIGUOUS'; candidates: Product[] }
  | { status: 'UNRESOLVED' }
  | { status: 'NONE' };

export function resolveProductForToken(
  token: string,
  products: Product[],
  aliases: Record<string, string> = DEFAULT_SKU_ALIASES,
): ProductResolution {
  const lower = token.trim().toLowerCase();
  if (lower === '' || lower === 'none') {
    return { status: 'NONE' };
  }
  const bySku = (sku: string) => products.find((p) => p.sku.toLowerCase() === sku.toLowerCase());
  const alias = aliases[lower];
  if (alias) {
    const product = bySku(alias);
    if (product) {
      return { status: 'RESOLVED', product, via: 'ALIAS' };
    }
  }
  const exact = bySku(lower);
  if (exact) {
    return { status: 'RESOLVED', product: exact, via: 'SKU' };
  }
  const hits = products.filter(
    (p) => p.name.toLowerCase().includes(lower) || p.sku.toLowerCase().includes(lower),
  );
  if (hits.length === 1) {
    return { status: 'RESOLVED', product: hits[0], via: 'NAME' };
  }
  if (hits.length > 1) {
    return { status: 'AMBIGUOUS', candidates: hits };
  }
  return { status: 'UNRESOLVED' };
}

/** Distinct SKU tokens across successful parses, 'none' excluded, in first-seen order. */
export function distinctSkuTokens(parses: ClipNameParse[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const parse of parses) {
    if (!parse.ok || parse.parsed.skuToken === 'none') {
      continue;
    }
    if (!seen.has(parse.parsed.skuToken)) {
      seen.add(parse.parsed.skuToken);
      out.push(parse.parsed.skuToken);
    }
  }
  return out;
}

// --------------------------------------------------- ground-truth validation

/** Mirror of the server's TEST_SCENARIO_ALLOWED_KINDS (pickup-validation.service.ts). */
export const SCENARIO_ALLOWED_KINDS: Record<CvTestScenario, readonly GroundTruthEventKind[]> = {
  PICKUP_SINGLE: ['PICKUP'],
  RETURN_SINGLE: ['RETURN'],
  FALSE_TOUCH: ['NONE'],
  TWO_SIMILAR_PICK_ONE: ['PICKUP'],
  TWO_VISIBLE_PICK_ONE: ['PICKUP'],
  VLM_UNAVAILABLE: ['PICKUP', 'RETURN'],
  VLM_INVALID_SKU: ['PICKUP', 'RETURN'],
};

export interface GroundTruthRow {
  eventKind: GroundTruthEventKind;
  productId: string | null;
  testType: CvTestScenario | null;
  actualTimestampMs: number | null;
  quantity: number;
  note: string;
}

/** Null when valid; otherwise the reason, built from field names only. */
export function validateGroundTruthRow(row: GroundTruthRow, durationMs: number | null): string | null {
  if (row.eventKind !== 'NONE') {
    if (!row.productId) {
      return 'a pickup or return needs a product';
    }
    if (row.actualTimestampMs === null || !Number.isFinite(row.actualTimestampMs) || row.actualTimestampMs < 0) {
      return 'a pickup or return needs the event timestamp (ms)';
    }
  }
  if (
    row.actualTimestampMs !== null &&
    durationMs !== null &&
    durationMs > 0 &&
    row.actualTimestampMs >= durationMs
  ) {
    return `timestamp must be under the clip length (${durationMs} ms)`;
  }
  if (!Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 100) {
    return 'quantity must be 1..100';
  }
  if (row.testType) {
    const allowed = SCENARIO_ALLOWED_KINDS[row.testType];
    if (!allowed.includes(row.eventKind)) {
      return `scenario ${row.testType} needs event kind ${allowed.join(' or ')}`;
    }
  }
  if (row.note.length > 500) {
    return 'note is longer than 500 characters';
  }
  return null;
}

// --------------------------------------------------------- resume + summary

/**
 * Matches picked files to assets already uploaded at the store, by the
 * server-sanitized filename. REJECTED / FAILED assets do not count (the
 * clip may be re-uploaded); when several match, the newest wins.
 */
export function matchUploadedAssets(
  files: { name: string }[],
  assets: VideoAsset[],
): Map<string, VideoAsset> {
  const byName = new Map<string, VideoAsset>();
  for (const asset of assets) {
    if (asset.status === 'REJECTED' || asset.status === 'FAILED' || asset.deletedAt) {
      continue;
    }
    const key = sanitizeFilenameLikeServer(asset.originalFilename);
    const existing = byName.get(key);
    if (!existing || existing.createdAt < asset.createdAt) {
      byName.set(key, asset);
    }
  }
  const matched = new Map<string, VideoAsset>();
  for (const file of files) {
    const key = sanitizeFilenameLikeServer(file.name);
    const asset = byName.get(key);
    if (asset) {
      matched.set(key, asset);
    }
  }
  return matched;
}

export const PREVIEW_FRESH_MS = 25 * 60_000;

/** The server accepts an approval only within 30 min of a preview; re-preview at 25. */
export function previewIsFresh(previewAtMs: number | null, nowMs: number, maxAgeMs = PREVIEW_FRESH_MS): boolean {
  return previewAtMs !== null && nowMs - previewAtMs >= 0 && nowMs - previewAtMs < maxAgeMs;
}

export type TruthAgreement = 'MATCH' | 'SKU_MISMATCH' | 'ACTION_MISMATCH' | 'NO_SUGGESTION' | 'NO_TRUTH';

export const AGREEMENT_LABELS: Record<TruthAgreement, string> = {
  MATCH: 'match',
  SKU_MISMATCH: 'wrong SKU',
  ACTION_MISMATCH: 'wrong action',
  NO_SUGGESTION: 'no suggestion',
  NO_TRUTH: 'no ground truth',
};

export function truthAgreement(report: Pick<ClipLabReport, 'asset' | 'suggestion'>): TruthAgreement {
  const truth = report.asset.groundTruth;
  if (!truth) {
    return 'NO_TRUTH';
  }
  const suggestion = report.suggestion;
  if (truth.eventKind === 'NONE') {
    return !suggestion || suggestion.action === 'UNKNOWN' || suggestion.sku === null
      ? 'MATCH'
      : 'ACTION_MISMATCH';
  }
  if (!suggestion || suggestion.sku === null) {
    return 'NO_SUGGESTION';
  }
  if (suggestion.action !== truth.eventKind) {
    return 'ACTION_MISMATCH';
  }
  return suggestion.sku === truth.sku ? 'MATCH' : 'SKU_MISMATCH';
}

export function countAgreements(values: TruthAgreement[]): Record<TruthAgreement, number> {
  const counts: Record<TruthAgreement, number> = {
    MATCH: 0,
    SKU_MISMATCH: 0,
    ACTION_MISMATCH: 0,
    NO_SUGGESTION: 0,
    NO_TRUTH: 0,
  };
  for (const value of values) {
    counts[value] += 1;
  }
  return counts;
}
