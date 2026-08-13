import { ConfigService } from '@nestjs/config';
import { FusionPolicyResult } from '@prisma/client';
import { OllamaVlmVerifier } from './adapters/ollama-vlm';
import { parseStrictVerdict } from './adapters/vlm-shared';
import {
  VLM_CONTRADICTION_CODES,
  VLM_REASON_CODES,
  VlmStructuredResult,
  VlmVerdict,
  VlmVerdictStatus,
} from './ports';
import {
  FusionEvidence,
  applyVlmVerdictToEvidence,
  policyFromVlmResult,
} from './pickup-fusion.service';

/**
 * Phase 11 §1 — the STRICT VLM verifier contract, pinned in one place:
 * every schema field is whitelist-enforced, invented SKUs and malformed
 * JSON are rejected with their exact classification, the VLM can never
 * set policy directly (the pure policy rule alone decides), and the
 * local provider needs no API key. Complements the adapter-level specs
 * (ollama-vlm.spec.ts) which prove the same parser runs over the wire.
 */

const ALLOWED = new Set(['SKU-A', 'SKU-B']);

function strictJson(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    verdict: 'MATCH',
    selectedSku: 'SKU-A',
    visualSupport: 'STRONG',
    ocrSupport: 'MEDIUM',
    barcodeSupport: 'NONE',
    reasonCodes: ['REFERENCE_VISUAL_MATCH'],
    contradictions: [],
    requiresHumanReview: false,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return JSON.stringify(base);
}

describe('strict schema enforcement (parseStrictVerdict)', () => {
  it('a fully valid object round-trips into the structured result', () => {
    const parsed = parseStrictVerdict(strictJson(), ALLOWED);
    expect(parsed.status).toBe('VERDICT');
    expect(parsed.result).toEqual({
      verdict: 'MATCH',
      selectedSku: 'SKU-A',
      visualSupport: 'STRONG',
      ocrSupport: 'MEDIUM',
      barcodeSupport: 'NONE',
      reasonCodes: ['REFERENCE_VISUAL_MATCH'],
      contradictions: [],
      requiresHumanReview: false,
    });
  });

  it('an INVENTED SKU is rejected structurally — INVALID_SKU, no result', () => {
    const parsed = parseStrictVerdict(
      strictJson({ selectedSku: 'PHANTOM-SKU-999' }),
      ALLOWED,
    );
    expect(parsed.status).toBe('INVALID_SKU');
    expect(parsed.result).toBeNull();
  });

  it('malformed JSON is INVALID_JSON; non-object text is MALFORMED_RESPONSE', () => {
    expect(parseStrictVerdict('{"verdict": MATCH,}', ALLOWED).status).toBe(
      'INVALID_JSON',
    );
    expect(parseStrictVerdict('the product is SKU-A', ALLOWED).status).toBe(
      'MALFORMED_RESPONSE',
    );
    expect(parseStrictVerdict('', ALLOWED).status).toBe('MALFORMED_RESPONSE');
  });

  it('EVERY missing required field is INVALID_SCHEMA', () => {
    for (const field of [
      'verdict',
      'visualSupport',
      'ocrSupport',
      'barcodeSupport',
      'reasonCodes',
      'contradictions',
      'requiresHumanReview',
    ]) {
      const parsed = parseStrictVerdict(
        strictJson({ [field]: undefined }),
        ALLOWED,
      );
      expect(`${field}:${parsed.status}`).toBe(`${field}:INVALID_SCHEMA`);
      expect(parsed.result).toBeNull();
    }
  });

  it('selectedSku must be null unless MATCH — and present when MATCH', () => {
    expect(
      parseStrictVerdict(
        strictJson({ verdict: 'AMBIGUOUS', selectedSku: 'SKU-A' }),
        ALLOWED,
      ).status,
    ).toBe('INVALID_SCHEMA');
    expect(
      parseStrictVerdict(strictJson({ selectedSku: null }), ALLOWED).status,
    ).toBe('INVALID_SCHEMA');
  });

  it('enum fields reject values outside their whitelists', () => {
    for (const overrides of [
      { verdict: 'MAYBE' },
      { visualSupport: 'HUGE' },
      { ocrSupport: 'ok' },
      { barcodeSupport: 'FULL' },
      { requiresHumanReview: 'no' },
    ]) {
      expect(parseStrictVerdict(strictJson(overrides), ALLOWED).status).toBe(
        'INVALID_SCHEMA',
      );
    }
  });

  it('reasonCodes/contradictions accept ONLY the controlled vocabularies', () => {
    expect(
      parseStrictVerdict(
        strictJson({ reasonCodes: ['I_JUST_FEEL_IT'] }),
        ALLOWED,
      ).status,
    ).toBe('INVALID_SCHEMA');
    expect(
      parseStrictVerdict(
        strictJson({ contradictions: ['free-form prose here'] }),
        ALLOWED,
      ).status,
    ).toBe('INVALID_SCHEMA');
    expect(
      parseStrictVerdict(strictJson({ reasonCodes: 'BARCODE_MATCH' }), ALLOWED)
        .status,
    ).toBe('INVALID_SCHEMA');
    // The full vocabularies themselves parse.
    expect(
      parseStrictVerdict(
        strictJson({
          reasonCodes: VLM_REASON_CODES.slice(0, 8),
          contradictions: [...VLM_CONTRADICTION_CODES],
        }),
        ALLOWED,
      ).status,
    ).toBe('VERDICT');
  });
});

