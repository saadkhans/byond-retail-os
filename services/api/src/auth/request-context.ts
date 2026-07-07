import { UserType } from '@prisma/client';
import { Request } from 'express';

/**
 * Per-request identity established by the auth guard. This is the ONLY
 * source of tenant context for handlers and services — tenantId is copied
 * from the authenticated user's database record, never from request bodies,
 * query strings, or client-controlled headers.
 */
export interface RequestContext {
  userId: string;
  email: string;
  userType: UserType;
  /** Non-null only for tenant users. NULL means platform scope — never a wildcard. */
  tenantId: string | null;
  /** Effective permission codes resolved from the user's roles at request time. */
  permissions: readonly string[];
  /** Correlation id (X-Request-Id response header). */
  requestId: string;
}

export interface RequestWithContext extends Request {
  context?: RequestContext;
  requestId?: string;
}
