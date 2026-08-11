import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VlmRequestEvidence, VlmVerdict, VlmVerifier } from '../ports';
import {
  allowedSkus,
  buildPromptParts,
  parseStrictVerdict,
  safeRawPreview,
} from './vlm-shared';

export type OllamaReadinessClass =
  | 'READY'
  | 'MODEL_NOT_FOUND'
  | 'PROVIDER_UNREACHABLE';

/** True only for http(s) URLs whose host is a loopback address. */
export function isLoopbackHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

export interface OllamaReadiness {
  serverReachable: boolean;
  modelAvailable: boolean;
  availableModels: string[];
  /** READY means the model is INSTALLED — full inference readiness is only
   *  proven by a completed generation (see lastInference / warm-up note). */
  classification: OllamaReadinessClass;
  /** Outcome of the most recent verify() call this process made — the
   *  honest warm-up signal (null until a generation has been attempted). */
  lastInference: { status: string; latencyMs: number | null; at: string } | null;
}

/**
 * LOCAL VLM verifier — Ollama on the operator's own GPU box. No API key,
 * no paid endpoint, no cloud: PICKUP_VLM_BASE_URL (default the local
 * Ollama port) is the only destination, and the payload is confined to
 * event frames/crops, candidate reference images, and text evidence —
 * never the raw video.
 *
 * The SAME strict contract as every verifier: whitelist-parsed JSON (an
 * invented SKU is INVALID_SKU), pinned model id from PICKUP_VLM_MODEL,
 * and every failure classified precisely (PROVIDER_UNREACHABLE /
 * MODEL_NOT_FOUND / TIMEOUT / MALFORMED_RESPONSE / INVALID_JSON /
 * INVALID_SCHEMA / INVALID_SKU / PROVIDER_ERROR) — verify() never throws
 * and never collapses failures into a generic unavailable.
 *
 * Debug logging is SAFE-FIELDS-ONLY: endpoint, model, latency, HTTP
 * status, emptiness, error class. Never images, base64 payloads, secrets,
 * or customer data.
 */
@Injectable()
export class OllamaVlmVerifier implements VlmVerifier {
  readonly adapterKey = 'ollama-local';
  readonly version = '2.0.0';

  private readonly logger = new Logger(OllamaVlmVerifier.name);
  private readonly baseUrl: string;
  private readonly baseUrlLoopback: boolean;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly legacyCompat: boolean;
  private lastInference: OllamaReadiness['lastInference'] = null;

  constructor(config: ConfigService) {
    this.baseUrl = (
      config.get<string>('PICKUP_VLM_BASE_URL') ?? 'http://127.0.0.1:11434'
    ).replace(/\/+$/, '');
    // MEDIA BOUNDARY: the local verifier may ONLY talk to this machine.
    // A non-loopback base URL would ship event frames and reference
    // images to a remote host — refuse it outright (and `redirect:
    // 'error'` on every fetch so a redirect cannot escape either).
    this.baseUrlLoopback = isLoopbackHttpUrl(this.baseUrl);
    this.model = config.get<string>('PICKUP_VLM_MODEL') ?? '';
    // Local-dev ONLY: map the retired {choice, confidence} shape onto the
    // strict schema (always review-flagged). Default off — rejected.
    this.legacyCompat =
      (config.get<string>('PICKUP_VLM_LEGACY_COMPAT') ?? '')
        .trim()
        .toLowerCase() === 'true';
    // Ollama's default context is 4096 tokens — the multi-image evidence
    // prompt alone exceeds that (frames + reference PNGs ≈ 4600+ tokens),
    // which surfaces as HTTP 400 "exceeds the available context size".
    const configured = Number(config.get<string>('PICKUP_VLM_NUM_CTX'));
    this.numCtx = Number.isFinite(configured) && configured > 0 ? configured : 8192;
  }

