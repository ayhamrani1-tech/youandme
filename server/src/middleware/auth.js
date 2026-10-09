/**
 * Authentication and authorisation middleware.
 *
 * Route protection is layered:
 *   requireAuth          — a valid, non-expired access token for an active user
 *   requireRole(...)      — role gate (admin / owner / client)
 *   requireOwnership(...) — the owner of *this* business, or an admin
 *   requireGender(...)    — the men's barber shop and women's salon gates
 *   selfOrAdmin(param)    — a client may only reach their own records
 *
 * Admin is deliberately unconditional: every `requireRole` and
 * `requireOwnership` check treats admin as permitted, which is what "absolute,
 * unrestricted access" in the specification means.
 */
import { getDb, bool } from '../db/index.js';
import { verifyAccessToken } from '../lib/security.js';
import { unauthorized, forbidden, notFound, badRequest } from '../lib/errors.js';

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query?.access_token) return String(req.query.access_token);
  return null;
}

/** Populates `req.user`; rejects anything that is not a live, active account. */
export async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) throw unauthorized('missing_token', 'Authentication is required.');
  const payload = verifyAccessToken(token);
  const db = getDb();
  const row = await db.get(
    'SELECT id, full_name, email, role, gender, locale, is_active, lat, lng FROM users WHERE id = ?',
    [payload.sub],
  );
  if (!row) throw unauthorized('user_not_found', 'This account no longer exists.');
  if (!bool(row.is_active)) throw forbidden('account_disabled', 'This account has been disabled.');
  req.user = {
    id: Number(row.id),
    fullName: row.full_name,
    email: row.email,
    role: row.role,
    gender: row.gender,
    locale: row.locale,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
  };
  req.tokenPayload = payload;
  return next();
}

/** Attaches `req.user` when a token is present, but never rejects. */
export async function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    await requireAuth(req, res, async () => {});
  } catch {
    req.user = null;
  }
  return next();
}

export function requireRole(...roles) {
  const allowed = new Set(roles);
  return async (req, res, next) => {
    if (!req.user) throw unauthorized('missing_token', 'Authentication is required.');
    // Admin bypasses every role gate by design.
    if (req.user.role === 'admin' || allowed.has(req.user.role)) return next();
    throw forbidden('insufficient_role', `This endpoint requires: ${[...allowed].join(', ')}.`);
  };
}

export const requireAdmin = requireRole('admin');

/**
 * Load the business named by a route parameter and confirm the caller may
 * administer it. Sets `req.business`.
 */
export function requireOwnership(param = 'businessId', { section } = {}) {
  return async (req, res, next) => {
    const id = Number(req.params[param]);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('invalid_business_id');
    const db = getDb();
    const row = await db.get('SELECT * FROM businesses WHERE id = ?', [id]);
    if (!row) throw notFound('business_not_found', 'This business does not exist.');
    if (section && row.section !== section) {
      throw badRequest('wrong_section', `This business is not in the ${section} section.`);
    }
    if (req.user.role !== 'admin' && Number(row.owner_id) !== req.user.id) {
      throw forbidden('not_your_business', 'You do not manage this business.');
    }
    req.business = row;
    return next();
  };
}

/**
 * Gender gate for sections restricted by the specification: the men's barber
 * shop is male-only and the women's beauty salon is female-only.
 * Admins and the business's own owner are exempt so they can manage listings.
 */
export function requireGender(gender) {
  return async (req, res, next) => {
    if (!req.user) throw unauthorized('missing_token', 'Authentication is required.');
    if (req.user.role === 'admin') return next();
    if (req.user.gender !== gender) {
      throw forbidden(
        gender === 'male' ? 'male_only_section' : 'female_only_section',
        gender === 'male'
          ? 'The barber shop section is available to male clients only.'
          : 'The beauty salon section is available to female clients only.',
      );
    }
    return next();
  };
}

/**
 * Enforce a business's own `gender_policy` against the caller. Used on booking
 * endpoints where the business is identified in the body rather than the path.
 */
export function assertGenderAllowed(user, businessRow) {
  if (!businessRow) return;
  if (user.role === 'admin') return;
  if (Number(businessRow.owner_id) === user.id) return;
  const policy = businessRow.gender_policy;
  if (policy === 'any') return;
  if (user.gender !== policy) {
    throw forbidden(
      policy === 'male' ? 'male_only_section' : 'female_only_section',
      policy === 'male'
        ? 'This business accepts male clients only.'
        : 'This business accepts female clients only.',
    );
  }
}

/** A client may only act on their own resources; admins may act on any. */
export function selfOrAdmin(param = 'userId') {
  return async (req, res, next) => {
    const target = Number(req.params[param]);
    if (req.user.role === 'admin' || req.user.id === target) return next();
    throw forbidden('not_your_record', 'You may only access your own records.');
  };
}
