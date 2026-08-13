import {
  VLM_CONTRADICTION_CODES,
  VLM_REASON_CODES,
  VlmBarcodeSupport,
  VlmContradictionCode,
  VlmReasonCode,
  VlmRequestEvidence,
  VlmStructuredResult,
  VlmSupportLevel,
  VlmVerdict,
  VlmVerdictKind,
} from '../ports';
import { encodeRgbPng } from './text-signals';

/**
 * Provider-independent halves of the VLM verifier contract: the STRICT
 * schema/whitelist parser (the anti-invention guarantee — no provider is
 * trusted to enforce it) and the shared prompt/image assembly (only event
 * frames, crops, and candidate reference images ever travel — never the
 * raw video).
 */

export function allowedSkus(evidence: VlmRequestEvidence): Set<string> {
  return new Set(evidence.candidates.map((candidate) => candidate.sku));
}

/** Elide base64-looking runs, collapse whitespace, hard-cap length — the
 *  only form of model output that may travel to the UI panel. */
export function safeRawPreview(text: string, maxLength = 240): string {
  return text
    .replace(/[A-Za-z0-9+/=]{80,}/g, '[base64 elided]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Strip leading/trailing markdown code fences (```json ... ```). Local
 *  dev leniency ONLY — callers opt in; the schema whitelist below still
 *  applies unchanged afterwards. */
export function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

export type StrictParseResult = Pick<VlmVerdict, 'status' | 'result'> & {
  errorDetail: string | null;
};

const VERDICT_KINDS: readonly VlmVerdictKind[] = [
  'MATCH',
  'AMBIGUOUS',
  'UNKNOWN',
  'INVALID_INPUT',
];
const SUPPORT_LEVELS: readonly VlmSupportLevel[] = [
  'STRONG',
  'MEDIUM',
  'WEAK',
  'NONE',
];
const BARCODE_SUPPORTS: readonly VlmBarcodeSupport[] = [
  'EXACT',
  'PARTIAL',
  'NONE',
];

export interface StrictParseOptions {
  /** Strip markdown fences before parsing (local-dev cleanup only). */
  stripFences?: boolean;
  /** Map the RETIRED {choice, confidence, reasoning} shape onto the strict
   *  schema instead of rejecting it. Local-dev compatibility ONLY
   *  (PICKUP_VLM_LEGACY_COMPAT) — mapped results always carry
   *  LEGACY_SCHEMA_MAPPED and requiresHumanReview=true so they can never
   *  auto-propose. Default: rejected as INVALID_SCHEMA. */
  legacyCompat?: boolean;
}

function fail(
  status: 'MALFORMED_RESPONSE' | 'INVALID_JSON' | 'INVALID_SCHEMA' | 'INVALID_SKU',
  errorDetail: string,
): StrictParseResult {
  return { status, result: null, errorDetail };
}

function parseCodeArray<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  field: string,
): { codes: T[] } | { error: string } {
  // A missing/null array is INVALID_SCHEMA, not "empty": a structurally
  // incomplete MATCH must never look contradiction-free to the policy.
  if (!Array.isArray(value)) {
    return { error: `"${field}" must be a present array of controlled codes` };
  }
  const codes: T[] = [];
  for (const entry of value.slice(0, 8)) {
    if (typeof entry !== 'string') {
      return { error: `"${field}" entries must be strings` };
    }
    if (!vocabulary.includes(entry as T)) {
      return {
        error: `"${field}" contains an unknown code ${JSON.stringify(entry.slice(0, 40))}`,
      };
    }
    if (!codes.includes(entry as T)) {
      codes.push(entry as T);
    }
  }
  return { codes };
}

/** Local-dev compatibility ONLY: map the retired {choice, confidence,
 *  reasoning} shape onto the strict schema. Mapped results are always
 *  review-flagged — they can never auto-propose. */
function mapLegacyShape(
  record: Record<string, unknown>,
  allowed: Set<string>,
): StrictParseResult {
  const choice = record.choice;
  if (typeof choice !== 'string') {
    return fail('INVALID_SCHEMA', 'legacy shape: "choice" must be a string');
  }
  let verdict: VlmVerdictKind;
  let selectedSku: string | null = null;
  if (choice === 'UNKNOWN') {
    verdict = 'UNKNOWN';
  } else if (choice === 'AMBIGUOUS') {
    verdict = 'AMBIGUOUS';
  } else if (allowed.has(choice)) {
    verdict = 'MATCH';
    selectedSku = choice;
  } else {
    return fail(
      'INVALID_SKU',
      `legacy shape: choice ${JSON.stringify(choice.slice(0, 60))} is not a supplied candidate SKU`,
    );
  }
  return {
    status: 'VERDICT',
    result: {
      verdict,
      selectedSku,
      visualSupport: verdict === 'MATCH' ? 'WEAK' : 'NONE',
      ocrSupport: 'NONE',
      barcodeSupport: 'NONE',
      reasonCodes: ['LEGACY_SCHEMA_MAPPED'],
      contradictions: [],
      requiresHumanReview: true,
    },
    errorDetail: null,
  };
}

/**
 * The strict verifier schema — the ONLY canonical shape:
 * {verdict, selectedSku, visualSupport, ocrSupport, barcodeSupport,
 *  reasonCodes, contradictions, requiresHumanReview}.
 * Everything is whitelist-validated; the retired "choice" field is NOT
 * accepted as canonical (see StrictParseOptions.legacyCompat).
 */
export function parseStrictVerdict(
  text: string,
  allowed: Set<string>,
  options: StrictParseOptions = {},
): StrictParseResult {
  const source = (options.stripFences ? stripCodeFences(text) : text).trim();
  if (source.length === 0) {
    return fail('MALFORMED_RESPONSE', 'empty response text');
  }
  // The contract is EXACTLY ONE JSON object and nothing else. Brace
  // extraction (tolerating surrounding prose) is a LOCAL-DEV cleanup that
  // rides the same opt-in as fence stripping — the strict path parses the
  // trimmed response verbatim and rejects any wrapper text.
  let jsonText: string;
  if (options.stripFences) {
    const jsonMatch = source.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fail('MALFORMED_RESPONSE', 'no JSON object found in response text');
    }
    jsonText = jsonMatch[0];
  } else {
    if (!source.startsWith('{') || !source.endsWith('}')) {
      return fail(
        'MALFORMED_RESPONSE',
        'response must be exactly one bare JSON object (no prose, no fences)',
      );
    }
    jsonText = source;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return fail(
      'INVALID_JSON',
      `JSON.parse failed (${
        error instanceof Error ? error.constructor.name : 'unknown'
      }): ${error instanceof Error ? error.message.slice(0, 120) : ''}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('INVALID_SCHEMA', 'response is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;

  // The RETIRED shape: "choice" present, "verdict" absent.
  if (record.verdict === undefined && record.choice !== undefined) {
    if (options.legacyCompat === true) {
      return mapLegacyShape(record, allowed);
    }
    return fail(
      'INVALID_SCHEMA',
      'legacy {choice, confidence} schema is not accepted — the strict ' +
        '{verdict, selectedSku, ...} schema is required ' +
        '(PICKUP_VLM_LEGACY_COMPAT=true maps it in local dev only)',
    );
  }

  const verdict = record.verdict;
  if (typeof verdict !== 'string' || !VERDICT_KINDS.includes(verdict as VlmVerdictKind)) {
    return fail(
      'INVALID_SCHEMA',
      `"verdict" must be one of ${VERDICT_KINDS.join('|')}`,
    );
  }
  const selectedSku = record.selectedSku ?? null;
  if (selectedSku !== null && typeof selectedSku !== 'string') {
    return fail('INVALID_SCHEMA', '"selectedSku" must be a string or null');
  }
  if (verdict !== 'MATCH' && selectedSku !== null) {
    return fail(
      'INVALID_SCHEMA',
      `"selectedSku" must be null when verdict is ${verdict}`,
    );
  }
  if (verdict === 'MATCH') {
    if (selectedSku === null) {
      return fail('INVALID_SCHEMA', 'verdict MATCH requires a "selectedSku"');
    }
    if (!allowed.has(selectedSku)) {
      return fail(
        'INVALID_SKU',
        `selectedSku ${JSON.stringify(selectedSku.slice(0, 60))} is not a supplied candidate SKU`,
      );
    }
  }
  const visualSupport = record.visualSupport;
  const ocrSupport = record.ocrSupport;
  if (
    typeof visualSupport !== 'string' ||
    !SUPPORT_LEVELS.includes(visualSupport as VlmSupportLevel) ||
    typeof ocrSupport !== 'string' ||
    !SUPPORT_LEVELS.includes(ocrSupport as VlmSupportLevel)
  ) {
    return fail(
      'INVALID_SCHEMA',
      `"visualSupport"/"ocrSupport" must be one of ${SUPPORT_LEVELS.join('|')}`,
    );
  }
  const barcodeSupport = record.barcodeSupport;
  if (
    typeof barcodeSupport !== 'string' ||
    !BARCODE_SUPPORTS.includes(barcodeSupport as VlmBarcodeSupport)
  ) {
    return fail(
      'INVALID_SCHEMA',
      `"barcodeSupport" must be one of ${BARCODE_SUPPORTS.join('|')}`,
    );
  }
  const reasonCodes = parseCodeArray<VlmReasonCode>(
    record.reasonCodes,
    VLM_REASON_CODES,
    'reasonCodes',
  );
  if ('error' in reasonCodes) {
    return fail('INVALID_SCHEMA', reasonCodes.error);
  }
  const contradictions = parseCodeArray<VlmContradictionCode>(
    record.contradictions,
    VLM_CONTRADICTION_CODES,
    'contradictions',
  );
  if ('error' in contradictions) {
    return fail('INVALID_SCHEMA', contradictions.error);
  }
  if (typeof record.requiresHumanReview !== 'boolean') {
    return fail('INVALID_SCHEMA', '"requiresHumanReview" must be a boolean');
  }
  const result: VlmStructuredResult = {
    verdict: verdict as VlmVerdictKind,
    selectedSku: verdict === 'MATCH' ? (selectedSku as string) : null,
    visualSupport: visualSupport as VlmSupportLevel,
    ocrSupport: ocrSupport as VlmSupportLevel,
    barcodeSupport: barcodeSupport as VlmBarcodeSupport,
    reasonCodes: reasonCodes.codes,
    contradictions: contradictions.codes,
    requiresHumanReview: record.requiresHumanReview,
  };
  return { status: 'VERDICT', result, errorDetail: null };
}

export interface VlmPromptParts {
  instruction: string;
  /** base64 PNGs in presentation order (frames, then references). */
  images: { label: string; base64: string }[];
}

export function buildPromptParts(evidence: VlmRequestEvidence): VlmPromptParts {
  const images: VlmPromptParts['images'] = [];
  for (const frame of evidence.frames) {
    images.push({
      label: `Video frame (${frame.phase})`,
      base64: encodeRgbPng(frame.image).toString('base64'),
    });
  }
  for (const candidate of evidence.candidates) {
    const reference = candidate.referenceImages[0];
    if (reference) {
      images.push({
        label: `Reference image for candidate ${candidate.sku}`,
        base64: encodeRgbPng(reference).toString('base64'),
      });
    }
  }
  const skus = [...allowedSkus(evidence)];
  const instruction =
    `A shopper interacted with a retail shelf. The first images are event ` +
    `frames (pre/peak/post); the remaining images are catalog reference ` +
    `photos for the candidate products, in this order: ${evidence.candidates
      .map((candidate) => `${candidate.sku} (${candidate.name}, fused score ${candidate.fusedScore})`)
      .join('; ')}. ` +
    `OCR text seen on the product: ${JSON.stringify(evidence.ocrText ?? '')}. ` +
    `Barcode: ${evidence.barcode ?? 'none'}. Shelf context: ${evidence.shelfContext ?? 'none'}.\n` +
    `Which candidate product was picked up? Return EXACTLY ONE JSON object ` +
    `and nothing else: no markdown, no code fences, no prose before or after.\n` +
    `Schema: {"verdict": "MATCH"|"AMBIGUOUS"|"UNKNOWN"|"INVALID_INPUT", ` +
    `"selectedSku": string|null, ` +
    `"visualSupport": "STRONG"|"MEDIUM"|"WEAK"|"NONE", ` +
    `"ocrSupport": "STRONG"|"MEDIUM"|"WEAK"|"NONE", ` +
    `"barcodeSupport": "EXACT"|"PARTIAL"|"NONE", ` +
    `"reasonCodes": string[], "contradictions": string[], ` +
    `"requiresHumanReview": boolean}.\n` +
    `Rules: "selectedSku" MUST be null unless "verdict" is "MATCH"; when ` +
    `MATCH it MUST be exactly one of: ${skus.join(', ')}. ` +
    `Use UNKNOWN if no candidate matches, AMBIGUOUS if several are ` +
    `indistinguishable, INVALID_INPUT if the images are unusable. ` +
    `"reasonCodes" may ONLY use: ${VLM_REASON_CODES.filter((code) => code !== 'LEGACY_SCHEMA_MAPPED').join(', ')}. ` +
    `"contradictions" may ONLY use: ${VLM_CONTRADICTION_CODES.join(', ')}. ` +
    `Set "requiresHumanReview" true whenever the evidence is not clearly conclusive.`;
  return { instruction, images };
}
