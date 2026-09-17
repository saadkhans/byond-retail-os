import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { createHash } from 'node:crypto';
import { SlidingWindowThrottle } from '../../common/sliding-window-throttle';

/**
 * The one answer a rate-limited shopper request gets, for every route and
 * every bucket. It says nothing about the request that earned it: not
 * whether a code was real, not which bucket filled, not how long is left.
 */
export const SHOPPER_THROTTLED = 'Too many requests, please try again later';

/**
 * Defaults, per window.
 *
 * SESSION is the tightest: it is the credential-redemption surface and a
 * real shopper redeems once per visit. The allowance still covers a mistyped
 * code, a retry on a flaky connection, and several people arriving at a door
 * together behind one NAT address.
 *
 * VISIT is looser because the shopper app polls its own basket every few
 * seconds for the length of a visit, and because both of its routes already
 * require a redeemed credential. The per-credential bucket is the one a real
 * shopper meets; the per-IP bucket exists so rotating credentials cannot
 * evade it, and is sized for a storeful of phones behind one address.
 */
export const DEFAULT_SHOPPER_SESSION_THROTTLE_LIMIT = 30;
export const DEFAULT_SHOPPER_VISIT_THROTTLE_LIMIT = 60;
export const DEFAULT_SHOPPER_VISIT_IP_THROTTLE_LIMIT = 600;
export const DEFAULT_SHOPPER_THROTTLE_WINDOW_MS = 60_000;

/**
 * The rate limit on the repository's only unauthenticated commerce surface.
 *
 * WHY. Phase 35's three routes are public by necessity and reachable from
 * any phone on the store wifi. `POST /shopper/session` validates a secret;
 * the other two authenticate by presenting one. Until this guard,
 * `LOGIN_THROTTLE_*` covered `/auth/login` and nothing covered these.
 *
 * It lives beside LoginThrottleGuard rather than in the shopper module for
 * the same reason it exists: shopper/boundary.spec.ts pins that module as a
 * read-only, write-free, single-public-file surface, and a guard that hashes
 * a header has no business inside those pins.
 *
 * IT IS THE LOGIN THROTTLE, NOT A SECOND ONE. The sliding window is the
 * shared `SlidingWindowThrottle`; only the bucket policy differs.
 *
 * ── The policy, and why each bucket is keyed the way it is ──────────────
 *
 * `session` (POST /shopper/session) — ONE bucket, keyed on the client IP
 * ALONE, and deliberately the tightest limit. There is no second bucket
 * because there is nothing else to key on: unlike a login, which names an
 * email, a redemption presents only the secret being guessed. Keying on that
 * secret would hand every guess a fresh budget — the opposite of a limit.
 *
 * `visit` (GET /shopper/basket, POST /shopper/exit) — TWO buckets, exactly
 * as login has two: a per-credential one that bounds what a single phone can
 * do (the app polls its own basket every few seconds, so this is the bucket
 * a real shopper ever meets), and a wider per-IP one so rotating credentials
 * cannot evade it. Both must have headroom.
 *
 * ── Why this is not an oracle ───────────────────────────────────────────
 *
 * Every session failure answers with ONE message, so the surface cannot be
 * probed for which secrets exist, which tenants are active, which modules
 * are on, or when a credential expired (see shopper.constants.ts). A
 * throttle that behaved differently for a real code than for a made-up one
 * would put that property back in the bin. Three things keep it:
 *
 *   1. The decision reads the request's IP and — for `visit` — a DIGEST of
 *      whatever was presented as a credential. It never reads the body, never
 *      compares a secret, and never touches the database, so no part of the
 *      answer can depend on whether a code is real.
 *   2. EVERY request is charged, not just failing ones. A throttle that
 *      counted only failures would make "this request was not counted" mean
 *      "that code was real".
 *   3. The 429 is one fixed message for every bucket and every route, and it
 *      is thrown BEFORE the handler — so a throttled request costs the same
 *      lookup-free, constant time whatever was in it.
 *
 * A credential fingerprint is a SHA-256 digest, never the secret itself: the
 * throttle keeps its keys in memory for a window, and that memory should no
 * more hold a live credential than a log line should.
 */

/** Metadata key naming which bucket policy a shopper route falls under. */
export const SHOPPER_THROTTLE_SCOPE = 'shopper:throttle-scope';

export type ShopperThrottleScope = 'session' | 'visit';

/**
 * Declare a shopper route's throttle policy. A route that forgets to is
 * treated as `session` — the tightest — because the failure mode of
 * guessing wrong must be a limit that is too strict, never one that is
 * absent.
 */
export const ShopperThrottle = (scope: ShopperThrottleScope) =>
  SetMetadata(SHOPPER_THROTTLE_SCOPE, scope);

@Injectable()
export class ShopperThrottleGuard implements CanActivate {
  private readonly throttle = new SlidingWindowThrottle();

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(executionContext: ExecutionContext): boolean {
    const scope =
      this.reflector.getAllAndOverride<ShopperThrottleScope>(
        SHOPPER_THROTTLE_SCOPE,
        [executionContext.getHandler(), executionContext.getClass()],
      ) ?? 'session';
    const windowMs =
      this.config.get<number>('SHOPPER_THROTTLE_WINDOW_MS') ??
      DEFAULT_SHOPPER_THROTTLE_WINDOW_MS;
    const request = executionContext.switchToHttp().getRequest<Request>();
    const ip = request.ip ?? 'unknown';

    if (!this.throttle.consume(this.bucketsFor(scope, ip, request), windowMs)) {
      throw new HttpException(SHOPPER_THROTTLED, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private bucketsFor(
    scope: ShopperThrottleScope,
    ip: string,
    request: Request,
  ) {
    if (scope === 'session') {
      return [
        {
          key: `shopper-session|${ip}`,
          limit:
            this.config.get<number>('SHOPPER_SESSION_THROTTLE_LIMIT') ??
            DEFAULT_SHOPPER_SESSION_THROTTLE_LIMIT,
        },
      ];
    }
    return [
      {
        key: `shopper-visit|${ip}`,
        limit:
          this.config.get<number>('SHOPPER_VISIT_IP_THROTTLE_LIMIT') ??
          DEFAULT_SHOPPER_VISIT_IP_THROTTLE_LIMIT,
      },
      {
        key: `shopper-credential|${this.fingerprint(ip, request)}`,
        limit:
          this.config.get<number>('SHOPPER_VISIT_THROTTLE_LIMIT') ??
          DEFAULT_SHOPPER_VISIT_THROTTLE_LIMIT,
      },
    ];
  }

  /**
   * A stable, non-reversible handle on "the same caller", derived from the
   * whole Authorization header — the guard never parses it, because parsing
   * is the service's job and a parse result is something an attacker could
   * measure. A request with no credential falls back to its IP, so the
   * credential-less requests of one source cannot exhaust everyone else's
   * bucket.
   */
  private fingerprint(ip: string, request: Request): string {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || authorization.length === 0) {
      return `none|${ip}`;
    }
    return createHash('sha256').update(authorization).digest('hex');
  }
}
