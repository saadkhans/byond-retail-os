export class TenantIdRequiredError extends Error {
  constructor(repositoryName: string) {
    super(
      `${repositoryName}: tenantId is required for tenant-scoped data access. ` +
        'Platform-scoped access must use an explicitly platform-scoped repository.',
    );
    this.name = 'TenantIdRequiredError';
  }
}
