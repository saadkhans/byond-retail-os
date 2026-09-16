import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\.(spec|e2e-spec)\.ts$',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  clearMocks: true,
  // `pnpm -r run test` runs workspace packages concurrently, so this suite
  // shares a machine with the API's much larger one. Capping workers keeps it
  // from starving the timing-sensitive live-session specs there; this suite is
  // I/O-light and finishes in seconds either way.
  maxWorkers: 2,
  // The store adapter fsyncs every append and the end-to-end spec boots the
  // whole application, both of which are far slower on a contended machine
  // than jest's 5s default allows. A generous ceiling keeps a real hang
  // detectable without making a loaded CI runner look like a failure.
  testTimeout: 60_000,
};

export default config;
