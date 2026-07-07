import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginThrottleGuard } from './login-throttle.guard';

function contextFor(ip: string, email?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ip, body: email ? { email } : {} }),
    }),
  } as unknown as ExecutionContext;
}

describe('LoginThrottleGuard', () => {
  let guard: LoginThrottleGuard;

  beforeEach(() => {
    const values: Record<string, number> = {
      LOGIN_THROTTLE_LIMIT: 3,
      LOGIN_THROTTLE_IP_LIMIT: 5,
      LOGIN_THROTTLE_WINDOW_MS: 60_000,
    };
    const config = { get: (key: string) => values[key] };
    guard = new LoginThrottleGuard(config as unknown as ConfigService);
  });

  it('allows attempts up to the limit, then throttles with 429', () => {
    const ctx = contextFor('10.0.0.1', 'jane@example.com');

    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);

    let thrown: unknown;
    try {
      guard.canActivate(ctx);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
  });

  it('tracks different email keys independently', () => {
    const jane = contextFor('10.0.0.1', 'jane@example.com');
    const john = contextFor('10.0.0.1', 'john@example.com');

    for (let i = 0; i < 3; i += 1) {
      expect(guard.canActivate(jane)).toBe(true);
    }
    // jane is now exhausted; john is untouched.
    expect(() => guard.canActivate(jane)).toThrow(HttpException);
    expect(guard.canActivate(john)).toBe(true);
  });

  it('tracks different IPs independently', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(guard.canActivate(contextFor('10.0.0.1', 'x@example.com'))).toBe(
        true,
      );
    }
    expect(() =>
      guard.canActivate(contextFor('10.0.0.1', 'x@example.com')),
    ).toThrow(HttpException);
    expect(guard.canActivate(contextFor('10.0.0.2', 'x@example.com'))).toBe(
      true,
    );
  });

  it('rotating email addresses cannot evade the per-IP bucket', () => {
    // 5 attempts against 5 DIFFERENT emails from one IP — each email bucket
    // is fresh, but the IP bucket fills up.
    for (let i = 0; i < 5; i += 1) {
      expect(
        guard.canActivate(contextFor('10.0.0.7', `victim-${i}@example.com`)),
      ).toBe(true);
    }

    // 6th rotated email: fresh email bucket, exhausted IP bucket → 429.
    let thrown: unknown;
    try {
      guard.canActivate(contextFor('10.0.0.7', 'victim-99@example.com'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);

    // A different source IP is unaffected.
    expect(
      guard.canActivate(contextFor('10.0.0.8', 'victim-99@example.com')),
    ).toBe(true);
  });

  it('releases attempts after the window expires', () => {
    const ctx = contextFor('10.0.0.9', 'expiry@example.com');
    const start = 1_750_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);

    try {
      for (let i = 0; i < 3; i += 1) {
        expect(guard.canActivate(ctx)).toBe(true);
      }
      expect(() => guard.canActivate(ctx)).toThrow(HttpException);

      // One window later the counter has slid out.
      nowSpy.mockReturnValue(start + 60_001);
      expect(guard.canActivate(ctx)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
