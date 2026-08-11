import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VlmRequestEvidence, VlmVerdict, VlmVerifier } from '../ports';
import {
  StrictParseResult,
  allowedSkus,
  buildPromptParts,
  parseStrictVerdict,
  safeRawPreview,
} from './vlm-shared';

/**
 * VLM escalation verifier (requirement 11).
 *
 * Contract enforced HERE, not trusted to the model:
 * - The model returns the strict structured schema {verdict, selectedSku,
 *   visualSupport, ocrSupport, barcodeSupport, reasonCodes,
 *   contradictions, requiresHumanReview}. selectedSku may ONLY be one of
 *   the SUPPLIED candidate SKUs (and only with verdict MATCH) — anything
 *   else, including a plausible-looking SKU that was not offered, is
 *   INVALID_SKU and routes to human review. Free-form invention is
 *   structurally impossible to accept.
 * - Malformed output is classified precisely (MALFORMED_RESPONSE /
 *   INVALID_JSON / INVALID_SCHEMA / INVALID_SKU). No legacy-shape
 *   mapping here — that leniency is local-dev-only (Ollama adapter).
 * - The model version is PINNED via PICKUP_VLM_MODEL (no floating
 *   aliases); the configured value is recorded on every verdict.
 * - Timeout/unavailability NEVER throws out of verify(): the verdict
 *   carries TIMEOUT/PROVIDER_* and the policy engine routes to review —
 *   store operation is never blocked on a cloud call.
 *
 * Config: PICKUP_VLM_API_KEY (absent ⇒ adapter not ready — the normal
 * edge posture), PICKUP_VLM_MODEL (pinned id), PICKUP_VLM_ENDPOINT.
 */
@Injectable()
export class AnthropicVlmVerifier implements VlmVerifier {
  readonly adapterKey = 'anthropic-vlm';
  readonly version = '2.0.0';

  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('PICKUP_VLM_API_KEY');
    this.model = config.get<string>('PICKUP_VLM_MODEL') ?? 'claude-sonnet-5';
    this.endpoint =
      config.get<string>('PICKUP_VLM_ENDPOINT') ??
      'https://api.anthropic.com/v1/messages';
  }

  checkReady(): Promise<boolean> {
    return Promise.resolve(Boolean(this.apiKey));
  }

  async verify(
    evidence: VlmRequestEvidence,
    timeoutMs: number,
  ): Promise<VlmVerdict> {
    const startedAt = Date.now();
    const base: Omit<VlmVerdict, 'status' | 'result'> = {
      modelKey: this.model,
      modelVersion: this.model,
      latencyMs: null,
    };
    if (!this.apiKey) {
      return {
        ...base,
        status: 'UNAVAILABLE',
        result: null,
        errorDetail: 'PICKUP_VLM_API_KEY not configured',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // SAME prompt and image set as every provider (vlm-shared): frames,
      // then one reference image per candidate — never the raw video.
      const { instruction, images } = buildPromptParts(evidence);
      const content: unknown[] = [];
      for (const image of images) {
        content.push({ type: 'text', text: `${image.label}:` });
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: image.base64,
          },
        });
      }
      content.push({ type: 'text', text: instruction });
      const response = await fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 400,
          messages: [{ role: 'user', content }],
        }),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          ...base,
          latencyMs,
          status: 'PROVIDER_ERROR',
          result: null,
          errorDetail: `HTTP ${response.status}`,
        };
      }
      const body = (await response.json()) as {
        content?: { type: string; text?: string }[];
      };
      const text =
        body.content?.find((block) => block.type === 'text')?.text ?? '';
      return {
        ...this.parseVerdict(text, allowedSkus(evidence)),
        ...base,
        latencyMs,
        rawPreview: safeRawPreview(text),
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      void error;
      return {
        ...base,
        latencyMs,
        // The abort signal is the authority: undici wraps abort errors in
        // ways that vary by version, but signal.aborted does not lie.
        status: controller.signal.aborted ? 'TIMEOUT' : 'PROVIDER_UNREACHABLE',
        result: null,
        errorDetail: controller.signal.aborted
          ? `no completion within ${timeoutMs} ms`
          : 'endpoint did not answer (network error)',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Delegates to the SHARED strict parser (one whitelist rule for every
   *  provider) — kept as a method for the existing test surface. NO
   *  legacy-compat here: the retired {choice} shape is always rejected. */
  parseVerdict(text: string, allowed: Set<string>): StrictParseResult {
    return parseStrictVerdict(text, allowed);
  }
}
