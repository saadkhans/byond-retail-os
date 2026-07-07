// Side-effect module for login-throttle.e2e-spec: must run BEFORE AppModule
// is imported, because ConfigModule.forRoot() captures process.env at import
// time. Import order among ES imports is preserved, so importing this file
// first guarantees the small limit is in place.
process.env.LOGIN_THROTTLE_LIMIT = '3';
process.env.LOGIN_THROTTLE_IP_LIMIT = '6';
