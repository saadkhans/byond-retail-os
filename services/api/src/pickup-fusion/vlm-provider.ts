import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VlmRequestEvidence, VlmVerdict, VlmVerifier } from './ports';
import { AnthropicVlmVerifier } from './adapters/vlm-verifier';
import { OllamaVlmVerifier } from './adapters/ollama-vlm';
import { allowedSkus, parseStrictVerdict } from './adapters/vlm-shared';

/**
 * VLM verifier selection — the ONLY place that knows which concrete
 * vendors exist. The orchestration service depends on the VlmVerifier
 * port through the PICKUP_VLM_VERIFIER token alone (vendor neutrality:
 * concrete vendors are plug-ins behind adapters; core logic compiles and
 * tests against the interface). A new vendor registers here and in the
 * module providers — the service never changes.
 */

export type PickupVlmProviderKey = 'local' | 'anthropic';

export const PICKUP_VLM_VERIFIER = 'PICKUP_VLM_VERIFIER';

/** Provider-neutral readiness surface for the UI panel — each vendor's
 *  richer readiness (Ollama /api/tags, Anthropic key presence) is mapped
 *  onto this shape HERE, so the service renders one contract. */
export interface VlmProviderReadiness {
  model: string | null;
  baseUrl: string | null;
  serverReachable: boolean;
  modelAvailable: boolean;
  availableModels: string[];
  classification: 'READY' | 'MODEL_NOT_FOUND' | 'PROVIDER_UNREACHABLE';
  /** Outcome of the most recent verify() this process made (local only) —
   *  the honest warm-up signal; null when unknown/not applicable. */
  lastInference: { status: string; latencyMs: number | null; at: string } | null;
}

/** What the token resolves to: the selected PORT plus its identity and a
 *  normalized readiness probe. */
export interface SelectedVlmVerifier {
  readonly provider: PickupVlmProviderKey;
  readonly verifier: VlmVerifier;
  readiness(): Promise<VlmProviderReadiness>;
}

/** 'anthropic' opts into the cloud vendor; anything else (including
 *  unset) is the local default — env validation already constrains the
 *  raw value to local|anthropic. */
export function parseVlmProviderKey(
  raw: string | undefined,
): PickupVlmProviderKey {
  return raw === 'anthropic' ? 'anthropic' : 'local';
}

export type PickupVlmFaultMode = 'NONE' | 'UNAVAILABLE' | 'INVALID_SKU';

/** Only the two exact drill modes inject; anything else (including
 *  unset) is NONE — env validation already constrains the raw value. */
export function parseVlmFaultMode(raw: string | undefined): PickupVlmFaultMode {
  return raw === 'UNAVAILABLE' || raw === 'INVALID_SKU' ? raw : 'NONE';
}

/**
 * SHADOW/TEST-ONLY fault injection (PICKUP_VLM_FAULT) for the Phase 11
 * controlled test-run drills. The wrapper NEVER touches the network:
 * - UNAVAILABLE reports PROVIDER_UNREACHABLE, proving the pipeline
 *   degrades to review when the verifier is down.
 * - INVALID_SKU synthesizes a schema-valid completion whose selectedSku
 *   is NOT a supplied candidate and pushes it through the REAL strict
 *   parser — the genuine anti-invention rejection path runs end-to-end.
 * readiness()/checkReady() pass through to the real provider so the
 * readiness panel stays honest about what is actually installed.
 */
export function withFaultInjection(
  verifier: VlmVerifier,
  mode: Exclude<PickupVlmFaultMode, 'NONE'>,
): VlmVerifier {
  return {
    adapterKey: verifier.adapterKey,
    version: verifier.version,
    checkReady: () => verifier.checkReady(),
    verify: async (evidence: VlmRequestEvidence): Promise<VlmVerdict> => {
      if (mode === 'UNAVAILABLE') {
        return {
          status: 'PROVIDER_UNREACHABLE',
          result: null,
          modelKey: verifier.adapterKey,
          modelVersion: verifier.version,
          latencyMs: 0,
          errorDetail: 'fault injection: PICKUP_VLM_FAULT=UNAVAILABLE',
        };
      }
      const invented = JSON.stringify({
        verdict: 'MATCH',
        selectedSku: 'PHANTOM-SKU-999',
        visualSupport: 'STRONG',
        ocrSupport: 'NONE',
        barcodeSupport: 'NONE',
        reasonCodes: ['REFERENCE_VISUAL_MATCH'],
        contradictions: [],
        requiresHumanReview: false,
      });
      const parsed = parseStrictVerdict(invented, allowedSkus(evidence));
      return {
        status: parsed.status,
        result: parsed.result,
        modelKey: verifier.adapterKey,
        modelVersion: verifier.version,
        latencyMs: 0,
        errorDetail: parsed.errorDetail,
      };
    },
  };
}

export function selectVlmVerifier(
  config: ConfigService,
  anthropic: AnthropicVlmVerifier,
  ollama: OllamaVlmVerifier,
): SelectedVlmVerifier {
  const provider = parseVlmProviderKey(
    config.get<string>('PICKUP_VLM_PROVIDER'),
  );
  const fault = parseVlmFaultMode(config.get<string>('PICKUP_VLM_FAULT'));
  const armed = (verifier: VlmVerifier): VlmVerifier => {
    if (fault === 'NONE') {
      return verifier;
    }
    new Logger('PickupVlmFault').warn(
      `PICKUP_VLM_FAULT=${fault} is ACTIVE — VLM verify() calls are ` +
        'fault-injected (shadow/test drill; never a production setting)',
    );
    return withFaultInjection(verifier, fault);
  };
  if (provider === 'anthropic') {
    return {
      provider,
      verifier: armed(anthropic),
      readiness: async () => {
        // Key presence is the only cheap cloud probe — reachable and
        // model-available collapse onto it (no paid call from readiness).
        const ready = await anthropic.checkReady();
        return {
          model: null,
          baseUrl: null,
          serverReachable: ready,
          modelAvailable: ready,
          availableModels: [],
          classification: ready ? 'READY' : 'PROVIDER_UNREACHABLE',
          lastInference: null,
        };
      },
    };
  }
  return {
    provider,
    verifier: armed(ollama),
    readiness: async () => {
      const readiness = await ollama.readiness();
      return {
        model: ollama['model'] as string,
        baseUrl: ollama['baseUrl'] as string,
        serverReachable: readiness.serverReachable,
        modelAvailable: readiness.modelAvailable,
        availableModels: readiness.availableModels,
        classification: readiness.classification,
        lastInference: readiness.lastInference,
      };
    },
  };
}

/** Module registration: keyed selection by PICKUP_VLM_PROVIDER. */
export const pickupVlmVerifierProvider: Provider = {
  provide: PICKUP_VLM_VERIFIER,
  inject: [ConfigService, AnthropicVlmVerifier, OllamaVlmVerifier],
  useFactory: selectVlmVerifier,
};
