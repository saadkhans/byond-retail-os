import { UserType } from '@prisma/client';
import { Request } from 'express';

/**
 * Per-request identity established by the auth guard. This is the ONLY
 * source of tenant context for handlers and services — tenantId is resolved
 * server-side (the authenticated user's database record for tenant users;
 * the seeded platform sandbox tenant for platform users), never from
 * request bodies, query strings, or client-controlled headers.
 */
export interface RequestContext {
  userId: string;
  email: string;
  userType: UserType;
  /**
   * Resolved tenant context. Tenant users: their own tenant (database
   * record). Platform users: the seeded PLATFORM SANDBOX tenant when it
   * exists and is ACTIVE (see ../tenants/platform-sandbox), else NULL.
   * NULL is never a wildcard — tenant-scoped guards fail closed on it.
   */
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
