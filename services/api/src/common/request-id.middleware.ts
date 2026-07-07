import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Response } from 'express';
import { RequestWithContext } from '../auth/request-context';

const REQUEST_ID_HEADER = 'x-request-id';
// Accept only well-formed client-supplied ids; anything else is replaced.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithContext, res: Response, next: NextFunction): void {
    const supplied = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
    const requestId =
      candidate && REQUEST_ID_PATTERN.test(candidate)
        ? candidate
        : randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
