import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  SHOPPER_THROTTLED,
  ShopperThrottleGuard,
  ShopperThrottleScope,
} from './shopper-throttle.guard';

/**
 * The limit on the only unauthenticated commerce surface, and — as much as
 * anything — the proof that it did not become an oracle. The shopper module
 * answers every session failure with ONE message precisely so the surface
 * cannot be probed; a throttle that behaved differently for a real code than
 * for a made-up one would give that back.
 */

/**
 * A context whose request records what the guard touched. `body` is a
 * getter that FAILS the test if read: the decision must not depend on
 * anything the caller could vary to learn something.
 */
function contextFor(
  scope: ShopperThrottleScope | undefined,
  ip: string,
  authorization?: string,
): ExecutionContext {
  const request = {
    ip,
    headers: authorization === undefined ? {} : { authorization },
    get body(): never {
      throw new Error('the shopper throttle must never read the request body');
    },
  };
  return {
    getHandler: () => () => undefined,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardFor(
  values: Record<string, number>,
  scope: ShopperThrottleScope | undefined,
): ShopperThrottleGuard {
  const config = { get: (key: string) => values[key] };
  const reflector = { getAllAndOverride: () => scope };
  return new ShopperThrottleGuard(
    config as unknown as ConfigService,
    reflector as unknown as Reflector,
  );
}

const LIMITS = {
  SHOPPER_SESSION_THROTTLE_LIMIT: 3,
  SHOPPER_VISIT_THROTTLE_LIMIT: 4,
  SHOPPER_VISIT_IP_THROTTLE_LIMIT: 7,
  SHOPPER_THROTTLE_WINDOW_MS: 60_000,
};

function statusOf(call: () => boolean): number | 'allowed' {
  try {
    call();
    return 'allowed';
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    throw error;
  }
}

describe('ShopperThrottleGuard — POST /shopper/session', () => {
  it('admits attempts up to the limit, then answers 429', () => {
    const guard = guardFor(LIMITS, 'session');
    const ctx = contextFor('session', '10.0.0.1');

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
    expect((thrown as HttpException).message).toBe(SHOPPER_THROTTLED);
  });

  it('is not an oracle: the decision cannot depend on the code presented', () => {
    const guard = guardFor(LIMITS, 'session');
    // Four requests from one source, each carrying a DIFFERENT credential —
    // one of which, in the real world, would be the genuine article. The
    // guard cannot tell, and does not look: `body` throws if read, and the
    // Authorization header plays no part in the session bucket.
    const codes = ['aaa', 'bbb', 'the-real-one', 'ccc'];
    const outcomes = codes.map((code) =>
      statusOf(() =>
        guard.canActivate(contextFor('session', '10.0.0.2', `Shopper ${code}`)),
      ),
    );
    // The answer is a pure function of how many requests this IP has made.
    expect(outcomes).toEqual(['allowed', 'allowed', 'allowed', 429]);
  });

  it('charges a rejected request to nobody, so a 429 does not extend itself', () => {
    const start = 1_750_000_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const guard = guardFor(LIMITS, 'session');
      const ctx = contextFor('session', '10.0.0.3');
      for (let i = 0; i < 3; i += 1) {
        expect(guard.canActivate(ctx)).toBe(true);
      }
      // Hammering while throttled does not push the window along.
      for (let i = 0; i < 5; i += 1) {
        expect(statusOf(() => guard.canActivate(ctx))).toBe(429);
      }
      now.mockReturnValue(start + 60_001);
      expect(guard.canActivate(ctx)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('tracks each source address on its own', () => {
    const guard = guardFor(LIMITS, 'session');
    for (let i = 0; i < 3; i += 1) {
      expect(guard.canActivate(contextFor('session', '10.0.0.4'))).toBe(true);
    }
    expect(statusOf(() => guard.canActivate(contextFor('session', '10.0.0.4')))).toBe(
      429,
    );
    expect(guard.canActivate(contextFor('session', '10.0.0.5'))).toBe(true);
  });

  it('is the policy an undecorated route falls back to', () => {
    // No metadata — the guard must choose the TIGHTEST bucket, never the
    // loosest, so a future shopper route that forgets the decorator is
    // over-protected rather than unprotected.
    const guard = guardFor(LIMITS, undefined);
    const ctx = contextFor(undefined, '10.0.0.6');
    for (let i = 0; i < 3; i += 1) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    expect(statusOf(() => guard.canActivate(ctx))).toBe(429);
  });

  it('falls back to safe defaults when nothing is configured', () => {
    const guard = guardFor({}, 'session');
    const ctx = contextFor('session', '10.0.0.7');
    // Default session limit is 30 per minute.
    for (let i = 0; i < 30; i += 1) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    expect(statusOf(() => guard.canActivate(ctx))).toBe(429);
  });
});

describe('ShopperThrottleGuard — GET /shopper/basket, POST /shopper/exit', () => {
  it('bounds one credential without touching another', () => {
    const guard = guardFor(LIMITS, 'visit');
    const alice = contextFor('visit', '10.0.1.1', 'Shopper alice-secret');
    const bob = contextFor('visit', '10.0.1.1', 'Shopper bob-secret');

    for (let i = 0; i < 4; i += 1) {
      expect(guard.canActivate(alice)).toBe(true);
    }
    expect(statusOf(() => guard.canActivate(alice))).toBe(429);
    // Two shoppers behind one store address: Bob's visit is unaffected by
    // Alice's polling until the wider IP bucket fills.
    expect(guard.canActivate(bob)).toBe(true);
  });

  it('cannot be evaded by rotating credentials — the IP bucket still fills', () => {
    const guard = guardFor(LIMITS, 'visit');
    for (let i = 0; i < 7; i += 1) {
      expect(
        guard.canActivate(contextFor('visit', '10.0.1.2', `Shopper code-${i}`)),
      ).toBe(true);
    }
    expect(
      statusOf(() =>
        guard.canActivate(contextFor('visit', '10.0.1.2', 'Shopper code-99')),
      ),
    ).toBe(429);
    // A different source address is untouched.
    expect(
      guard.canActivate(contextFor('visit', '10.0.1.3', 'Shopper code-99')),
    ).toBe(true);
  });

  it('gives a credential-less request its own per-source bucket', () => {
    const guard = guardFor(LIMITS, 'visit');
    for (let i = 0; i < 4; i += 1) {
      expect(guard.canActivate(contextFor('visit', '10.0.1.4'))).toBe(true);
    }
    expect(statusOf(() => guard.canActivate(contextFor('visit', '10.0.1.4')))).toBe(
      429,
    );
    // Another source's credential-less requests are not collateral.
    expect(guard.canActivate(contextFor('visit', '10.0.1.5'))).toBe(true);
  });

  it('never keys on the raw secret', () => {
    const guard = guardFor(LIMITS, 'visit');
    guard.canActivate(contextFor('visit', '10.0.1.6', 'Shopper top-secret'));
    const keys = [
      ...(
        guard as unknown as {
          throttle: { attempts: Map<string, number[]> };
        }
      ).throttle.attempts.keys(),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain('top-secret');
    }
    // The credential bucket is a digest, and the same credential is still
    // the same bucket.
    expect(keys.some((key) => /^shopper-credential\|[0-9a-f]{64}$/.test(key))).toBe(
      true,
    );
  });

  it('answers with the same message the session route gives', () => {
    const guard = guardFor(
      { ...LIMITS, SHOPPER_VISIT_THROTTLE_LIMIT: 1 },
      'visit',
    );
    const ctx = contextFor('visit', '10.0.1.7', 'Shopper x');
    expect(guard.canActivate(ctx)).toBe(true);
    let thrown: unknown;
    try {
      guard.canActivate(ctx);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as HttpException).message).toBe(SHOPPER_THROTTLED);
  });
});
