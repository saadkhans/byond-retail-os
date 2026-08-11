import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_ANALYSIS_FPS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  PickupDetectionConfig,
} from './pickup-detection.config';

function configWith(env: Record<string, string | undefined>) {
  return new PickupDetectionConfig({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

describe('PickupDetectionConfig', () => {
  it('defaults: disabled, lab mode OFF, safe analysis knobs', () => {
    const config = configWith({});
    expect(config.enabled).toBe(false);
    expect(config.labMode).toBe(false);
    expect(config.analysisFps).toBe(DEFAULT_ANALYSIS_FPS);
    expect(config.confidenceThreshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it('reads PICKUP_LAB_MODE with the shared strict-boolean semantics', () => {
    expect(configWith({ PICKUP_LAB_MODE: 'true' }).labMode).toBe(true);
    expect(configWith({ PICKUP_LAB_MODE: 'TRUE' }).labMode).toBe(true);
    expect(configWith({ PICKUP_LAB_MODE: 'false' }).labMode).toBe(false);
    // Fails closed on anything but the validated true spelling.
    expect(configWith({ PICKUP_LAB_MODE: 'yes' }).labMode).toBe(false);
  });

  it('reads PICKUP_DETECTION_ENABLED with the same semantics', () => {
    expect(
      configWith({ PICKUP_DETECTION_ENABLED: 'true' }).enabled,
    ).toBe(true);
    expect(
      configWith({ PICKUP_DETECTION_ENABLED: 'yes' }).enabled,
    ).toBe(false);
  });

  it('falls back to defaults on out-of-bounds analysis knobs', () => {
    const config = configWith({
      PICKUP_ANALYSIS_FPS: '99',
      PICKUP_CONFIDENCE_THRESHOLD: '7',
    });
    expect(config.analysisFps).toBe(DEFAULT_ANALYSIS_FPS);
    expect(config.confidenceThreshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });
});
