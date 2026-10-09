/**
 * The signed-in user's own account: profile, saved location, a client dashboard
 * and an owner dashboard.
 *
 * Clients are strictly isolated here — every query is scoped by `req.user.id`,
 * so no client can reach another's bookings, wallet or history.
 */
import { Router } from '../lib/router.js';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parse, z, jordanPhone, latitude, longitude, GENDERS } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';
import * as S from '../lib/serialize.js';
import { nowIso, dateOnly } from '../lib/time.js';
import { sweepExpiredLots } from '../services/points.js';

const router = new Router();

router.put('/profile', requireAuth, async (req) => {
  const input = parse(
    z.object({
      fullName: z.string().trim().min(2).max(120).optional(),
      phone: jordanPhone.optional(),
      locale: z.enum(['ar', 'en']).optional(),
      governorate: z.string().trim().max(60).optional(),
      city: z.string().trim().max(60).optional(),
      address: z.string().trim().max(200).optional(),
      lat: latitude.optional(),
      lng: longitude.optional(),
      // Gender decides access to the barber and salon sections, so it is only
      // changeable while the account has no bookings in either.
      gender: z.enum(GENDERS).optional(),
    }),
    req.body,
  );
  const db = getDb();

  if (input.gender && input.gender !== req.user.gender) {
    const restricted = await db.get(
      `SELECT COUNT(*) AS c FROM bookings
        WHERE client_id = ? AND section IN ('barber', 'salon')`,
      [req.user.id],
    );
    if (Number(restricted?.c ?? 0) > 0) {
      throw badRequest(
        'gender_locked',
        'Gender cannot be changed once you have bookings in a gender-restricted section. Contact support.',
      );
    }
  }

  const updated = await db.update('users', req.user.id, {
    full_name: input.fullName,
    phone: input.phone,
    locale: input.locale,
    governorate: input.governorate,
    city: input.city,
    address: input.address,
    lat: input.lat,
    lng: input.lng,
    gender: input.gender,
    updated_at: nowIso(),
  });
  return S.publicUser(updated);
});

/** Save the device location, used for nearby-gym search. */
router.put('/location', requireAuth, async (req) => {
  const input = parse(z.object({ lat: latitude, lng: longitude }), req.body);
  const db = getDb();
  const updated = await db.update('users', req.user.id, {
    lat: input.lat,
    lng: input.lng,
    updated_at: nowIso(),
  });
  return S.publicUser(updated);
});

/**
 * Client dashboard: upcoming appointments, field sessions joined, gym wallets
 * across every gym, and anything now waiting to be rated.
 */
