/**
 * The PLATFORM SANDBOX tenant: a dedicated, seeded tenant that platform
 * (BYOND staff) users operate in when they call tenant-scoped endpoints.
 *
 * Platform users carry no tenant of their own (tenantId NULL — platform
 * scope, never a wildcard). Instead of granting them cross-tenant access,
 * the auth guard resolves their request context to THIS tenant when — and
 * only when — a tenant with this fixed slug exists and is ACTIVE:
 *
 *  - the local platform admin can exercise tenant-scoped workflows (the
 *    Phase 10 controlled test-video ingestion flow in particular) against
 *    sandbox data it stages itself;
 *  - customer tenants stay unreachable to platform users — the sandbox is
 *    the ONLY tenant a platform user ever resolves to, so tenant isolation
 *    is not weakened anywhere;
 *  - environments that never seed the sandbox keep the previous fail-closed
 *    behaviour: no tenant context, and every tenant-scoped guard denies.
 *
 * Resolution is strictly SERVER-SIDE (this fixed slug looked up in the
 * database) — never from request headers, bodies, or token claims. The
 * sandbox is created exclusively by the seed script, behind the same
 * explicit SEED_PLATFORM_ADMIN opt-in that creates the platform admin, and
 * tenant creation itself is a platform-only endpoint — a tenant user can
 * never mint or squat this slug.
 */
export const PLATFORM_SANDBOX_TENANT_SLUG = 'platform-sandbox';

export const PLATFORM_SANDBOX_TENANT_NAME =
  'Platform Sandbox (staff-staged test data only)';
