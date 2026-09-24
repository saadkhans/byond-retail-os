import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { SlidingWindowThrottle } from '../../common/sliding-window-throttle';

/**
 * Sliding-window throttle for the public login endpoint with TWO buckets,
 * both of which must have headroom:
 * - per IP + attempted email — bounds guessing against one account
 * - per IP total — bounds credential stuffing that rotates email addresses
 *   and the bcrypt work a single source can trigger
 *
 * The window itself lives in SlidingWindowThrottle, which the shopper
 * surface's throttle shares — one mechanism, two policies.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly throttle = new SlidingWindowThrottle();

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

    const admitted = this.throttle.consume(
      [
        { key: `email|${ip}|${email}`, limit: emailLimit },
        { key: `ip|${ip}`, limit: ipLimit },
      ],
      windowMs,
    );
    if (!admitted) {
      throw new HttpException(
        'Too many login attempts, please try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
