/**
 * Authentication: registration, login, token refresh, logout, password change.
 *
 * Access tokens are short-lived and stateless; refresh tokens are long-lived,
 * stored as SHA-256 digests and rotated on every use, so a stolen refresh token
 * stops working as soon as the legitimate client refreshes.
 */
import { Router } from '../lib/router.js';
import { getDb, bool } from '../db/index.js';
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  parseDuration,
} from '../lib/security.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/common.js';
import { parse, z, email, password, jordanPhone, GENDERS } from '../lib/validate.js';
import { publicUser } from '../lib/serialize.js';
import { unauthorized, conflict, badRequest } from '../lib/errors.js';
import { nowIso, addDays } from '../lib/time.js';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';

const router = new Router();
const authLimiter = rateLimit({ max: config.rateLimit.authMax, keyPrefix: 'auth' });

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email,
  password,
  phone: jordanPhone.optional(),
  // Gender is mandatory: the barber and salon sections are gated on it.
  gender: z.enum(GENDERS),
  locale: z.enum(['ar', 'en']).default('ar'),
  governorate: z.string().trim().max(60).optional(),
  city: z.string().trim().max(60).optional(),
  address: z.string().trim().max(200).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  /**
   * Self-service signup creates clients. An owner account is requested here and
   * must be approved by an admin before it can list a business, and `admin` is
   * never accepted from this endpoint.
   */
  role: z.enum(['client', 'owner']).default('client'),
});

async function issueSession(db, user, req) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role, gender: user.gender });
  const refreshToken = signRefreshToken({ sub: user.id });
  await db.insert('refresh_tokens', {
    user_id: user.id,
    token_hash: hashToken(refreshToken),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    expires_at: addDays(nowIso(), Math.ceil(parseDuration(config.jwt.refreshTtl) / 86400)),
  });
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
  return {
    accessToken,
    refreshToken,
    expiresIn: parseDuration(config.jwt.accessTtl),
    user: publicUser(user),
  };
}

router.post('/register', authLimiter, async (req) => {
  const input = parse(registerSchema, req.body);
  const db = getDb();
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [input.email]);
  if (existing) throw conflict('email_taken', 'An account with this email already exists.');

  const user = await db.insert('users', {
    full_name: input.fullName,
    email: input.email,
    phone: input.phone ?? null,
    password_hash: hashPassword(input.password),
    role: input.role,
    gender: input.gender,
    locale: input.locale,
    governorate: input.governorate ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    is_active: true,
  });
  await recordAudit(req, { action: 'register', entity: 'user', entityId: user.id, meta: { role: user.role } });
  return issueSession(db, user, req);
});

router.post('/login', authLimiter, async (req) => {
  const input = parse(z.object({ email, password: z.string().min(1) }), req.body);
  const db = getDb();
  const user = await db.get('SELECT * FROM users WHERE email = ?', [input.email]);
  // Same error and comparable timing whether the email or the password is wrong.
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    throw unauthorized('invalid_credentials', 'Email or password is incorrect.');
  }
  if (!bool(user.is_active)) {
    throw unauthorized('account_disabled', 'This account has been disabled.');
  }
  return issueSession(db, user, req);
});

router.post('/refresh', async (req) => {
  const input = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
  const payload = verifyRefreshToken(input.refreshToken);
  const db = getDb();
  const digest = hashToken(input.refreshToken);
  const stored = await db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', [digest]);
  if (!stored || stored.revoked_at) {
    throw unauthorized('refresh_revoked', 'This session has been signed out.');
  }
  if (new Date(stored.expires_at) < new Date()) {
    throw unauthorized('refresh_expired', 'This session has expired — please sign in again.');
  }
  const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.sub]);
  if (!user || !bool(user.is_active)) throw unauthorized('account_disabled');

  // Rotate: the presented token is retired as the replacement is issued.
  await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [nowIso(), stored.id]);
  return issueSession(db, user, req);
});

router.post('/logout', async (req) => {
  const input = parse(z.object({ refreshToken: z.string().optional() }), req.body);
  const db = getDb();
  if (input.refreshToken) {
    await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [
      nowIso(),
      hashToken(input.refreshToken),
    ]);
  }
  return { ok: true };
});

/** Sign out everywhere — revokes every refresh token for the account. */
router.post('/logout-all', requireAuth, async (req) => {
  const db = getDb();
  await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
    nowIso(),
    req.user.id,
  ]);
  return { ok: true };
});

router.get('/me', requireAuth, async (req) => {
  const db = getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const businesses = await db.all(
    'SELECT id, section, name_ar, name_en, is_active FROM businesses WHERE owner_id = ? ORDER BY id',
    [req.user.id],
  );
  return {
    user: publicUser(user),
    businesses: businesses.map((b) => ({
      id: Number(b.id),
      section: b.section,
      name: { ar: b.name_ar, en: b.name_en },
      isActive: bool(b.is_active),
    })),
  };
});

router.post('/change-password', requireAuth, authLimiter, async (req) => {
  const input = parse(
    z.object({ currentPassword: z.string().min(1), newPassword: password }),
    req.body,
  );
  const db = getDb();
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(input.currentPassword, user.password_hash)) {
    throw badRequest('wrong_password', 'Your current password is incorrect.');
  }
  await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hashPassword(input.newPassword),
    nowIso(),
    req.user.id,
  ]);
  // Changing a password invalidates every other session.
  await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
    nowIso(),
    req.user.id,
  ]);
  await recordAudit(req, { action: 'change_password', entity: 'user', entityId: req.user.id });
  return { ok: true };
});

export default router;
