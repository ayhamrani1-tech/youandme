/**
 * Section 5 — Gyms and personal training.
 *
 * Covers the three things that make this section different from the others:
 *   • location-based discovery, with distance and rating, so a client in Irbid
 *     can see the nearest gyms and how far the Amman ones are
 *   • a choice between a monthly subscription and a per-gym point store, with
 *     points expiring after 6 months and rolling over on renewal
 *   • an onboarding explainer served before signup so the point system is
 *     understood before any money changes hands
 */
import { Router } from '../lib/router.js';
import { getDb, bool } from '../db/index.js';
import { requireAuth, requireRole, requireOwnership, optionalAuth } from '../middleware/auth.js';
import { parse, pagination, z, money, latitude, longitude, isoDate } from '../lib/validate.js';
import * as S from '../lib/serialize.js';
import { badRequest, notFound } from '../lib/errors.js';
import { distanceKm, nowIso, dateOnly, addDays } from '../lib/time.js';
import {
  purchasePoints,
  walletSummary,
  getGymSettings,
  spendPoints,
  sweepExpiredLots,
  balanceOf,
  adjustPoints,
} from '../services/points.js';
import { randomReference } from '../lib/security.js';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';

const router = new Router();

// ---------------------------------------------------------------------------
// Onboarding explainer — shown before a client commits to points or a plan
// ---------------------------------------------------------------------------
router.get('/how-it-works', async () => ({
  expiryMonths: config.rules.pointsExpiryMonths,
  currency: config.rules.currency,
  options: [
    {
      key: 'monthly',
      titleAr: 'اشتراك شهري',
      titleEn: 'Monthly subscription',
      bodyAr:
        'تدفع مبلغًا ثابتًا شهريًا وتدخل النادي بدون حد لعدد الزيارات خلال مدة الاشتراك. مناسب لمن يتدرب ثلاث مرات أسبوعيًا أو أكثر.',
      bodyEn:
        'Pay a fixed monthly amount and enter as often as you like for the length of the subscription. Best if you train three times a week or more.',
    },
    {
      key: 'points',
      titleAr: 'نقاط الدخول',
      titleEn: 'Entry points',
      bodyAr:
        'تشتري رصيد نقاط من متجر النادي، ويُخصم من رصيدك عدد النقاط الذي يحدده النادي عند كل زيارة. مناسب للتدريب غير المنتظم.',
      bodyEn:
        'Buy a point balance from the gym’s store; each visit deducts the number of points that gym sets. Best for training on an irregular schedule.',
    },
  ],
  pointRules: [
    {
      key: 'expiry',
      ar: `النقاط المشتراة تنتهي صلاحيتها بعد ${config.rules.pointsExpiryMonths} أشهر من تاريخ الشراء.`,
      en: `Purchased points expire ${config.rules.pointsExpiryMonths} months after the purchase date.`,
    },
    {
      key: 'rollover',
      ar: 'إذا شحنت رصيدًا جديدًا قبل انتهاء المدة، يُضاف رصيدك القديم إلى الجديد وتبدأ مدة جديدة للرصيد كامله.',
      en: 'If you top up before that period ends, your existing balance is added to the new one and the whole combined balance gets a fresh expiry date.',
    },
    {
      key: 'scope',
      ar: 'النقاط خاصة بكل نادٍ على حدة، ولا تُستخدم في نادٍ آخر.',
      en: 'Points belong to one gym and cannot be spent at another.',
    },
    {
      key: 'refund',
      ar: 'إذا أُلغيت زيارة مدفوعة بالنقاط، تُعاد النقاط إلى رصيدك.',
      en: 'If a visit paid with points is cancelled, the points return to your balance.',
    },
  ],
}));

// ---------------------------------------------------------------------------
// Discovery: nearby gyms
// ---------------------------------------------------------------------------

/**
 * GET /api/gyms/nearby?lat=&lng=&radiusKm=&limit=
 *
 * Falls back to the signed-in client's saved coordinates when lat/lng are
 * omitted. Results carry distance and rating and are ordered nearest-first.
 */
