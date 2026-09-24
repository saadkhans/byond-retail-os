// Side-effect module for the throttle e2e suites: must run BEFORE AppModule
// is imported, because ConfigModule.forRoot() captures process.env at import
// time. Import order among ES imports is preserved, so importing this file
// first guarantees the small limits are in place.
process.env.LOGIN_THROTTLE_LIMIT = '3';
process.env.LOGIN_THROTTLE_IP_LIMIT = '6';
// The shopper surface's equivalents. Small enough to reach in a handful of
// requests, and distinct per bucket so a test can tell which one answered.
process.env.SHOPPER_SESSION_THROTTLE_LIMIT = '3';
process.env.SHOPPER_VISIT_THROTTLE_LIMIT = '4';
process.env.SHOPPER_VISIT_IP_THROTTLE_LIMIT = '7';

/**
 * Put back the generous suite-wide defaults from setup-env.ts.
 *
 * Jest reuses a worker process for suite after suite, and these are process
 * globals: a throttle suite that left its own small limits behind would
 * throttle whichever unrelated suite compiled AppModule next. Every suite
 * that imports this file calls it in afterAll.
 */
export function restoreGenerousThrottleLimits(): void {
  process.env.LOGIN_THROTTLE_LIMIT = '1000';
  process.env.LOGIN_THROTTLE_IP_LIMIT = '5000';
  process.env.SHOPPER_SESSION_THROTTLE_LIMIT = '1000';
  process.env.SHOPPER_VISIT_THROTTLE_LIMIT = '5000';
  process.env.SHOPPER_VISIT_IP_THROTTLE_LIMIT = '5000';
}
