import { Server, createServer } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { OllamaVlmVerifier } from './ollama-vlm';
import { VlmRequestEvidence } from '../ports';

/**
 * Local-VLM adapter contract against a REAL local HTTP stub (no paid API,
 * no network): readiness = server reachable AND model present; verify()
 * goes through the shared STRICT structured-schema parser; every failure
 * carries its exact classification; timeout/unreachable degrade to
 * verdict statuses, never throws.
 */

function configFor(
  port: number | null,
  options: { model?: string; legacyCompat?: boolean } = {},
): ConfigService {
  const model = options.model ?? 'test-vision:7b';
  return {
    get: (key: string) =>
      key === 'PICKUP_VLM_BASE_URL'
        ? port === null
          ? 'http://127.0.0.1:9' // reserved port — reliably unreachable
          : `http://127.0.0.1:${port}`
        : key === 'PICKUP_VLM_MODEL'
          ? model
          : key === 'PICKUP_VLM_LEGACY_COMPAT'
            ? options.legacyCompat
              ? 'true'
              : undefined
            : undefined,
  } as unknown as ConfigService;
}

const EVIDENCE: VlmRequestEvidence = {
  frames: [],
  crops: [],
  candidates: [
    { sku: 'SKU-A', name: 'Product A', fusedScore: 0.3, referenceImages: [] },
    { sku: 'SKU-B', name: 'Product B', fusedScore: 0.28, referenceImages: [] },
  ],
  ocrText: null,
  barcode: null,
  shelfContext: null,
};

/** A fully valid strict-schema response, overridable per test. */
function strictJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'MATCH',
    selectedSku: 'SKU-B',
    visualSupport: 'STRONG',
    ocrSupport: 'MEDIUM',
    barcodeSupport: 'NONE',
    reasonCodes: ['REFERENCE_VISUAL_MATCH', 'OCR_TEXT_MATCH'],
    contradictions: [],
    requiresHumanReview: false,
    ...overrides,
  });
}

function stubOllama(handlers: {
  tags?: () => unknown;
  chat?: () => unknown;
  chatStatus?: number;
  stall?: boolean;
}): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (handlers.stall) {
      return; // never respond
    }
    if (request.url === '/api/tags') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(handlers.tags?.() ?? { models: [] }));
      return;
    }
    if (request.url === '/api/chat') {
      response.statusCode = handlers.chatStatus ?? 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(handlers.chat?.() ?? {}));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return new Promise((resolvePromise) =>
    server.listen(0, '127.0.0.1', () =>
      resolvePromise({
        server,
        port: (server.address() as { port: number }).port,
      }),
    ),
  );
}

async function verifyWithContent(
  content: string,
  options: { legacyCompat?: boolean } = {},
) {
  const { server, port } = await stubOllama({
    tags: () => ({ models: [{ name: 'test-vision:7b' }] }),
    chat: () => ({ message: { content } }),
  });
  const verifier = new OllamaVlmVerifier(configFor(port, options));
  const verdict = await verifier.verify(EVIDENCE, 5000);
  server.close();
  return verdict;
}

