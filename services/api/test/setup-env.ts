// Runs before any test module is imported (jest setupFiles).
// Obviously-fake local value so env validation passes without any database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://byond:byond@localhost:5432/byond_test';
process.env.NODE_ENV = 'test';
// Generated-looking fixed test secret (48 hex chars) — placeholder-marker
// words like "secret"/"test-only" are rejected by env validation in every
// environment, so the fixture must not contain them.
process.env.JWT_SECRET =
  process.env.JWT_SECRET ??
  'f3b1c9a4e2d84760b5a19c8d3e7f0a2b4c6d8e0f1a3b5c7d';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '15m';
// Generous defaults so ordinary suites never trip the login throttle; the
// dedicated throttle e2e overrides these with small limits.
process.env.LOGIN_THROTTLE_LIMIT = process.env.LOGIN_THROTTLE_LIMIT ?? '1000';
process.env.LOGIN_THROTTLE_IP_LIMIT =
  process.env.LOGIN_THROTTLE_IP_LIMIT ?? '5000';
// The developer .env enables the pickup-detection polling worker; e2e suites
// stub PrismaService without the videoAsset delegate, so a background scan
// firing mid-suite would crash as an unhandled rejection in whichever test
// happens to be running. Force it off for every test process.
process.env.PICKUP_DETECTION_ENABLED = 'false';
