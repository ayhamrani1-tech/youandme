/**
 * Test environment variables.
 *
 * This lives in its own module because ES module imports are hoisted and
 * evaluated before the importing module's body runs: assignments made inside
 * `helpers.js` would happen *after* `config.js` had already read the
 * environment. Importing this file first guarantees the ordering.
 */
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = process.env.TEST_DB_DRIVER || 'sqlite';
if (process.env.DB_DRIVER === 'sqlite') process.env.SQLITE_FILE = ':memory:';
process.env.LOG_REQUESTS = 'false';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-value';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value';
process.env.JWT_ISSUER = 'youandme';
// Rate limiting is exercised in its own test; everywhere else it must not
// interfere with fixtures that sign in dozens of times.
process.env.RATE_LIMIT_MAX = '1000000';
process.env.RATE_LIMIT_AUTH_MAX = '1000000';
process.env.SERVE_WEB = 'false';

export const TEST_ENV_READY = true;