router.get('/dashboard', requireAuth, requireRole('client'), async (req) => {
  const db = getDb();
  const now = nowIso();
  await sweepExpiredLots(db, { userId: req.user.id });

  const upcoming = await db.all(
    `SELECT b.*, biz.name_ar AS business_name, biz.name_en AS business_name_en,
            s.name AS staff_name, c.label AS chair_label
       FROM bookings b
       JOIN businesses biz ON biz.id = b.business_id
       LEFT JOIN staff s ON s.id = b.staff_id
       LEFT JOIN chairs c ON c.id = b.chair_id
      WHERE b.client_id = ? AND b.starts_at >= ? AND b.status IN ('pending','confirmed')
      ORDER BY b.starts_at ASC LIMIT 10`,
    [req.user.id, now],
  );

  const sessions = await db.all(
    `SELECT s.*, f.name AS field_name, f.business_id, biz.name_ar AS business_name,
            p.players_count, p.amount_due
       FROM field_participants p
       JOIN field_slots s ON s.id = p.slot_id
       JOIN fields f ON f.id = s.field_id
       JOIN businesses biz ON biz.id = f.business_id
      WHERE p.user_id = ? AND p.status = 'joined' AND s.starts_at >= ?
      ORDER BY s.starts_at ASC LIMIT 10`,
    [req.user.id, now],
  );

  const wallets = await db.all(
    `SELECT b.id AS business_id, b.name_ar, b.name_en,
            COALESCE(SUM(l.points_remaining), 0) AS balance,
            MIN(l.expires_at) AS expires_at,
            COALESCE(g.points_per_entry, 1) AS points_per_entry
       FROM point_lots l
       JOIN businesses b ON b.id = l.business_id
       LEFT JOIN gym_settings g ON g.business_id = b.id
      WHERE l.user_id = ? AND l.status = 'active' AND l.points_remaining > 0 AND l.expires_at > ?
      GROUP BY b.id, b.name_ar, b.name_en, g.points_per_entry
      ORDER BY balance DESC`,
    [req.user.id, now],
  );

  const subscriptions = await db.all(
    `SELECT s.*, b.name_ar AS business_name, p.name_ar AS plan_name
       FROM subscriptions s
       JOIN businesses b ON b.id = s.business_id
       LEFT JOIN gym_plans p ON p.id = s.plan_id
      WHERE s.user_id = ? AND s.status = 'active' AND s.ends_on >= ?
      ORDER BY s.ends_on DESC`,
    [req.user.id, dateOnly()],
  );

  // Completed and not yet rated — the only things a client is allowed to rate.
  const awaitingReview = await db.all(
    `SELECT b.*, biz.name_ar AS business_name, s.name AS staff_name
       FROM bookings b
       JOIN businesses biz ON biz.id = b.business_id
       LEFT JOIN staff s ON s.id = b.staff_id
      WHERE b.client_id = ? AND b.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id)
      ORDER BY b.completed_at DESC LIMIT 10`,
    [req.user.id],
  );

  const sessionsAwaitingReview = await db.all(
    `SELECT s.*, f.name AS field_name, f.business_id, f.id AS field_id
       FROM field_participants p
       JOIN field_slots s ON s.id = p.slot_id
       JOIN fields f ON f.id = s.field_id
      WHERE p.user_id = ? AND p.status = 'joined' AND s.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM reviews r WHERE r.slot_id = s.id AND r.user_id = ?
        )
      ORDER BY s.completed_at DESC LIMIT 10`,
    [req.user.id, req.user.id],
  );

  const spend = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE user_id = ? AND status = 'paid'`,
    [req.user.id],
  );

  return {
    upcomingBookings: upcoming.map((row) => S.booking(row)),
    upcomingSessions: sessions.map((row) =>
      S.fieldSlot(row, {
        fieldName: row.field_name,
        businessName: row.business_name,
        myPlayers: Number(row.players_count),
        myAmountDue: Number(row.amount_due),
      }),
    ),
    gymWallets: wallets.map((row) => ({
      businessId: Number(row.business_id),
      businessName: { ar: row.name_ar, en: row.name_en },
      balance: Number(row.balance),
      expiresAt: row.expires_at,
      pointsPerEntry: Number(row.points_per_entry),
      entriesAvailable: Math.floor(Number(row.balance) / Math.max(1, Number(row.points_per_entry))),
    })),
    subscriptions: subscriptions.map(S.subscription),
    awaitingReview: {
      bookings: awaitingReview.map((row) => S.booking(row, { canReview: true })),
      sessions: sessionsAwaitingReview.map((row) => S.fieldSlot(row, { fieldName: row.field_name, canReview: true })),
    },
    totals: { paid: Number(spend?.total ?? 0) },
  };
});

/**
 * Owner dashboard: a figure-level summary per business, plus today's diary.
 */
router.get('/owner/dashboard', requireAuth, requireRole('owner'), async (req) => {
  const db = getDb();
  const today = dateOnly();
  const businesses = await db.all(
    req.user.role === 'admin'
      ? 'SELECT * FROM businesses ORDER BY id'
      : 'SELECT * FROM businesses WHERE owner_id = ? ORDER BY id',
    req.user.role === 'admin' ? [] : [req.user.id],
  );

  const summaries = [];
  for (const business of businesses) {
    const [todayBookings, pending, revenue, reviewCount] = await Promise.all([
      db.value(
        `SELECT COUNT(*) AS c FROM bookings
          WHERE business_id = ? AND starts_at >= ? AND starts_at <= ?
            AND status IN ('pending','confirmed','completed')`,
        [business.id, `${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`],
      ),
      db.value(
        "SELECT COUNT(*) AS c FROM bookings WHERE business_id = ? AND status = 'confirmed' AND starts_at >= ?",
        [business.id, nowIso()],
      ),
      db.value(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE business_id = ? AND status = 'paid'",
        [business.id],
      ),
      db.value('SELECT COUNT(*) AS c FROM reviews WHERE business_id = ?', [business.id]),
    ]);

    const summary = {
      business: S.business(business),
      todayBookings: Number(todayBookings ?? 0),
      upcomingBookings: Number(pending ?? 0),
      revenuePaid: Number(revenue ?? 0),
      reviewCount: Number(reviewCount ?? 0),
    };

    if (business.section === 'sports_field') {
      summary.openSessions = Number(
        await db.value(
          `SELECT COUNT(*) AS c FROM field_slots s JOIN fields f ON f.id = s.field_id
            WHERE f.business_id = ? AND s.status = 'open' AND s.starts_at > ?`,
          [business.id, nowIso()],
        ),
      );
      summary.confirmedSessions = Number(
        await db.value(
          `SELECT COUNT(*) AS c FROM field_slots s JOIN fields f ON f.id = s.field_id
            WHERE f.business_id = ? AND s.status = 'confirmed' AND s.starts_at > ?`,
          [business.id, nowIso()],
        ),
      );
    }
    if (business.section === 'gym') {
      summary.activeSubscriptions = Number(
        await db.value(
          "SELECT COUNT(*) AS c FROM subscriptions WHERE business_id = ? AND status = 'active' AND ends_on >= ?",
          [business.id, today],
        ),
      );
      summary.pointsOutstanding = Number(
        await db.value(
          "SELECT COALESCE(SUM(points_remaining), 0) AS t FROM point_lots WHERE business_id = ? AND status = 'active' AND expires_at > ?",
          [business.id, nowIso()],
        ),
      );
    }
    summaries.push(summary);
  }

  return { businesses: summaries };
});

/** Money in, for an owner's own business. */
router.get('/owner/transactions', requireAuth, requireRole('owner'), async (req) => {
  const input = parse(
    z.object({
      businessId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  const db = getDb();
  const owned = await db.all(
    req.user.role === 'admin'
      ? 'SELECT id FROM businesses'
      : 'SELECT id FROM businesses WHERE owner_id = ?',
    req.user.role === 'admin' ? [] : [req.user.id],
  );
  const ids = owned.map((b) => Number(b.id)).filter((id) => !input.businessId || id === input.businessId);
  if (!ids.length) return { items: [] };
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT t.*, u.full_name AS user_name FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
      WHERE t.business_id IN (${placeholders})
      ORDER BY t.created_at DESC LIMIT ?`,
    [...ids, input.limit],
  );
  return { items: rows.map((row) => ({ ...S.transaction(row), userName: row.user_name })) };
});

export default router;
