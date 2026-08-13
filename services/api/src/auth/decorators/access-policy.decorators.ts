import { SetMetadata } from '@nestjs/common';

/** Marks a route as reachable without authentication (health, login). */
export const IS_PUBLIC_KEY = 'byond:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route requires ALL listed permission codes (from the code catalog). */
export const REQUIRED_PERMISSIONS_KEY = 'byond:requiredPermissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/** Route is restricted to platform (BYOND staff) users. */
export const PLATFORM_ONLY_KEY = 'byond:platformOnly';
export const PlatformOnly = () => SetMetadata(PLATFORM_ONLY_KEY, true);

/**
 * Route requires a RESOLVED tenant context. Tenant users always carry one
 * (their own tenant). Platform users carry one only when the platform
 * sandbox tenant is seeded (local development — see
 * ../../tenants/platform-sandbox); they then operate on SANDBOX data only,
 * never on customer tenants. Without a resolved tenant the route denies.
 */
export const TENANT_ONLY_KEY = 'byond:tenantOnly';
export const TenantOnly = () => SetMetadata(TENANT_ONLY_KEY, true);

/**
 * Route requires the named platform module to be ENABLED for the caller's
 * tenant. A tenant that has not enabled (or has disabled) the module is denied
 * even if it holds the relevant RBAC permissions — enforced by
 * ModuleEnabledGuard.
 */
export const REQUIRED_MODULE_KEY = 'byond:requiredModule';
export const RequireModule = (moduleCode: string) =>
  SetMetadata(REQUIRED_MODULE_KEY, moduleCode);
