import { ConfigService } from '@nestjs/config';
import {
  parseVlmProviderKey,
  selectVlmVerifier,
} from './vlm-provider';

/**
 * The keyed VLM port selection (PICKUP_VLM_PROVIDER): the registry — not
 * the orchestration service — is the only place that knows the concrete
 * vendors, and it maps each vendor's readiness onto one neutral shape.
 */

function config(provider?: string): ConfigService {
  return {
    get: (key: string) =>
      key === 'PICKUP_VLM_PROVIDER' ? provider : undefined,
  } as unknown as ConfigService;
}

function fakeAnthropic(ready: boolean) {
  return {
    adapterKey: 'anthropic-vlm',
    version: '2.0.0',
    checkReady: jest.fn(async () => ready),
    verify: jest.fn(),
  };
}

function fakeOllama() {
  return {
    adapterKey: 'ollama-local',
    version: '2.0.0',
    model: 'test-vision:7b',
    baseUrl: 'http://127.0.0.1:11434',
    readiness: jest.fn(async () => ({
      serverReachable: true,
      modelAvailable: false,
      availableModels: ['other-model:3b'],
      classification: 'MODEL_NOT_FOUND' as const,
      lastInference: { status: 'TIMEOUT', latencyMs: 60_000, at: '2026-08-11T00:00:00.000Z' },
    })),
    checkReady: jest.fn(),
    verify: jest.fn(),
  };
}

describe('parseVlmProviderKey', () => {
  it('only the exact "anthropic" opts into the cloud vendor — everything else is local', () => {
    expect(parseVlmProviderKey('anthropic')).toBe('anthropic');
    expect(parseVlmProviderKey('local')).toBe('local');
    expect(parseVlmProviderKey(undefined)).toBe('local');
    expect(parseVlmProviderKey('Anthropic')).toBe('local');
  });
});

describe('selectVlmVerifier', () => {
  it('default selection is the LOCAL port — no paid API implicitly', () => {
    const ollama = fakeOllama();
    const selected = selectVlmVerifier(
      config(undefined),
      fakeAnthropic(true) as never,
      ollama as never,
    );
    expect(selected.provider).toBe('local');
    expect(selected.verifier).toBe(ollama);
  });

  it('PICKUP_VLM_PROVIDER=anthropic selects the cloud port', () => {
    const anthropic = fakeAnthropic(true);
    const selected = selectVlmVerifier(
      config('anthropic'),
      anthropic as never,
      fakeOllama() as never,
    );
    expect(selected.provider).toBe('anthropic');
    expect(selected.verifier).toBe(anthropic);
  });

  it('local readiness maps the Ollama surface (model, baseUrl, tags, warm-up signal) unchanged', async () => {
    const ollama = fakeOllama();
    const selected = selectVlmVerifier(
      config('local'),
      fakeAnthropic(false) as never,
      ollama as never,
    );
    await expect(selected.readiness()).resolves.toEqual({
      model: 'test-vision:7b',
      baseUrl: 'http://127.0.0.1:11434',
      serverReachable: true,
      modelAvailable: false,
      availableModels: ['other-model:3b'],
      classification: 'MODEL_NOT_FOUND',
      lastInference: { status: 'TIMEOUT', latencyMs: 60_000, at: '2026-08-11T00:00:00.000Z' },
    });
  });

  it('anthropic readiness collapses onto key presence (no paid call from readiness)', async () => {
    for (const ready of [true, false]) {
      const selected = selectVlmVerifier(
        config('anthropic'),
        fakeAnthropic(ready) as never,
        fakeOllama() as never,
      );
      await expect(selected.readiness()).resolves.toEqual({
        model: null,
        baseUrl: null,
        serverReachable: ready,
        modelAvailable: ready,
        availableModels: [],
        classification: ready ? 'READY' : 'PROVIDER_UNREACHABLE',
        lastInference: null,
      });
    }
  });
});