  /** Rich readiness for the UI panel; checkReady() reduces it. */
  async readiness(): Promise<OllamaReadiness> {
    const notReachable: OllamaReadiness = {
      serverReachable: false,
      modelAvailable: false,
      availableModels: [],
      classification: 'PROVIDER_UNREACHABLE',
      lastInference: this.lastInference,
    };
    if (!this.baseUrlLoopback) {
      return notReachable;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
        redirect: 'error',
      });
      clearTimeout(timer);
      if (!response.ok) {
        return notReachable;
      }
      const body = (await response.json()) as {
        models?: { name: string }[];
      };
      const availableModels = (body.models ?? []).map((model) => model.name);
      const modelAvailable =
        this.model.length > 0 &&
        availableModels.some(
          (name) => name === this.model || name.startsWith(`${this.model}:`),
        );
      return {
        serverReachable: true,
        modelAvailable,
        availableModels,
        classification: modelAvailable ? 'READY' : 'MODEL_NOT_FOUND',
        lastInference: this.lastInference,
      };
    } catch {
      return notReachable;
    }
  }

  async checkReady(): Promise<boolean> {
    const readiness = await this.readiness();
    return readiness.serverReachable && readiness.modelAvailable;
  }

  async verify(
    evidence: VlmRequestEvidence,
    timeoutMs: number,
  ): Promise<VlmVerdict> {
    const endpoint = `${this.baseUrl}/api/chat`;
    const startedAt = Date.now();
    const base = {
      modelKey: this.model || null,
      modelVersion: this.model || null,
    };
    const record = (verdict: VlmVerdict, httpStatus: number | null): VlmVerdict => {
      this.lastInference = {
        status: verdict.status,
        latencyMs: verdict.latencyMs,
        at: new Date().toISOString(),
      };
      // Safe fields only — endpoint/model/latency/HTTP status/classified
      // error code. NEVER verdict.errorDetail: it can carry provider
      // response previews or parser messages derived from model output
      // (which may echo OCR/frame content), and that text must not reach
      // durable server logs. The detail stays on the verdict/evidence row.
      this.logger.log(
        `vlm-verify endpoint=${endpoint} model=${this.model || '(unset)'} ` +
          `status=${verdict.status} http=${httpStatus ?? '-'} ` +
          `latencyMs=${verdict.latencyMs ?? '-'} timeoutMs=${timeoutMs}`,
      );
      return verdict;
    };
    const fail = (
      status: VlmVerdict['status'],
      errorDetail: string,
      httpStatus: number | null = null,
      rawPreview: string | null = null,
    ): VlmVerdict =>
      record(
        {
          ...base,
          latencyMs: Date.now() - startedAt,
          status,
          result: null,
          errorDetail,
          rawPreview,
        },
        httpStatus,
      );

    if (!this.baseUrlLoopback) {
      return fail(
        'PROVIDER_UNREACHABLE',
        'PICKUP_VLM_BASE_URL must be a loopback http(s) URL ' +
          '(e.g. http://127.0.0.1:11434) — event frames and reference ' +
          'images never leave this machine in local mode',
      );
    }
    const readiness = await this.readiness();
    if (!readiness.serverReachable) {
      return fail(
        'PROVIDER_UNREACHABLE',
        `Ollama server not reachable at ${this.baseUrl} (is \`ollama serve\` running?)`,
      );
    }
    if (!readiness.modelAvailable) {
      return fail(
        'MODEL_NOT_FOUND',
        this.model.length === 0
          ? 'PICKUP_VLM_MODEL is not configured'
          : `model ${this.model} is not installed (available: ${
              readiness.availableModels.slice(0, 5).join(', ') || 'none'
            })`,
      );
    }

    const { instruction, images } = buildPromptParts(evidence);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Ollama chat endpoint: images ride as an array of raw base64 strings
      // on the message (Ollama's supported image payload format) — only
      // event frames/crops and reference images, NEVER the whole video.
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          // Ollama's structured-output mode: constrains decoding to JSON.
          format: 'json',
          messages: [
            {
              role: 'user',
              content:
                images.map((image, index) => `Image ${index + 1}: ${image.label}.`).join(' ') +
                '\n' +
                instruction,
              images: images.map((image) => image.base64),
            },
          ],
          options: { temperature: 0, num_ctx: this.numCtx },
        }),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const errorText = safeRawPreview(await response.text().catch(() => ''), 160);
        const modelMissing =
          response.status === 404 && /model/i.test(errorText) && /not found/i.test(errorText);
        return fail(
          modelMissing ? 'MODEL_NOT_FOUND' : 'PROVIDER_ERROR',
          `HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`,
          response.status,
        );
      }
      let body: { message?: { content?: string } };
      try {
        body = (await response.json()) as { message?: { content?: string } };
      } catch {
        return fail(
          'MALFORMED_RESPONSE',
          'response body was not valid JSON (not an Ollama chat response)',
          response.status,
        );
      }
      const content = body.message?.content ?? '';
      if (content.trim().length === 0) {
        return fail(
          'MALFORMED_RESPONSE',
          'response contained no completion text (empty message.content)',
          response.status,
        );
      }
      // Local dev leniency: strip ```json fences BEFORE parsing; the
      // strict schema + SKU whitelist still applies unchanged afterwards.
      const parsed = parseStrictVerdict(content, allowedSkus(evidence), {
        stripFences: true,
        legacyCompat: this.legacyCompat,
      });
      return record(
        {
          ...parsed,
          ...base,
          latencyMs,
          rawPreview: safeRawPreview(content),
        },
        response.status,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return fail(
          'TIMEOUT',
          `no completion within ${timeoutMs} ms — a cold model may still be ` +
            `loading into VRAM; retry usually succeeds once warm`,
        );
      }
      return fail(
        'PROVIDER_UNREACHABLE',
        `fetch failed (${
          error instanceof Error
            ? `${error.constructor.name}: ${error.message.slice(0, 120)}`
            : 'unknown error'
        })`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
