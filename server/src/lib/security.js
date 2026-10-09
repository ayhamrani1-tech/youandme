/**
 * Password hashing and token signing, built on `node:crypto` only.
 *
 * Passwords use scrypt (RFC 7914) with per-password salts. scrypt is memory-hard
 * and ships with Node, so there is no native bcrypt/argon2 dependency to build.
 * Hashes are self-describing (`scrypt$N$r$p$salt$key`) so parameters can be
 * raised later without invalidating existing passwords.
 *
 * JWTs are HS256 (JWS compact serialisation, RFC 7519) signed with HMAC-SHA256
 * and compared in constant time.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { unauthorized } from './errors.js';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };
/** scrypt needs ~128 * N * r bytes; the default 32 MB limit is too low for N=16384. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const key = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  let expected;
  try {
    expected = Buffer.from(keyB64, 'base64url');
  } catch {
    return false;
  }
  let actual;
  try {
    actual = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------
const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

/** '30m', '7d', '45s', '12h' or a raw number of seconds. */
export function parseDuration(value) {
  if (typeof value === 'number') return value;
  const match = /^(\d+)\s*([smhdw])?$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return amount * multipliers[unit];
}

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(payload, { secret, expiresIn, issuer = config.jwt.issuer } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iss: issuer,
    iat: now,
    exp: now + parseDuration(expiresIn),
    jti: crypto.randomUUID(),
  };
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64(body);
  return `${head}.${claims}.${sign(`${head}.${claims}`, secret)}`;
}

export function verifyJwt(token, secret) {
  if (typeof token !== 'string') throw unauthorized('invalid_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('invalid_token');
  const [head, claims, signature] = parts;

  const expected = Buffer.from(sign(`${head}.${claims}`, secret), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw unauthorized('invalid_signature');
  }

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('malformed_token');
  }
  if (header.alg !== 'HS256') throw unauthorized('unsupported_alg');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) throw unauthorized('token_expired');
  if (payload.iss && payload.iss !== config.jwt.issuer) throw unauthorized('invalid_issuer');
  return payload;
}

export const signAccessToken = (payload) =>
  signJwt(payload, { secret: config.jwt.accessSecret, expiresIn: config.jwt.accessTtl });

export const signRefreshToken = (payload) =>
  signJwt({ ...payload, typ: 'refresh' }, {
    secret: config.jwt.refreshSecret,
    expiresIn: config.jwt.refreshTtl,
  });

export const verifyAccessToken = (token) => verifyJwt(token, config.jwt.accessSecret);
export const verifyRefreshToken = (token) => {
  const payload = verifyJwt(token, config.jwt.refreshSecret);
  if (payload.typ !== 'refresh') throw unauthorized('not_a_refresh_token');
  return payload;
};

/** Refresh tokens are persisted as SHA-256 digests, never in the clear. */
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const randomReference = (prefix = 'YM') =>
  `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
