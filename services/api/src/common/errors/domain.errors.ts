export class TenantIdRequiredError extends Error {
  constructor(repositoryName: string) {
    super(
      `${repositoryName}: tenantId is required for tenant-scoped data access. ` +
        'Platform-scoped access must use an explicitly platform-scoped repository.',
    );
    this.name = 'TenantIdRequiredError';
  }
}

export class TenantIsolationViolationError extends Error {
  constructor(detail: string) {
    super(`Tenant isolation violation: ${detail}`);
    this.name = 'TenantIsolationViolationError';
  }
}

export class DefaultModulesMissingError extends Error {
  constructor(missingCodes: readonly string[]) {
    super(
      `Cannot create tenant: required default platform modules are missing or inactive: ` +
        `${missingCodes.join(', ')}. Has the platform-module seed run?`,
    );
    this.name = 'DefaultModulesMissingError';
  }
}