describe('OllamaVlmVerifier', () => {
  it('readiness: unreachable server → not ready (edge-offline posture)', async () => {
    const verifier = new OllamaVlmVerifier(configFor(null));
    const readiness = await verifier.readiness();
    expect(readiness.serverReachable).toBe(false);
    expect(readiness.classification).toBe('PROVIDER_UNREACHABLE');
    expect(await verifier.checkReady()).toBe(false);
  });

  it('readiness: reachable but model missing → not ready, models listed', async () => {
    const { server, port } = await stubOllama({
      tags: () => ({ models: [{ name: 'llama3:8b' }] }),
    });
    const verifier = new OllamaVlmVerifier(configFor(port));
    const readiness = await verifier.readiness();
    server.close();
    expect(readiness.serverReachable).toBe(true);
    expect(readiness.modelAvailable).toBe(false);
    expect(readiness.classification).toBe('MODEL_NOT_FOUND');
    expect(readiness.availableModels).toContain('llama3:8b');
  });

  it('verify: valid MATCH passes through with the pinned model and support levels', async () => {
    const verdict = await verifyWithContent(strictJson());
    expect(verdict.status).toBe('VERDICT');
    expect(verdict.result?.verdict).toBe('MATCH');
    expect(verdict.result?.selectedSku).toBe('SKU-B');
    expect(verdict.result?.visualSupport).toBe('STRONG');
    expect(verdict.result?.reasonCodes).toEqual([
      'REFERENCE_VISUAL_MATCH',
      'OCR_TEXT_MATCH',
    ]);
    expect(verdict.result?.requiresHumanReview).toBe(false);
    expect(verdict.modelKey).toBe('test-vision:7b');
  });

  it('verify: AMBIGUOUS and UNKNOWN are valid verdicts with a null selectedSku', async () => {
    for (const kind of ['AMBIGUOUS', 'UNKNOWN'] as const) {
      const verdict = await verifyWithContent(
        strictJson({
          verdict: kind,
          selectedSku: null,
          visualSupport: 'WEAK',
          reasonCodes: ['MULTIPLE_SIMILAR_CANDIDATES'],
          requiresHumanReview: true,
        }),
      );
      expect(verdict.status).toBe('VERDICT');
      expect(verdict.result?.verdict).toBe(kind);
      expect(verdict.result?.selectedSku).toBeNull();
    }
  });

  it('verify: each failure mode carries its EXACT classification, never a generic unavailable', async () => {
    const cases: { content: string; status: string }[] = [
      // Invented SKU: valid shape, whitelisted candidate missing.
      { content: strictJson({ selectedSku: 'NOT-OFFERED' }), status: 'INVALID_SKU' },
      // selectedSku must be null unless verdict is MATCH.
      {
        content: strictJson({ verdict: 'UNKNOWN', selectedSku: 'SKU-A' }),
        status: 'INVALID_SCHEMA',
      },
      // MATCH without a selectedSku.
      { content: strictJson({ selectedSku: null }), status: 'INVALID_SCHEMA' },
      // Unknown enum value.
      { content: strictJson({ visualSupport: 'HUGE' }), status: 'INVALID_SCHEMA' },
      // Free-form reason codes are rejected.
      {
        content: strictJson({ reasonCodes: ['because it looks right'] }),
        status: 'INVALID_SCHEMA',
      },
      // Prose-only answer.
      { content: 'It is probably the water bottle.', status: 'MALFORMED_RESPONSE' },
      // Looks like JSON but does not parse.
      { content: '{"verdict": "MATCH", "selectedSku": }', status: 'INVALID_JSON' },
      // Empty completion text.
      { content: '', status: 'MALFORMED_RESPONSE' },
    ];
    for (const { content, status } of cases) {
      const verdict = await verifyWithContent(content);
      expect(verdict.status).toBe(status);
      expect(verdict.result).toBeNull();
      expect(verdict.errorDetail).toBeTruthy();
    }
  });

  it('verify: the RETIRED {choice, confidence} shape is rejected by default', async () => {
    const verdict = await verifyWithContent(
      '{"choice":"SKU-B","confidence":0.7,"reasoning":"label matches"}',
    );
    expect(verdict.status).toBe('INVALID_SCHEMA');
    expect(verdict.errorDetail).toContain('legacy');
  });

  it('verify: legacy shape maps ONLY in explicit local-dev compat mode — and never auto-cleanly', async () => {
    const mapped = await verifyWithContent(
      '{"choice":"SKU-B","confidence":0.7,"reasoning":"label matches"}',
      { legacyCompat: true },
    );
    expect(mapped.status).toBe('VERDICT');
    expect(mapped.result?.verdict).toBe('MATCH');
    expect(mapped.result?.selectedSku).toBe('SKU-B');
    expect(mapped.result?.reasonCodes).toContain('LEGACY_SCHEMA_MAPPED');
    // Mapped answers are always review-flagged — they can never auto-propose.
    expect(mapped.result?.requiresHumanReview).toBe(true);

    // Invented SKUs stay rejected even in compat mode.
    const invented = await verifyWithContent(
      '{"choice":"NOT-OFFERED","confidence":0.9,"reasoning":"x"}',
      { legacyCompat: true },
    );
    expect(invented.status).toBe('INVALID_SKU');
  });

  it('verify: ```json fences are stripped in local mode, schema still strictly enforced', async () => {
    const fenced = await verifyWithContent(
      '```json\n' + strictJson({ selectedSku: 'SKU-A' }) + '\n```',
    );
    expect(fenced.status).toBe('VERDICT');
    expect(fenced.result?.selectedSku).toBe('SKU-A');
    expect(fenced.rawPreview).toContain('SKU-A');

    const fencedInvalid = await verifyWithContent(
      '```json\n' + strictJson({ selectedSku: 'NOT-OFFERED' }) + '\n```',
    );
    expect(fencedInvalid.status).toBe('INVALID_SKU');
  });

  it('media boundary: a non-loopback base URL is refused before any image byte is sent', async () => {
    const remote = {
      get: (key: string) =>
        key === 'PICKUP_VLM_BASE_URL'
          ? 'http://vlm.example.com:11434'
          : key === 'PICKUP_VLM_MODEL'
            ? 'test-vision:7b'
            : undefined,
    } as unknown as ConfigService;
    const verifier = new OllamaVlmVerifier(remote);
    const readiness = await verifier.readiness();
    expect(readiness.serverReachable).toBe(false);
    expect(readiness.classification).toBe('PROVIDER_UNREACHABLE');
    const verdict = await verifier.verify(EVIDENCE, 5000);
    expect(verdict.status).toBe('PROVIDER_UNREACHABLE');
    expect(verdict.errorDetail).toContain('loopback');
  });

  it('verify: unreachable server → PROVIDER_UNREACHABLE; missing model → MODEL_NOT_FOUND', async () => {
    const unreachable = new OllamaVlmVerifier(configFor(null));
    const verdictUnreachable = await unreachable.verify(EVIDENCE, 5000);
    expect(verdictUnreachable.status).toBe('PROVIDER_UNREACHABLE');

    const { server, port } = await stubOllama({
      tags: () => ({ models: [{ name: 'llama3:8b' }] }),
    });
    const wrongModel = new OllamaVlmVerifier(configFor(port));
    const verdictMissing = await wrongModel.verify(EVIDENCE, 5000);
    server.close();
    expect(verdictMissing.status).toBe('MODEL_NOT_FOUND');
    expect(verdictMissing.errorDetail).toContain('llama3:8b');
  });

  it('verify: provider HTTP error → PROVIDER_ERROR with the status in the detail', async () => {
    const { server, port } = await stubOllama({
      tags: () => ({ models: [{ name: 'test-vision:7b' }] }),
      chatStatus: 500,
      chat: () => ({ error: 'GPU out of memory' }),
    });
    const verifier = new OllamaVlmVerifier(configFor(port));
    const verdict = await verifier.verify(EVIDENCE, 5000);
    server.close();
    expect(verdict.status).toBe('PROVIDER_ERROR');
    expect(verdict.errorDetail).toContain('HTTP 500');
  });

  it('verify: stalled server → TIMEOUT (never a thrown store failure)', async () => {
    const { server, port } = await stubOllama({ stall: true });
    // Readiness must pass to reach the chat call, so serve tags first,
    // then stall: easiest is a dedicated verifier whose readiness is
    // stubbed true.
    const verifier = new OllamaVlmVerifier(configFor(port));
    (verifier as unknown as { readiness: () => Promise<unknown> }).readiness =
      async () => ({
        serverReachable: true,
        modelAvailable: true,
        availableModels: ['test-vision:7b'],
        classification: 'READY',
        lastInference: null,
      });
    const verdict = await verifier.verify(EVIDENCE, 300);
    server.close();
    expect(verdict.status).toBe('TIMEOUT');
    expect(verdict.errorDetail).toContain('300 ms');
  }, 10_000);

  it('readiness: reports classification and remembers the last inference outcome', async () => {
    const { server, port } = await stubOllama({
      tags: () => ({ models: [{ name: 'test-vision:7b' }] }),
      chat: () => ({ message: { content: strictJson() } }),
    });
    const verifier = new OllamaVlmVerifier(configFor(port));
    const cold = await verifier.readiness();
    expect(cold.classification).toBe('READY');
    expect(cold.lastInference).toBeNull();
    await verifier.verify(EVIDENCE, 5000);
    const warm = await verifier.readiness();
    server.close();
    expect(warm.lastInference?.status).toBe('VERDICT');
    expect(typeof warm.lastInference?.latencyMs).toBe('number');
  });
});