describe('the VLM never sets policy directly', () => {
  const match = (
    overrides: Partial<VlmStructuredResult> = {},
  ): VlmStructuredResult => ({
    verdict: 'MATCH',
    selectedSku: 'SKU-A',
    visualSupport: 'STRONG',
    ocrSupport: 'MEDIUM',
    barcodeSupport: 'NONE',
    reasonCodes: [],
    contradictions: [],
    requiresHumanReview: false,
    ...overrides,
  });

  it('every verdict kind maps into the closed FusionPolicyResult set', () => {
    const allowed = new Set(Object.values(FusionPolicyResult));
    for (const result of [
      match(),
      match({ verdict: 'AMBIGUOUS', selectedSku: null }),
      match({ verdict: 'UNKNOWN', selectedSku: null }),
      match({ verdict: 'INVALID_INPUT', selectedSku: null }),
      match({ requiresHumanReview: true }),
      match({ contradictions: ['OCR_MISMATCH'] }),
    ]) {
      for (const decision of ['AUTO_PROPOSE', 'NEEDS_VLM'] as const) {
        const policy = policyFromVlmResult(result, decision, 'SKU-A');
        expect(allowed.has(policy.result)).toBe(true);
      }
    }
  });

  function evidenceStub(): FusionEvidence {
    return {
      vlm: {
        invoked: true,
        reason: 'test',
        provider: 'local',
        mode: 'UNCERTAIN_ONLY',
        status: null,
        verdict: null,
        selectedSku: null,
        visualSupport: null,
        ocrSupport: null,
        barcodeSupport: null,
        reasonCodes: [],
        contradictions: [],
        requiresHumanReview: null,
        modelKey: null,
        latencyMs: null,
      },
      policy: { result: FusionPolicyResult.NEEDS_VLM, reason: 'pending' },
    } as unknown as FusionEvidence;
  }

  it('every non-VERDICT status routes to NEEDS_HUMAN_REVIEW — never AUTO_PROPOSE', () => {
    const failures: VlmVerdictStatus[] = [
      'PROVIDER_UNREACHABLE',
      'MODEL_NOT_FOUND',
      'TIMEOUT',
      'MALFORMED_RESPONSE',
      'INVALID_JSON',
      'INVALID_SCHEMA',
      'INVALID_SKU',
      'PROVIDER_ERROR',
      'UNAVAILABLE',
    ];
    for (const status of failures) {
      const evidence = evidenceStub();
      const verdict: VlmVerdict = {
        status,
        result: null,
        modelKey: 'm',
        modelVersion: '1',
        latencyMs: 5,
        errorDetail: 'secret-bearing free text that must never persist',
        rawPreview: 'raw completion preview that must never persist',
      };
      applyVlmVerdictToEvidence(evidence, verdict, 'AUTO_PROPOSE', 'SKU-A', 'x');
      expect(evidence.policy.result).toBe(FusionPolicyResult.NEEDS_HUMAN_REVIEW);
    }
  });

  it('errorDetail/rawPreview never reach the persisted evidence', () => {
    const evidence = evidenceStub();
    applyVlmVerdictToEvidence(
      evidence,
      {
        status: 'INVALID_SKU',
        result: null,
        modelKey: 'm',
        modelVersion: '1',
        latencyMs: 5,
        errorDetail: 'PAN-bearing detail',
        rawPreview: 'PAN-bearing preview',
      },
      'NEEDS_VLM',
      'SKU-A',
      'fallback',
    );
    expect(JSON.stringify(evidence)).not.toContain('PAN-bearing');
  });
});

describe('local provider needs no API key', () => {
  it('OllamaVlmVerifier constructs and answers readiness without any key env', async () => {
    const config = {
      get: (key: string) =>
        key === 'PICKUP_VLM_MODEL'
          ? 'qwen2.5vl:7b'
          : key === 'PICKUP_VLM_BASE_URL'
            ? 'http://127.0.0.1:9' // reserved port — reliably unreachable
            : undefined,
    } as unknown as ConfigService;
    const verifier = new OllamaVlmVerifier(config);
    expect(verifier.adapterKey).toBe('ollama-local');
    // No key is consulted anywhere; with nothing listening the readiness
    // probe reports unreachable — but never throws and never demands a key.
    const readiness = await verifier.readiness();
    expect(readiness.classification).toBe('PROVIDER_UNREACHABLE');
  });
});
