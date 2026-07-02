/**
 * Permission catalog — the single source of truth. The Permission table is
 * seeded FROM this constant; permission codes are never hand-typed elsewhere,
 * which prevents string drift between code and database.
 */
export interface PermissionDefinition {
  readonly code: string;
  readonly module: string;
  readonly description: string;
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  { code: 'tenant:read', module: 'core', description: 'View tenant details' },
  { code: 'tenant:manage', module: 'core', description: 'Create, update, suspend tenants' },
  { code: 'user:read', module: 'core', description: 'View users' },
  { code: 'user:manage', module: 'core', description: 'Create, update, deactivate users' },
  { code: 'role:read', module: 'core', description: 'View roles and their permissions' },
  { code: 'role:manage', module: 'core', description: 'Create roles, assign permissions and users' },
  { code: 'permission:read', module: 'core', description: 'View the permission catalog' },
  { code: 'location:read', module: 'core', description: 'View locations' },
  { code: 'location:manage', module: 'core', description: 'Create and update locations' },
  { code: 'module:read', module: 'core', description: 'View platform modules and tenant enablement' },
  { code: 'module:manage', module: 'core', description: 'Enable or disable modules for a tenant' },
  { code: 'audit:read', module: 'core', description: 'View audit logs' },
];
