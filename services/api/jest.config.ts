import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  clearMocks: true,
  // Each e2e suite builds a whole Nest AppModule plus a Prisma client, so
  // Jest's default of one worker per core starves them on a many-core
  // machine: the `beforeAll` bootstrap trips its 5s hook timeout, and
  // under `pnpm -r run test` (which runs several packages at once) the
  // box runs out of heap altogether. Capping the worker count and
  // recycling a worker once it balloons keeps the suite deterministic
  // without lengthening it on a small CI runner.
  maxWorkers: '50%',
  workerIdleMemoryLimit: '1GB',
};

export default config;
