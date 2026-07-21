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
  { code: 'catalog:read', module: 'inventory', description: 'View product categories, brands, products, and barcodes' },
  { code: 'catalog:manage', module: 'inventory', description: 'Create, update, delete catalog entities' },
  { code: 'inventory:read', module: 'inventory', description: 'View stock levels and the inventory movement ledger' },
  { code: 'inventory:adjust', module: 'inventory', description: 'Perform manual stock adjustments' },
  { code: 'unit:read', module: 'devices', description: 'View autonomous retail units' },
  { code: 'unit:manage', module: 'devices', description: 'Create, update, delete retail units' },
  { code: 'device:read', module: 'devices', description: 'View devices' },
  { code: 'device:manage', module: 'devices', description: 'Create, update, delete devices' },
  { code: 'device:register', module: 'devices', description: 'Issue one-time edge registration tokens for devices' },
  { code: 'device:heartbeat', module: 'devices', description: 'Record device heartbeats' },
  { code: 'checkout:read', module: 'checkout', description: 'View checkout sessions and basket lines' },
  { code: 'checkout:manage', module: 'checkout', description: 'Create checkout sessions, mutate basket lines, and complete sessions into orders' },
  { code: 'order:read', module: 'checkout', description: 'View orders and order lines' },
  { code: 'order:manage', module: 'checkout', description: 'Cancel orders (no payment operations in Phase 5)' },
  { code: 'payment:read', module: 'payments', description: 'View payment intents, authorizations, captures, and events' },
  { code: 'payment:manage', module: 'payments', description: 'Create payment intents and manage their linkage (no live gateway)' },
  { code: 'payment:simulate', module: 'payments', description: 'Simulate provider-abstract authorization, capture, cancel/void, failure, and provider events' },
  { code: 'reconciliation:read', module: 'payments', description: 'View payment reconciliation records' },
  { code: 'reconciliation:manage', module: 'payments', description: 'Update reconciliation record status (mark reconciled/mismatch — no settlement accounting)' },
  { code: 'vision:read', module: 'cv', description: 'View vision events, SKU candidates, reviews, and evidence bundle lineage records' },
  { code: 'vision:ingest', module: 'cv', description: 'Ingest normalized product interaction events (with lineage-only evidence bundles) from vision adapters' },
  { code: 'vision:review', module: 'cv', description: 'Approve, reject, or manually override vision events, applying approved events to checkout baskets' },
];