router.get('/nearby', optionalAuth, async (req) => {
  const query = parse(
    z.object({
      lat: latitude.optional(),
      lng: longitude.optional(),
      radiusKm: z.coerce.number().min(0.5).max(500).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      minRating: z.coerce.number().min(0).max(5).optional(),
    }),
    req.query,
  );
  const lat = query.lat ?? req.user?.lat;
  const lng = query.lng ?? req.user?.lng;
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    throw badRequest(
      'location_required',
      'Send lat and lng, or save a location on your profile, to find nearby gyms.',
    );
  }
  const db = getDb();
  const rows = await db.all(
    `SELECT b.*, u.full_name AS owner_name
       FROM businesses b JOIN users u ON u.id = b.owner_id
      WHERE b.section = 'gym' AND b.is_active = ? AND b.lat IS NOT NULL AND b.lng IS NOT NULL`,
    [true],
  );
  let items = rows
    .map((row) => S.business(row, { ownerName: row.owner_name, distanceKm: distanceKm(lat, lng, row.lat, row.lng) }))
    .filter((b) => b.distanceKm !== null);
  if (query.radiusKm) items = items.filter((b) => b.distanceKm <= query.radiusKm);
  if (query.minRating) items = items.filter((b) => b.rating.avg >= query.minRating);
  items.sort((a, b) => a.distanceKm - b.distanceKm);

  // Attach each gym's entry cost so the list is directly actionable.
  const limited = items.slice(0, query.limit);
  for (const gym of limited) {
    const settings = await getGymSettings(db, gym.id);
    gym.gymSettings = S.gymSettings(settings);
  }
  return { origin: { lat: Number(lat), lng: Number(lng) }, items: limited, total: items.length };
});

// ---------------------------------------------------------------------------
// Point store + wallet
// ---------------------------------------------------------------------------

router.get('/:businessId/store', optionalAuth, async (req) => {
  const db = getDb();
  const id = Number(req.params.businessId);
  const gym = await db.get("SELECT * FROM businesses WHERE id = ? AND section = 'gym'", [id]);
  if (!gym) throw notFound('gym_not_found');
  const [packages, plans, settings] = await Promise.all([
    db.all('SELECT * FROM point_packages WHERE business_id = ? AND is_active = ? ORDER BY points', [id, true]),
    db.all(
      `SELECT p.*, s.name AS trainer_name FROM gym_plans p
         LEFT JOIN staff s ON s.id = p.trainer_id
        WHERE p.business_id = ? AND p.is_active = ? ORDER BY p.kind, p.price`,
      [id, true],
    ),
    getGymSettings(db, id),
  ]);
  const response = {
    gym: S.business(gym),
    settings: S.gymSettings(settings),
    pointPackages: packages.map(S.pointPackage),
    plans: plans.map(S.gymPlan),
  };
  if (req.user) response.wallet = await walletSummary(req.user.id, id);
  return response;
});

/** The client's wallet at one gym: balance, expiry date and full ledger. */
router.get('/:businessId/wallet', requireAuth, async (req) => {
  const db = getDb();
  const id = Number(req.params.businessId);
  const gym = await db.get("SELECT id FROM businesses WHERE id = ? AND section = 'gym'", [id]);
  if (!gym) throw notFound('gym_not_found');
  const wallet = await walletSummary(req.user.id, id);
  return {
    ...wallet,
    lots: wallet.lots.map(S.pointLot),
    history: wallet.history.map(S.pointTransaction),
    subscription: wallet.subscription ? S.subscription(wallet.subscription) : null,
  };
});

/** Buy a point package — this is where expiry and rollover are applied. */
router.post('/:businessId/points/purchase', requireAuth, requireRole('client'), async (req) => {
  const input = parse(
    z.object({
      packageId: z.coerce.number().int().positive(),
      paymentMethod: z.enum(['cash', 'card']).default('card'),
    }),
    req.body,
  );
  const businessId = Number(req.params.businessId);
  const result = await purchasePoints({
    userId: req.user.id,
    businessId,
    packageId: input.packageId,
    method: input.paymentMethod,
  });
  return {
    lot: S.pointLot(result.lot),
    purchasedPoints: result.purchased,
    rolledOverPoints: result.rolledIn,
    balance: result.balance,
    expiresAt: result.expiresAt,
    message:
      result.rolledIn > 0
        ? `${result.rolledIn} existing point(s) rolled over; the combined balance now expires ${String(result.expiresAt).slice(0, 10)}.`
        : `Balance expires ${String(result.expiresAt).slice(0, 10)}.`,
  };
});

