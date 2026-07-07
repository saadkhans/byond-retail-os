import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * In-memory sliding-window throttle for the public login endpoint with TWO
 * buckets, both of which must have headroom:
 * - per IP + attempted email — bounds guessing against one account
 * - per IP total — bounds credential stuffing that rotates email addresses
 *   and the bcrypt work a single source can trigger
 *
 * PRODUCTION NOTE: this store is per-process. Multi-instance deployments
 * need shared (e.g. Redis-backed) throttling in a later phase — this guard
 * is the app-level control, not the final distributed one.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly config: ConfigService) {}

  canActivate(executionContext: ExecutionContext): boolean {
    const emailLimit = this.config.get<number>('LOGIN_THROTTLE_LIMIT') ?? 5;
    const ipLimit =
      this.config.get<number>('LOGIN_THROTTLE_IP_LIMIT') ?? emailLimit * 4;
    const windowMs =
      this.config.get<number>('LOGIN_THROTTLE_WINDOW_MS') ?? 60_000;

    const request = executionContext.switchToHttp().getRequest<Request>();
    const email =
      typeof (request.body as Record<string, unknown> | undefined)?.email ===
      'string'
        ? String((request.body as Record<string, unknown>).email).toLowerCase()
        : '';
    const ip = request.ip ?? 'unknown';
    const emailKey = `email|${ip}|${email}`;
    const ipKey = `ip|${ip}`;

    const now = Date.now();
    const recentByEmail = this.recentAttempts(emailKey, now, windowMs);
    const recentByIp = this.recentAttempts(ipKey, now, windowMs);

    // Reject when EITHER bucket is exhausted; a throttled attempt is not
    // recorded, so the window slides out naturally.
    if (recentByEmail.length >= emailLimit || recentByIp.length >= ipLimit) {
      throw new HttpException(
        'Too many login attempts, please try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recentByEmail.push(now);
    recentByIp.push(now);
    this.attempts.set(emailKey, recentByEmail);
    this.attempts.set(ipKey, recentByIp);
    this.pruneIfLarge(now, windowMs);
    return true;
  }

  private recentAttempts(
    key: string,
    now: number,
    windowMs: number,
  ): number[] {
    const recent = (this.attempts.get(key) ?? []).filter(
      (timestamp) => now - timestamp < windowMs,
    );
    this.attempts.set(key, recent);
    return recent;
  }

  private pruneIfLarge(now: number, windowMs: number): void {
    if (this.attempts.size <= 10_000) {
      return;
    }
    for (const [key, timestamps] of this.attempts) {
      const live = timestamps.filter((timestamp) => now - timestamp < windowMs);
      if (live.length === 0) {
        this.attempts.delete(key);
      } else {
        this.attempts.set(key, live);
      }
    }
  }
}
