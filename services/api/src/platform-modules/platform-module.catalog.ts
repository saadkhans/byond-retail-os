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
    description: 'Inventory ledger and stock projections (later phase).',
    defaultEnabled: false,
    isActive: false,
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
    name: 'Checkout',
    description: 'Checkout routing and payment orchestration (later phase).',
    defaultEnabled: false,
    isActive: false,
  },
  {
    code: 'cv',
    name: 'Computer Vision',
    description: 'CV event proposal pipeline (later phase).',
    defaultEnabled: false,
    isActive: false,
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
