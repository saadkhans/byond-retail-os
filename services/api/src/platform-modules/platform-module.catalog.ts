/**
 * Platform module catalog — the single source of truth the seed reads from.
 * These are CATALOG NAMES ONLY: no module logic beyond `core` exists in
 * Phase 1. Inventory, pricing, checkout, CV, etc. are later phases.
 */
export interface PlatformModuleDefinition {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  /** Enabled for every new tenant at creation time. Requires isActive. */
  readonly defaultEnabled: boolean;
  /**
   * Only implemented modules are active. Inactive modules exist in the
   * catalog for visibility but can never be enabled for a tenant — flip this
   * to true only in the phase that actually ships the module.
   */
  readonly isActive: boolean;
}

export const PLATFORM_MODULE_CATALOG: readonly PlatformModuleDefinition[] = [
  {
    code: 'core',
    name: 'Core Platform',
    description: 'Tenant, user, role, location, and module management.',
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'inventory',
    name: 'Inventory',
    description:
      'Product catalog (categories, brands, products, barcodes) plus the ' +
      'append-only inventory ledger and stock level projections.',
    // Shipped in Phase 3 and DEFAULT-ENABLED so the catalog/inventory routes
    // are reachable for every new tenant. The only enable endpoint
    // (PlatformModulesController.enable) is @TenantOnly() and needs a tenant
    // user who already holds module:manage, so leaving this false stranded new
    // tenants behind 403s on the shipped feature. RBAC still gates every route
    // independently; a tenant can disable the module later via module:manage.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'devices',
    name: 'Units & Devices',
    description:
      'Autonomous retail units (smart fridges, shelves, kiosks, ...) and ' +
      'their devices, including heartbeats and the edge-registration ' +
      'foundation.',
    // Shipped in Phase 4 and DEFAULT-ENABLED for the same reason as
    // inventory (see above): the only enable endpoint is @TenantOnly(), so
    // leaving this false would strand new tenants behind 403s. RBAC still
    // gates every route independently. Tenants that existed BEFORE Phase 4
    // are covered by the 20260711000001_devices_module_backfill migration —
    // defaultEnabled only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'pricing',
    name: 'Pricing',
    description: 'Versioned, auditable pricing (later phase).',
    defaultEnabled: false,
    isActive: false,
  },
  {
    code: 'checkout',
    name: 'Checkout & Orders',
    description:
      'Checkout sessions, basket lines, and the order foundation (no ' +
      'payment capture; payments arrive in a later phase).',
    // Shipped in Phase 5 and DEFAULT-ENABLED for the same reason as
    // inventory/devices (see above): the only enable endpoint is
    // @TenantOnly(), so leaving this false would strand new tenants behind
    // 403s. RBAC still gates every route independently. Tenants that existed
    // BEFORE Phase 5 are covered by the 20260713000001_checkout_module_backfill
    // migration — defaultEnabled only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'payments',
    name: 'Payments & Reconciliation',
    description:
      'Provider-neutral payment intents, simulated authorization/capture, ' +
      'provider event ingestion, and the reconciliation foundation (no live ' +
      'gateway; no raw card data).',
    // Shipped in Phase 6 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout (see above): the only enable endpoint is
    // @TenantOnly(), so leaving this false would strand new tenants behind
    // 403s. RBAC still gates every route independently. Tenants that existed
    // BEFORE Phase 6 are covered by the 20260716000001_payments_module_backfill
    // migration — defaultEnabled only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'cv',
    name: 'Computer Vision',
    description:
      'Normalized CV product recognition events, evidence bundles, SKU ' +
      'candidates, and the review flow that turns approved events into ' +
      'virtual basket lines (provider-neutral; no edge runtime or training ' +
      'pipeline).',
    // Shipped in Phase 7 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout (see above): the only enable endpoint is
    // @TenantOnly(), so leaving this false would strand new tenants behind
    // 403s. RBAC still gates every route independently. Tenants that existed
    // BEFORE Phase 7 are covered by the 20260719000001_cv_module_backfill
    // migration — defaultEnabled only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'esl',
    name: 'Electronic Shelf Labels',
    description: 'ESL vendor integration (later phase).',
    defaultEnabled: false,
    isActive: false,
  },
  {
    code: 'loyalty',
    name: 'Loyalty',
    description: 'Loyalty and promotions (later phase).',
    defaultEnabled: false,
    isActive: false,
  },
  {
    code: 'reporting',
    name: 'Reporting',
    description: 'Analytics and reporting (later phase).',
    defaultEnabled: false,
    isActive: false,
  },
  {
    code: 'procurement',
    name: 'Procurement',
    description: 'Supplier ordering and receiving (later phase).',
    defaultEnabled: false,
    isActive: false,
  },
];

export const DEFAULT_ENABLED_MODULE_CODES: readonly string[] =
  PLATFORM_MODULE_CATALOG.filter((m) => m.defaultEnabled).map((m) => m.code);
