/**
 * Platform module catalog — the single source of truth the seed reads from.
 * An entry with `isActive: false` is a NAME ONLY: the module has no logic yet
 * and can never be enabled for a tenant. Flip it to true in the phase that
 * actually ships the module, and add a backfill migration for the tenants
 * that already exist.
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
    description:
      'Versioned, auditable, reversible price books: effective-dated ' +
      'versions, immutable entries, activation and rollback, and the ' +
      'resolved prices checkout snapshots onto basket lines.',
    // Shipped in Phase 25 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout (see above): the only enable endpoint is
    // @TenantOnly(), so leaving this false would strand new tenants behind
    // 403s. RBAC still gates every route independently. Tenants that existed
    // BEFORE Phase 25 are covered by the 20260916090001_pricing_module_backfill
    // migration — defaultEnabled only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
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
    code: 'inference',
    name: 'CV Inference',
    description:
      'Provider-neutral CV inference jobs, the database-backed queue ' +
      'foundation, the simulated adapter, and the conversion of successful ' +
      'results into Phase 7 vision events (no runtime ML or video ' +
      'dependency; no real model execution).',
    // Shipped in Phase 9 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout/payments/cv (see above): the only enable
    // endpoint is @TenantOnly(), so leaving this false would strand new
    // tenants behind 403s. RBAC still gates every route independently.
    // Tenants that existed BEFORE Phase 9 are covered by the
    // 20260726000001_inference_module_backfill migration — defaultEnabled
    // only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'video-ingest',
    name: 'Video Ingestion',
    description:
      'Controlled test video upload, safe local/dev media storage, ' +
      'frame/crop extraction contracts, and the connection from crop ' +
      'artifacts to Phase 9 inference jobs (no production camera runtime; ' +
      'no real model execution; no raw media in the database).',
    // Shipped in Phase 10 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout/payments/cv/inference (see above): the only
    // enable endpoint is @TenantOnly(), so leaving this false would strand
    // new tenants behind 403s. RBAC still gates every route independently.
    // Tenants that existed BEFORE Phase 10 are covered by the
    // 20260727000001_video_ingest_module_backfill migration — defaultEnabled
    // only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'store-flow',
    name: 'Store Flow',
    description:
      'Shopper entry and identity, the governed bridge from observed ' +
      'pickups to basket lines, one review queue over both streams, and ' +
      'exit settlement into an order and a payment.',
    // Shipped in Phase 26 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout/pricing (see above): the only enable
    // endpoint is @TenantOnly(), so leaving this false would strand new
    // tenants behind 403s. RBAC still gates every route independently, and
    // enabling the module changes NOTHING on its own — the autonomy policy
    // defaults to SHADOW, so a store keeps observing until an operator opts
    // in. Tenants that existed BEFORE Phase 26 are covered by the
    // 20260916100001_store_flow_module_backfill migration.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'returns',
    name: 'Returns & Reconciliation',
    description:
      'Refunds against captured payments, stock reversal on returned and ' +
      'cancelled orders, cycle counts and stocktakes that reconcile the ' +
      'stock projection against the ledger, and the shrink path for ' +
      'CV-detected loss.',
    // Shipped in Phase 27 and DEFAULT-ENABLED for the same reason as
    // inventory/checkout/payments/pricing/store-flow (see above): the only
    // enable endpoint is @TenantOnly(), so leaving this false would strand
    // new tenants behind 403s. RBAC still gates every route independently,
    // and enabling the module changes NOTHING on its own — there are no
    // background jobs here; every return, count and write-off is an operator
    // action. Tenants that existed BEFORE Phase 27 are covered by the
    // 20260916110001_returns_module_backfill migration.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'esl',
    name: 'Electronic Shelf Labels',
    description:
      'Vendor-neutral electronic shelf labels: gateways and labels behind ' +
      'an adapter port, price-activation propagation, and a leased retry ' +
      'queue.',
    // Shipped in Phase 28 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout/pricing (see above): the only enable
    // endpoint is @TenantOnly(), so leaving this false would strand new
    // tenants behind 403s. RBAC still gates every route independently.
    // Tenants that existed BEFORE Phase 28 are covered by the
    // 20260916111001_esl_module_backfill migration — defaultEnabled only
    // applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'loyalty',
    name: 'Loyalty & Promotions',
    description:
      'Loyalty accounts with an append-only points ledger, and versioned, ' +
      'reversible promotions that compose on top of the price version in ' +
      'force without ever rewriting price history.',
    // Shipped in Phase 29 and DEFAULT-ENABLED for the same reason as
    // inventory/devices/checkout/pricing/esl (see above): the only enable
    // endpoint is @TenantOnly(), so leaving this false would strand new
    // tenants behind 403s. RBAC still gates every route independently.
    // Tenants that existed BEFORE Phase 29 are covered by the
    // 20260916130001_loyalty_module_backfill migration — defaultEnabled only
    // applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'reporting',
    name: 'Reporting & Analytics',
    description:
      'Read-only sales, inventory, shrink and CV-accuracy reporting derived ' +
      'on read from the append-only ledger, the order lines with their ' +
      'price/promotion provenance, and the evaluation tables.',
    // Shipped in Phase 30 and DEFAULT-ENABLED for the same reason as
    // inventory/checkout/pricing (see above): the only enable endpoint is
    // @TenantOnly(), so leaving this false would strand new tenants behind
    // 403s on a shipped feature. RBAC still gates every route independently
    // — each report demands `report:read` AND the permission that already
    // guards its rows — and enabling this module grants NO new reach: a
    // report over a module the tenant has disabled is refused. Tenants that
    // existed BEFORE Phase 30 are covered by the
    // 20260916150001_reporting_module_backfill migration, which FORCE-upserts
    // isActive = true: databases seeded earlier already carry an inactive
    // `reporting` row, and a DO NOTHING there would strand every one of them.
    defaultEnabled: true,
    isActive: true,
  },
  {
    code: 'procurement',
    name: 'Procurement',
    description:
      'Suppliers, the supplier catalog and its audited cost history, ' +
      'purchase orders, and goods receipts that admit stock through the ' +
      'append-only inventory ledger.',
    // Shipped in Phase 31 and DEFAULT-ENABLED for the same reason as
    // inventory/checkout (see above): the only enable endpoint is
    // @TenantOnly(), so leaving this false would strand new tenants behind
    // 403s on a shipped feature. RBAC still gates every route independently.
    // Tenants that existed BEFORE Phase 31 are covered by the
    // 20260916120001_procurement_module_backfill migration — defaultEnabled
    // only applies at tenant creation time.
    defaultEnabled: true,
    isActive: true,
  },
];

export const DEFAULT_ENABLED_MODULE_CODES: readonly string[] =
  PLATFORM_MODULE_CATALOG.filter((m) => m.defaultEnabled).map((m) => m.code);
