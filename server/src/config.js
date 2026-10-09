/**
 * Runtime configuration.
 *
 * Values come from the environment; `.env` at the repo root is loaded manually
 * (no dotenv dependency) so that `node src/index.js` works with no build step.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

/** Parse a .env file without clobbering real environment variables. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(REPO_ROOT, '.env'));
loadEnvFile(path.join(SERVER_ROOT, '.env'));

const env = process.env;
const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

function requireInProd(name, value, fallback) {
  if (value) return value;
  if (isProd) {
    throw new Error(
      `[config] ${name} must be set in production. Refusing to start with a generated value.`,
    );
  }
  return fallback;
}

/** Dev-only deterministic-ish secret so restarts don't invalidate every token. */
function devSecret(label) {
  const seedFile = path.join(SERVER_ROOT, '.dev-secret');
  let seed;
  try {
    seed = fs.readFileSync(seedFile, 'utf8').trim();
  } catch {
    seed = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(seedFile, seed, { mode: 0o600 });
    } catch {
      /* read-only fs: fall back to process-lifetime secret */
    }
  }
  return crypto.createHmac('sha256', seed).update(label).digest('hex');
}

const driver = (env.DB_DRIVER || (env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();

export const config = {
  env: NODE_ENV,
  isProd,
  port: Number(env.PORT || 4000),
  host: env.HOST || '0.0.0.0',

  /** Comma-separated list, or '*' in development. */
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Serve the built web client from the API process (single-port deploys). */
  serveWebDist: env.SERVE_WEB !== 'false',
  webDist: env.WEB_DIST || path.join(REPO_ROOT, 'web', 'dist'),

  db: {
    driver, // 'postgres' | 'sqlite'
    url: env.DATABASE_URL || '',
    sqliteFile: env.SQLITE_FILE || path.join(SERVER_ROOT, 'data', 'youandme.db'),
    poolSize: Number(env.DB_POOL_SIZE || 6),
    logQueries: env.DB_LOG === 'true',
  },

  jwt: {
    accessSecret: requireInProd('JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET, devSecret('access')),
    refreshSecret: requireInProd('JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET, devSecret('refresh')),
    accessTtl: env.JWT_ACCESS_TTL || '30m',
    refreshTtl: env.JWT_REFRESH_TTL || '30d',
    issuer: env.JWT_ISSUER || 'youandme',
  },

  /** Platform-wide business rules (overridable per business where noted). */
  rules: {
    /** Section 2: a sports match confirms once this many players have joined. */
    fieldRequiredPlayers: Number(env.FIELD_REQUIRED_PLAYERS || 14),
    /** Section 2: default bookable session length in minutes. */
    fieldSlotMinutes: Number(env.FIELD_SLOT_MINUTES || 90),
    /** Section 6: purchased gym points expire this many months after purchase. */
    pointsExpiryMonths: Number(env.POINTS_EXPIRY_MONTHS || 6),
    /** Field descriptions are capped at this many words. */
    descriptionWordLimit: Number(env.DESCRIPTION_WORD_LIMIT || 200),
    /** Clients may not cancel a booking within this many hours of the start. */
    cancellationWindowHours: Number(env.CANCELLATION_WINDOW_HOURS || 3),
    currency: env.CURRENCY || 'JOD',
  },

  rateLimit: {
    windowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(env.RATE_LIMIT_MAX || 300),
    authMax: Number(env.RATE_LIMIT_AUTH_MAX || 12),
  },

  seed: {
    adminEmail: env.SEED_ADMIN_EMAIL || 'admin@youandme.jo',
    adminPassword: env.SEED_ADMIN_PASSWORD || 'Admin@12345',
    defaultPassword: env.SEED_DEFAULT_PASSWORD || 'Passw0rd!',
  },
};

export default config;
