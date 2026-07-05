// Runs before any test module is imported (jest setupFiles).
// Obviously-fake local value so env validation passes without any database.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://byond:byond@localhost:5432/byond_test';
process.env.NODE_ENV = 'test';
