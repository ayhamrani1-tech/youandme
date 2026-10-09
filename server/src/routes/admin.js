/**
 * Admin console API.
 *
 * Every route here sits behind `requireAdmin`. Admin has unrestricted reach by
 * design: full CRUD over users, businesses, bookings, sessions, reviews and
 * point wallets, platform-wide figures, and the audit trail of who changed what.
 */
import { Router } from '../lib/router.js';
import { getDb } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  parse,
  pagination,
  z,
  email,
  password,
  jordanPhone,
  ROLES,
  GENDERS,
  SECTIONS,
  BOOKING_STATUSES,
} from '../lib/validate.js';
import * as S from '../lib/serialize.js';
import { hashPassword } from '../lib/security.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { nowIso, dateOnly } from '../lib/time.js';
import { sweepExpiredLots, adjustPoints, walletSummary } from '../services/points.js';
import { completeBooking } from '../services/bookings.js';
import { completeSlot, cancelSlot } from '../services/fields.js';
import { refreshAggregates } from '../services/ratings.js';
import { recordAudit } from '../services/audit.js';

const router = new Router();
router.use(requireAuth);
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get('/overview', async () => {
  const db = getDb();
  const today = dateOnly();
  const now = nowIso();

  const [users, businesses, bookings, reviews, revenue] = await Promise.all([
    db.all('SELECT role, COUNT(*) AS c FROM users GROUP BY role'),
    db.all('SELECT section, COUNT(*) AS c FROM businesses GROUP BY section'),
    db.all('SELECT status, COUNT(*) AS c FROM bookings GROUP BY status'),
    db.value('SELECT COUNT(*) AS c FROM reviews'),
    db.value("SELECT COALESCE(SUM(amount), 0) AS t FROM transactions WHERE status = 'paid'"),
  ]);

  const byRole = Object.fromEntries(ROLES.map((r) => [r, 0]));
  for (const row of users) byRole[row.role] = Number(row.c);
  const bySection = Object.fromEntries(SECTIONS.map((s) => [s, 0]));
  for (const row of businesses) bySection[row.section] = Number(row.c);
  const byStatus = {};
  for (const row of bookings) byStatus[row.status] = Number(row.c);

  const [todayBookings, activeSubs, outstandingPoints, expiringSoon, openSessions] = await Promise.all([
    db.value(
      'SELECT COUNT(*) AS c FROM bookings WHERE starts_at >= ? AND starts_at <= ?',
      [`${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`],
    ),
    db.value("SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'active' AND ends_on >= ?", [today]),
    db.value(
      "SELECT COALESCE(SUM(points_remaining), 0) AS t FROM point_lots WHERE status = 'active' AND expires_at > ?",
      [now],
    ),
    db.value(
      `SELECT COALESCE(SUM(points_remaining), 0) AS t FROM point_lots
        WHERE status = 'active' AND expires_at > ? AND expires_at <= ?`,
      [now, new Date(Date.now() + 30 * 86400000).toISOString()],
    ),
    db.value("SELECT COUNT(*) AS c FROM field_slots WHERE status = 'open' AND starts_at > ?", [now]),
  ]);

  const recentBookings = await db.all(
    `SELECT b.*, biz.name_ar AS business_name, u.full_name AS client_name
       FROM bookings b JOIN businesses biz ON biz.id = b.business_id
       JOIN users u ON u.id = b.client_id
      ORDER BY b.created_at DESC LIMIT 10`,
  );

  const topBusinesses = await db.all(
    `SELECT b.*, COUNT(bk.id) AS booking_count FROM businesses b
       LEFT JOIN bookings bk ON bk.business_id = b.id
      GROUP BY b.id ORDER BY booking_count DESC, b.rating_avg DESC LIMIT 8`,
  );

  return {
    users: { ...byRole, total: Object.values(byRole).reduce((a, b) => a + b, 0) },
    businesses: { ...bySection, total: Object.values(bySection).reduce((a, b) => a + b, 0) },
    bookings: { ...byStatus, today: Number(todayBookings ?? 0) },
    reviews: Number(reviews ?? 0),
    revenuePaid: Number(revenue ?? 0),
    gym: {
      activeSubscriptions: Number(activeSubs ?? 0),
      pointsOutstanding: Number(outstandingPoints ?? 0),
      pointsExpiringIn30Days: Number(expiringSoon ?? 0),
    },
    fields: { openSessions: Number(openSessions ?? 0) },
    recentBookings: recentBookings.map((row) => S.booking(row)),
    topBusinesses: topBusinesses.map((row) => S.business(row, { bookingCount: Number(row.booking_count) })),
  };
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
router.get('/users', async (req) => {
  const query = parse(
    z.object({
      role: z.enum(ROLES).optional(),
      gender: z.enum(GENDERS).optional(),
      isActive: z.coerce.boolean().optional(),
      q: z.string().trim().max(120).optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['1 = 1'];
  const params = [];
  if (query.role) {
    conditions.push('role = ?');
    params.push(query.role);
  }
  if (query.gender) {
    conditions.push('gender = ?');
    params.push(query.gender);
  }
  if (query.isActive !== undefined) {
    conditions.push('is_active = ?');
    params.push(query.isActive);
  }
  if (query.q) {
    conditions.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(`SELECT COUNT(*) AS c FROM users ${where}`, params);
  const rows = await db.all(
    `SELECT u.*,
            (SELECT COUNT(*) FROM businesses b WHERE b.owner_id = u.id) AS business_count,
            (SELECT COUNT(*) FROM bookings bk WHERE bk.client_id = u.id) AS booking_count
       FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return S.page(
    rows.map((row) => ({
      ...S.publicUser(row),
      businessCount: Number(row.business_count),
      bookingCount: Number(row.booking_count),
    })),
    { page, limit, total },
  );
});

router.get('/users/:userId', async (req) => {
  const db = getDb();
  const id = Number(req.params.userId);
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) throw notFound('user_not_found');
  const [businesses, bookings, reviews, transactions, lots] = await Promise.all([
    db.all('SELECT * FROM businesses WHERE owner_id = ? ORDER BY id', [id]),
    db.all(
      `SELECT b.*, biz.name_ar AS business_name FROM bookings b
         JOIN businesses biz ON biz.id = b.business_id
        WHERE b.client_id = ? ORDER BY b.starts_at DESC LIMIT 50`,
      [id],
    ),
    db.all('SELECT * FROM reviews WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [id]),
    db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [id]),
    db.all('SELECT * FROM point_lots WHERE user_id = ? ORDER BY purchased_at DESC LIMIT 50', [id]),
  ]);
  return {
    user: S.publicUser(user),
    businesses: businesses.map((b) => S.business(b)),
    bookings: bookings.map((b) => S.booking(b)),
    reviews: reviews.map(S.review),
    transactions: transactions.map(S.transaction),
    pointLots: lots.map(S.pointLot),
  };
});

/** Create any user, including another admin. */
router.post('/users', async (req) => {
  const input = parse(
    z.object({
      fullName: z.string().trim().min(2).max(120),
      email,
      password,
      role: z.enum(ROLES),
      gender: z.enum(GENDERS),
      phone: jordanPhone.optional(),
      locale: z.enum(['ar', 'en']).default('ar'),
      governorate: z.string().trim().max(60).optional(),
      city: z.string().trim().max(60).optional(),
      isActive: z.boolean().default(true),
    }),
    req.body,
  );
  const db = getDb();
  if (await db.get('SELECT id FROM users WHERE email = ?', [input.email])) {
    throw conflict('email_taken', 'An account with this email already exists.');
  }
  const user = await db.insert('users', {
    full_name: input.fullName,
    email: input.email,
    password_hash: hashPassword(input.password),
    role: input.role,
    gender: input.gender,
    phone: input.phone ?? null,
    locale: input.locale,
    governorate: input.governorate ?? null,
    city: input.city ?? null,
    is_active: input.isActive,
  });
  await recordAudit(req, { action: 'create', entity: 'user', entityId: user.id, meta: { role: user.role } });
  return S.publicUser(user);
});

router.put('/users/:userId', async (req) => {
  const input = parse(
    z.object({
      fullName: z.string().trim().min(2).max(120).optional(),
      email: email.optional(),
      role: z.enum(ROLES).optional(),
      gender: z.enum(GENDERS).optional(),
      phone: jordanPhone.optional(),
      locale: z.enum(['ar', 'en']).optional(),
      governorate: z.string().trim().max(60).optional(),
      city: z.string().trim().max(60).optional(),
      isActive: z.boolean().optional(),
      password: password.optional(),
    }),
    req.body,
  );
  const db = getDb();
  const id = Number(req.params.userId);
  const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) throw notFound('user_not_found');
  if (input.email && input.email !== existing.email) {
    if (await db.get('SELECT id FROM users WHERE email = ?', [input.email])) {
      throw conflict('email_taken');
    }
  }
  // Guard against locking everyone out of the admin role.
  if ((input.role && input.role !== 'admin') || input.isActive === false) {
    if (existing.role === 'admin') {
      const others = Number(
        await db.value("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = ? AND id != ?", [
          true,
          id,
        ]),
      );
      if (others === 0) {
        throw badRequest('last_admin', 'This is the only active admin — promote another first.');
      }
    }
  }
  const updated = await db.update('users', id, {
    full_name: input.fullName,
    email: input.email,
    role: input.role,
    gender: input.gender,
    phone: input.phone,
    locale: input.locale,
    governorate: input.governorate,
    city: input.city,
    is_active: input.isActive,
    password_hash: input.password ? hashPassword(input.password) : undefined,
    updated_at: nowIso(),
  });
  if (input.password || input.isActive === false) {
    await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
      nowIso(),
      id,
    ]);
  }
  await recordAudit(req, { action: 'update', entity: 'user', entityId: id, meta: input.password ? { passwordReset: true } : undefined });
  return S.publicUser(updated);
});

router.delete('/users/:userId', async (req) => {
  const db = getDb();
  const id = Number(req.params.userId);
  if (id === req.user.id) throw badRequest('cannot_delete_self', 'You cannot delete your own account.');
  const existing = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) throw notFound('user_not_found');
  const owned = Number(await db.value('SELECT COUNT(*) AS c FROM businesses WHERE owner_id = ?', [id]));
  if (owned > 0) {
    throw conflict(
      'owner_has_businesses',
      `This owner still has ${owned} business(es). Reassign or delete them first.`,
    );
  }
  await db.delete('users', id);
  await recordAudit(req, { action: 'delete', entity: 'user', entityId: id, meta: { email: existing.email } });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------
router.get('/businesses', async (req) => {
  const query = parse(
    z.object({
      section: z.enum(SECTIONS).optional(),
      isActive: z.coerce.boolean().optional(),
      q: z.string().trim().max(120).optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['1 = 1'];
  const params = [];
  if (query.section) {
    conditions.push('b.section = ?');
    params.push(query.section);
  }
  if (query.isActive !== undefined) {
    conditions.push('b.is_active = ?');
    params.push(query.isActive);
  }
  if (query.q) {
    conditions.push('(b.name_ar LIKE ? OR b.name_en LIKE ? OR u.email LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(
    `SELECT COUNT(*) AS c FROM businesses b JOIN users u ON u.id = b.owner_id ${where}`,
    params,
  );
  const rows = await db.all(
    `SELECT b.*, u.full_name AS owner_name, u.email AS owner_email,
            (SELECT COUNT(*) FROM bookings bk WHERE bk.business_id = b.id) AS booking_count,
            (SELECT COALESCE(SUM(amount),0) FROM transactions t WHERE t.business_id = b.id AND t.status = 'paid') AS revenue
       FROM businesses b JOIN users u ON u.id = b.owner_id
       ${where} ORDER BY b.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return S.page(
    rows.map((row) =>
      S.business(row, {
        ownerName: row.owner_name,
        ownerEmail: row.owner_email,
        bookingCount: Number(row.booking_count),
        revenuePaid: Number(row.revenue),
      }),
    ),
    { page, limit, total },
  );
});

/** Reassign a listing to a different owner. */
router.patch('/businesses/:businessId/owner', async (req) => {
  const input = parse(z.object({ ownerId: z.coerce.number().int().positive() }), req.body);
  const db = getDb();
  const business = await db.get('SELECT * FROM businesses WHERE id = ?', [Number(req.params.businessId)]);
  if (!business) throw notFound('business_not_found');
  const owner = await db.get('SELECT * FROM users WHERE id = ?', [input.ownerId]);
  if (!owner) throw notFound('user_not_found');
  if (owner.role === 'client') {
    throw badRequest('not_an_owner', 'Promote that account to owner before assigning a business.');
  }
  const updated = await db.update('businesses', business.id, {
    owner_id: input.ownerId,
    updated_at: nowIso(),
  });
  await recordAudit(req, {
    action: 'reassign_owner',
    entity: 'business',
    entityId: business.id,
    meta: { from: Number(business.owner_id), to: input.ownerId },
  });
  return S.business(updated);
});

router.patch('/businesses/:businessId/status', async (req) => {
  const input = parse(z.object({ isActive: z.boolean() }), req.body);
  const db = getDb();
  const updated = await db.update('businesses', Number(req.params.businessId), {
    is_active: input.isActive,
    updated_at: nowIso(),
  });
  if (!updated) throw notFound('business_not_found');
  await recordAudit(req, {
    action: input.isActive ? 'enable' : 'disable',
    entity: 'business',
    entityId: updated.id,
  });
  return S.business(updated);
});

router.delete('/businesses/:businessId', async (req) => {
  const db = getDb();
  const id = Number(req.params.businessId);
  const existing = await db.get('SELECT * FROM businesses WHERE id = ?', [id]);
  if (!existing) throw notFound('business_not_found');
  await db.delete('businesses', id);
  await recordAudit(req, { action: 'delete', entity: 'business', entityId: id, meta: { name: existing.name_ar } });
  return { ok: true };
});

/** Bulk enable/disable, used by the admin controls panel. */
router.post('/businesses/bulk-status', async (req) => {
  const input = parse(
    z.object({
      isActive: z.boolean(),
      section: z.enum(SECTIONS).optional(),
      ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
    }),
    req.body,
  );
  const db = getDb();
  let result;
  if (input.ids?.length) {
    const placeholders = input.ids.map(() => '?').join(', ');
    result = await db.run(
      `UPDATE businesses SET is_active = ?, updated_at = ? WHERE id IN (${placeholders})`,
      [input.isActive, nowIso(), ...input.ids],
    );
  } else if (input.section) {
    result = await db.run('UPDATE businesses SET is_active = ?, updated_at = ? WHERE section = ?', [
      input.isActive,
      nowIso(),
      input.section,
    ]);
  } else {
    result = await db.run('UPDATE businesses SET is_active = ?, updated_at = ?', [input.isActive, nowIso()]);
  }
  await recordAudit(req, {
    action: 'bulk_status',
    entity: 'business',
    entityId: null,
    meta: { isActive: input.isActive, section: input.section, count: result.rowCount },
  });
  return { updated: result.rowCount };
});

// ---------------------------------------------------------------------------
// Bookings & sessions
// ---------------------------------------------------------------------------
router.get('/bookings', async (req) => {
  const query = parse(
    z.object({
      section: z.enum(SECTIONS).optional(),
      status: z.enum(BOOKING_STATUSES).optional(),
      businessId: z.coerce.number().int().positive().optional(),
      clientId: z.coerce.number().int().positive().optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['1 = 1'];
  const params = [];
  for (const [field, column] of [
    ['section', 'b.section'],
    ['status', 'b.status'],
    ['businessId', 'b.business_id'],
    ['clientId', 'b.client_id'],
  ]) {
    if (query[field] !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(query[field]);
    }
  }
  if (query.from) {
    conditions.push('b.starts_at >= ?');
    params.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to) {
    conditions.push('b.starts_at <= ?');
    params.push(`${query.to}T23:59:59.999Z`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(`SELECT COUNT(*) AS c FROM bookings b ${where}`, params);
  const rows = await db.all(
    `SELECT b.*, biz.name_ar AS business_name, u.full_name AS client_name, u.phone AS client_phone,
            s.name AS staff_name, c.label AS chair_label
       FROM bookings b
       JOIN businesses biz ON biz.id = b.business_id
       JOIN users u ON u.id = b.client_id
       LEFT JOIN staff s ON s.id = b.staff_id
       LEFT JOIN chairs c ON c.id = b.chair_id
       ${where} ORDER BY b.starts_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return S.page(rows.map((row) => S.booking(row)), { page, limit, total });
});

router.patch('/bookings/:bookingId/status', async (req) => {
  const input = parse(z.object({ status: z.enum(BOOKING_STATUSES) }), req.body);
  const db = getDb();
  const id = Number(req.params.bookingId);
  if (input.status === 'completed') {
    const updated = await completeBooking(db, id);
    await recordAudit(req, { action: 'complete', entity: 'booking', entityId: id });
    return S.booking(updated);
  }
  const existing = await db.get('SELECT id FROM bookings WHERE id = ?', [id]);
  if (!existing) throw notFound('booking_not_found');
  const updated = await db.update('bookings', id, {
    status: input.status,
    updated_at: nowIso(),
    cancelled_at: input.status === 'cancelled' ? nowIso() : undefined,
  });
  await recordAudit(req, { action: `set_${input.status}`, entity: 'booking', entityId: id });
  return S.booking(updated);
});

router.delete('/bookings/:bookingId', async (req) => {
  const db = getDb();
  const id = Number(req.params.bookingId);
  if (!(await db.get('SELECT id FROM bookings WHERE id = ?', [id]))) throw notFound('booking_not_found');
  await db.delete('bookings', id);
  await recordAudit(req, { action: 'delete', entity: 'booking', entityId: id });
  return { ok: true };
});

router.get('/field-slots', async (req) => {
  const query = parse(
    z.object({
      status: z.enum(['open', 'confirmed', 'completed', 'cancelled']).optional(),
      businessId: z.coerce.number().int().positive().optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['1 = 1'];
  const params = [];
  if (query.status) {
    conditions.push('s.status = ?');
    params.push(query.status);
  }
  if (query.businessId) {
    conditions.push('f.business_id = ?');
    params.push(query.businessId);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(
    `SELECT COUNT(*) AS c FROM field_slots s JOIN fields f ON f.id = s.field_id ${where}`,
    params,
  );
  const rows = await db.all(
    `SELECT s.*, f.name AS field_name, f.business_id, b.name_ar AS business_name
       FROM field_slots s JOIN fields f ON f.id = s.field_id JOIN businesses b ON b.id = f.business_id
       ${where} ORDER BY s.starts_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return S.page(
    rows.map((row) => S.fieldSlot(row, { businessName: row.business_name })),
    { page, limit, total },
  );
});

router.post('/field-slots/:slotId/complete', async (req) => {
  const slot = await completeSlot(getDb(), Number(req.params.slotId));
  await recordAudit(req, { action: 'complete', entity: 'field_slot', entityId: slot.id });
  return S.fieldSlot(slot);
});

router.post('/field-slots/:slotId/cancel', async (req) => {
  const slot = await cancelSlot(getDb(), Number(req.params.slotId));
  await recordAudit(req, { action: 'cancel', entity: 'field_slot', entityId: slot.id });
  return S.fieldSlot(slot);
});

// ---------------------------------------------------------------------------
// Reviews moderation
// ---------------------------------------------------------------------------
router.get('/reviews', async (req) => {
  const query = parse(
    z.object({
      businessId: z.coerce.number().int().positive().optional(),
      maxRating: z.coerce.number().int().min(1).max(5).optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['1 = 1'];
  const params = [];
  if (query.businessId) {
    conditions.push('r.business_id = ?');
    params.push(query.businessId);
  }
  if (query.maxRating) {
    conditions.push('r.rating <= ?');
    params.push(query.maxRating);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(`SELECT COUNT(*) AS c FROM reviews r ${where}`, params);
  const rows = await db.all(
    `SELECT r.*, u.full_name AS user_name, biz.name_ar AS business_name, s.name AS staff_name
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       JOIN businesses biz ON biz.id = r.business_id
       LEFT JOIN staff s ON s.id = r.staff_id
       ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return S.page(rows.map(S.review), { page, limit, total });
});

router.delete('/reviews/:reviewId', async (req) => {
  const db = getDb();
  const existing = await db.get('SELECT * FROM reviews WHERE id = ?', [Number(req.params.reviewId)]);
  if (!existing) throw notFound('review_not_found');
  await db.delete('reviews', existing.id);
  await refreshAggregates(db, {
    businessId: Number(existing.business_id),
    staffId: existing.staff_id ? Number(existing.staff_id) : null,
    fieldId: existing.field_id ? Number(existing.field_id) : null,
  });
  await recordAudit(req, { action: 'delete', entity: 'review', entityId: existing.id });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Points administration
// ---------------------------------------------------------------------------

/** Force the expiry sweep across the whole platform. */
router.post('/points/sweep', async (req) => {
  const db = getDb();
  const written = await sweepExpiredLots(db);
  await recordAudit(req, { action: 'points_sweep', entity: 'point_lots', entityId: null, meta: { written } });
  return { pointsExpired: written };
});

router.get('/points/wallets', async (req) => {
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  await sweepExpiredLots(db);
  const total = await db.value(
    "SELECT COUNT(*) AS c FROM (SELECT user_id, business_id FROM point_lots WHERE status = 'active' GROUP BY user_id, business_id) AS w",
  );
  const rows = await db.all(
    `SELECT l.user_id, l.business_id, u.full_name, u.email, b.name_ar AS business_name,
            SUM(l.points_remaining) AS balance, MIN(l.expires_at) AS expires_at
       FROM point_lots l
       JOIN users u ON u.id = l.user_id
       JOIN businesses b ON b.id = l.business_id
      WHERE l.status = 'active' AND l.points_remaining > 0
      GROUP BY l.user_id, l.business_id, u.full_name, u.email, b.name_ar
      ORDER BY balance DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return S.page(
    rows.map((row) => ({
      userId: Number(row.user_id),
      userName: row.full_name,
      email: row.email,
      businessId: Number(row.business_id),
      businessName: row.business_name,
      balance: Number(row.balance),
      expiresAt: row.expires_at,
    })),
    { page, limit, total },
  );
});

router.get('/points/wallets/:userId/:businessId', async (req) => {
  const wallet = await walletSummary(Number(req.params.userId), Number(req.params.businessId));
  return {
    ...wallet,
    lots: wallet.lots.map(S.pointLot),
    history: wallet.history.map(S.pointTransaction),
    subscription: wallet.subscription ? S.subscription(wallet.subscription) : null,
  };
});

router.post('/points/adjust', async (req) => {
  const input = parse(
    z.object({
      userId: z.coerce.number().int().positive(),
      businessId: z.coerce.number().int().positive(),
      points: z.coerce.number().int().min(-100000).max(100000),
      note: z.string().trim().max(200).optional(),
    }),
    req.body,
  );
  const result = await adjustPoints({ ...input, note: input.note || 'Admin adjustment' });
  await recordAudit(req, {
    action: 'adjust_points',
    entity: 'user',
    entityId: input.userId,
    meta: { points: input.points, businessId: input.businessId },
  });
  return result;
});

// ---------------------------------------------------------------------------
// Money & audit
// ---------------------------------------------------------------------------
router.get('/transactions', async (req) => {
  const query = parse(
    z.object({
      kind: z.string().optional(),
      status: z.string().optional(),
      businessId: z.coerce.number().int().positive().optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['1 = 1'];
  const params = [];
  for (const [field, column] of [
    ['kind', 't.kind'],
    ['status', 't.status'],
    ['businessId', 't.business_id'],
  ]) {
    if (query[field] !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(query[field]);
    }
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(`SELECT COUNT(*) AS c FROM transactions t ${where}`, params);
  const sum = await db.value(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM transactions t ${where}`,
    params,
  );
  const rows = await db.all(
    `SELECT t.*, u.full_name AS user_name, b.name_ar AS business_name
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN businesses b ON b.id = t.business_id
       ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return {
    ...S.page(
      rows.map((row) => ({ ...S.transaction(row), userName: row.user_name, businessName: row.business_name })),
      { page, limit, total },
    ),
    sumAmount: Number(sum ?? 0),
  };
});

router.get('/audit', async (req) => {
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const total = await db.value('SELECT COUNT(*) AS c FROM audit_log');
  const rows = await db.all(
    `SELECT a.*, u.full_name AS actor_name FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return S.page(rows.map(S.auditEntry), { page, limit, total });
});

export default router;