/** Record a gym entry, paid from the point balance. */
router.post('/:businessId/entry', requireAuth, requireRole('client'), async (req) => {
  const db = getDb();
  const businessId = Number(req.params.businessId);
  const gym = await db.get("SELECT * FROM businesses WHERE id = ? AND section = 'gym'", [businessId]);
  if (!gym) throw notFound('gym_not_found');

  return db.transaction(async (tx) => {
    // An active subscription covers the visit with no point deduction.
    const subscription = await tx.get(
      `SELECT * FROM subscriptions
        WHERE user_id = ? AND business_id = ? AND status = 'active' AND ends_on >= ?
        ORDER BY ends_on DESC LIMIT 1`,
      [req.user.id, businessId, dateOnly()],
    );
    const settings = await getGymSettings(tx, businessId);
    const now = nowIso();

    if (subscription) {
      const booking = await tx.insert('bookings', {
        reference: randomReference('GY'),
        business_id: businessId,
        client_id: req.user.id,
        section: 'gym',
        starts_at: now,
        ends_at: now,
        status: 'completed',
        total_amount: 0,
        payment_method: 'subscription',
        points_spent: 0,
        completed_at: now,
        notes: 'Entry covered by subscription',
      });
      return {
        method: 'subscription',
        booking: S.booking(booking),
        subscriptionEndsOn: subscription.ends_on,
        pointsSpent: 0,
        balance: await balanceOf(tx, req.user.id, businessId),
      };
    }

    const cost = Number(settings.points_per_entry);
    const booking = await tx.insert('bookings', {
      reference: randomReference('GY'),
      business_id: businessId,
      client_id: req.user.id,
      section: 'gym',
      starts_at: now,
      ends_at: now,
      status: 'completed',
      total_amount: 0,
      payment_method: 'points',
      points_spent: cost,
      completed_at: now,
      notes: 'Entry paid with points',
    });
    const balance = await spendPoints(tx, {
      userId: req.user.id,
      businessId,
      points: cost,
      kind: 'entry',
      bookingId: booking.id,
      note: 'Gym entry',
    });
    return {
      method: 'points',
      booking: S.booking(booking),
      pointsSpent: cost,
      balance,
      entriesAvailable: Math.floor(balance / Math.max(1, cost)),
    };
  });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
router.post('/:businessId/subscribe', requireAuth, requireRole('client'), async (req) => {
  const input = parse(
    z.object({
      planId: z.coerce.number().int().positive(),
      startsOn: isoDate.optional(),
      paymentMethod: z.enum(['cash', 'card']).default('card'),
    }),
    req.body,
  );
  const db = getDb();
  const businessId = Number(req.params.businessId);
  return db.transaction(async (tx) => {
    const plan = await tx.get('SELECT * FROM gym_plans WHERE id = ? AND business_id = ?', [
      input.planId,
      businessId,
    ]);
    if (!plan) throw notFound('plan_not_found');
    if (!bool(plan.is_active)) throw badRequest('plan_inactive', 'That plan is no longer offered.');
    const settings = await getGymSettings(tx, businessId);
    if (plan.kind === 'monthly' && !bool(settings.allows_monthly)) {
      throw badRequest('monthly_disabled', 'This gym does not offer monthly subscriptions.');
    }

    const existing = await tx.get(
      `SELECT * FROM subscriptions
        WHERE user_id = ? AND business_id = ? AND status = 'active' AND ends_on >= ?`,
      [req.user.id, businessId, dateOnly()],
    );
    // Renewing early extends from the current end date rather than losing time.
    const startsOn = input.startsOn
      ? input.startsOn
      : existing
        ? dateOnly(addDays(`${existing.ends_on}T00:00:00.000Z`, 1))
        : dateOnly();
    const endsOn = dateOnly(addDays(`${startsOn}T00:00:00.000Z`, Number(plan.duration_days) - 1));

    const subscription = await tx.insert('subscriptions', {
      user_id: req.user.id,
      business_id: businessId,
      plan_id: plan.id,
      starts_on: startsOn,
      ends_on: endsOn,
      amount_paid: Number(plan.price),
      sessions_left: plan.sessions_included === null ? null : Number(plan.sessions_included),
      status: 'active',
    });
    await tx.insert('transactions', {
      user_id: req.user.id,
      business_id: businessId,
      subscription_id: subscription.id,
      kind: 'subscription_payment',
      amount: Number(plan.price),
      currency: config.rules.currency,
      method: input.paymentMethod,
      status: input.paymentMethod === 'cash' ? 'pending' : 'paid',
      note: plan.name_ar,
    });
    return { subscription: S.subscription(subscription), plan: S.gymPlan(plan), extendedFrom: existing?.ends_on ?? null };
  });
});

// ---------------------------------------------------------------------------
// Owner management: plans, packages, settings
// ---------------------------------------------------------------------------
const ownerGym = (handler) => [requireAuth, requireOwnership('businessId', { section: 'gym' }), handler];

router.put(
  '/:businessId/settings',
  ...ownerGym(async (req) => {
    const input = parse(
      z.object({
        pointsPerEntry: z.coerce.number().int().min(1).max(100).optional(),
        expiryMonths: z.coerce.number().int().min(1).max(60).optional(),
        allowsPoints: z.boolean().optional(),
        allowsMonthly: z.boolean().optional(),
        introAr: z.string().trim().max(1500).optional(),
        introEn: z.string().trim().max(1500).optional(),
      }),
      req.body,
    );
    const db = getDb();
    await getGymSettings(db, req.business.id);
    const columns = {};
    if (input.pointsPerEntry !== undefined) columns.points_per_entry = input.pointsPerEntry;
    if (input.expiryMonths !== undefined) columns.expiry_months = input.expiryMonths;
    if (input.allowsPoints !== undefined) columns.allows_points = input.allowsPoints;
    if (input.allowsMonthly !== undefined) columns.allows_monthly = input.allowsMonthly;
    if (input.introAr !== undefined) columns.intro_ar = input.introAr;
    if (input.introEn !== undefined) columns.intro_en = input.introEn;
    if (Object.keys(columns).length) {
      const assignments = Object.keys(columns).map((k) => `${k} = ?`).join(', ');
      await db.run(`UPDATE gym_settings SET ${assignments} WHERE business_id = ?`, [
        ...Object.values(columns),
        req.business.id,
      ]);
    }
    const settings = await getGymSettings(db, req.business.id);
    return S.gymSettings(settings);
  }),
);

const planSchema = z.object({
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().max(120).optional(),
  kind: z.enum(['monthly', 'private_training']).default('monthly'),
  price: money,
  durationDays: z.coerce.number().int().min(1).max(1095).default(30),
  sessionsIncluded: z.coerce.number().int().min(1).max(500).optional(),
  trainerId: z.coerce.number().int().positive().optional(),
  description: z.string().trim().max(800).optional(),
  isActive: z.boolean().default(true),
});

router.post(
  '/:businessId/plans',
  ...ownerGym(async (req) => {
    const input = parse(planSchema, req.body);
    const db = getDb();
    if (input.trainerId) {
      const trainer = await db.get('SELECT id FROM staff WHERE id = ? AND business_id = ?', [
        input.trainerId,
        req.business.id,
      ]);
      if (!trainer) throw badRequest('trainer_not_found', 'That trainer does not work at this gym.');
    }
    const row = await db.insert('gym_plans', {
      business_id: req.business.id,
      name_ar: input.nameAr,
      name_en: input.nameEn ?? null,
      kind: input.kind,
      price: input.price,
      duration_days: input.durationDays,
      sessions_included: input.sessionsIncluded ?? null,
      trainer_id: input.trainerId ?? null,
      description: input.description ?? null,
      is_active: input.isActive,
    });
    return S.gymPlan(row);
  }),
);

router.put(
  '/:businessId/plans/:planId',
  ...ownerGym(async (req) => {
    const input = parse(planSchema.partial(), req.body);
    const db = getDb();
    const existing = await db.get('SELECT * FROM gym_plans WHERE id = ? AND business_id = ?', [
      Number(req.params.planId),
      req.business.id,
    ]);
    if (!existing) throw notFound('plan_not_found');
    const row = await db.update('gym_plans', existing.id, {
      name_ar: input.nameAr,
      name_en: input.nameEn,
      kind: input.kind,
      price: input.price,
      duration_days: input.durationDays,
      sessions_included: input.sessionsIncluded,
      trainer_id: input.trainerId,
      description: input.description,
      is_active: input.isActive,
    });
    return S.gymPlan(row);
  }),
);

router.delete(
  '/:businessId/plans/:planId',
  ...ownerGym(async (req) => {
    const db = getDb();
    await db.run('DELETE FROM gym_plans WHERE id = ? AND business_id = ?', [
      Number(req.params.planId),
      req.business.id,
    ]);
    return { ok: true };
  }),
);

const packageSchema = z.object({
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().max(120).optional(),
  points: z.coerce.number().int().min(1).max(10000),
  bonusPoints: z.coerce.number().int().min(0).max(10000).default(0),
  price: money,
  isActive: z.boolean().default(true),
});

router.post(
  '/:businessId/packages',
  ...ownerGym(async (req) => {
    const input = parse(packageSchema, req.body);
    const db = getDb();
    const row = await db.insert('point_packages', {
      business_id: req.business.id,
      name_ar: input.nameAr,
      name_en: input.nameEn ?? null,
      points: input.points,
      bonus_points: input.bonusPoints,
      price: input.price,
      is_active: input.isActive,
    });
    return S.pointPackage(row);
  }),
);

router.put(
  '/:businessId/packages/:packageId',
  ...ownerGym(async (req) => {
    const input = parse(packageSchema.partial(), req.body);
    const db = getDb();
    const existing = await db.get('SELECT * FROM point_packages WHERE id = ? AND business_id = ?', [
      Number(req.params.packageId),
      req.business.id,
    ]);
    if (!existing) throw notFound('package_not_found');
    const row = await db.update('point_packages', existing.id, {
      name_ar: input.nameAr,
      name_en: input.nameEn,
      points: input.points,
      bonus_points: input.bonusPoints,
      price: input.price,
      is_active: input.isActive,
    });
    return S.pointPackage(row);
  }),
);

router.delete(
  '/:businessId/packages/:packageId',
  ...ownerGym(async (req) => {
    const db = getDb();
    await db.run('DELETE FROM point_packages WHERE id = ? AND business_id = ?', [
      Number(req.params.packageId),
      req.business.id,
    ]);
    return { ok: true };
  }),
);

/** Members of one gym: point balances and live subscriptions. */
router.get(
  '/:businessId/members',
  ...ownerGym(async (req) => {
    const { page, limit, offset } = pagination(req.query);
    const db = getDb();
    await sweepExpiredLots(db, { businessId: req.business.id });
    const total = await db.value(
      `SELECT COUNT(DISTINCT user_id) AS c FROM (
         SELECT user_id FROM point_lots WHERE business_id = ?
         UNION SELECT user_id FROM subscriptions WHERE business_id = ?
       ) AS members`,
      [req.business.id, req.business.id],
    );
    const rows = await db.all(
      `SELECT u.id, u.full_name, u.email, u.phone, u.gender,
              COALESCE((SELECT SUM(points_remaining) FROM point_lots
                         WHERE user_id = u.id AND business_id = ? AND status = 'active' AND expires_at > ?), 0) AS balance,
              (SELECT MIN(expires_at) FROM point_lots
                WHERE user_id = u.id AND business_id = ? AND status = 'active' AND points_remaining > 0) AS points_expire_at,
              (SELECT MAX(ends_on) FROM subscriptions
                WHERE user_id = u.id AND business_id = ? AND status = 'active') AS subscription_ends_on
         FROM users u
        WHERE u.id IN (
          SELECT user_id FROM point_lots WHERE business_id = ?
          UNION SELECT user_id FROM subscriptions WHERE business_id = ?
        )
        ORDER BY balance DESC, u.id
        LIMIT ? OFFSET ?`,
      [
        req.business.id,
        nowIso(),
        req.business.id,
        req.business.id,
        req.business.id,
        req.business.id,
        limit,
        offset,
      ],
    );
    return S.page(
      rows.map((row) => ({
        id: Number(row.id),
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        gender: row.gender,
        pointsBalance: Number(row.balance),
        pointsExpireAt: row.points_expire_at ?? null,
        subscriptionEndsOn: row.subscription_ends_on ?? null,
      })),
      { page, limit, total },
    );
  }),
);

/** Owner grants or removes points (correcting a cash sale, say). */
router.post(
  '/:businessId/members/:userId/points',
  ...ownerGym(async (req) => {
    const input = parse(
      z.object({
        points: z.coerce.number().int().min(-10000).max(10000),
        note: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    if (input.points === 0) throw badRequest('invalid_points', 'Adjustment cannot be zero.');
    const result = await adjustPoints({
      userId: Number(req.params.userId),
      businessId: req.business.id,
      points: input.points,
      note: input.note || `Adjusted by owner`,
    });
    await recordAudit(req, {
      action: 'adjust_points',
      entity: 'user',
      entityId: req.params.userId,
      meta: { points: input.points, businessId: req.business.id },
    });
    return result;
  }),
);

export default router;
