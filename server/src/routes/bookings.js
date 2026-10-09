/**
 * Bookings for the barber, salon, dental and gym-training sections.
 *
 * Clients create and cancel their own; owners see their business's diary and
 * mark appointments completed — which is the step that unlocks rating them.
 */
import { Router } from '../lib/router.js';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole, requireOwnership } from '../middleware/auth.js';
import {
  parse,
  pagination,
  z,
  isoDateTime,
  TREATMENTS,
  NAIL_SCOPES,
  BOOKING_TYPES,
  BOOKING_STATUSES,
  PAYMENT_METHODS,
} from '../lib/validate.js';
import * as S from '../lib/serialize.js';
import { forbidden, notFound } from '../lib/errors.js';
import { nowIso } from '../lib/time.js';
import { createBooking, getBookingDetail, completeBooking, cancelBooking } from '../services/bookings.js';
import { recordAudit } from '../services/audit.js';

const router = new Router();

const createSchema = z.object({
  businessId: z.coerce.number().int().positive(),
  startsAt: isoDateTime,
  durationMin: z.coerce.number().int().min(5).max(480).optional(),
  staffId: z.coerce.number().int().positive().optional(),
  chairId: z.coerce.number().int().positive().optional(),
  items: z
    .array(
      z.object({
        serviceId: z.coerce.number().int().positive(),
        qty: z.coerce.number().int().min(1).max(20).default(1),
      }),
    )
    .default([]),
  // Barber: regular haircut or groom's package.
  bookingType: z.enum(BOOKING_TYPES).optional(),
  // Salon nails: which hands/feet, and the exact polish colours.
  nailScope: z.enum(NAIL_SCOPES).optional(),
  nailColorIds: z
    .array(
      z.object({
        nailColorId: z.coerce.number().int().positive(),
        placement: z.enum(['hands', 'feet']),
      }),
    )
    .max(10)
    .optional(),
  // Dental: the procedure.
  treatmentCode: z.enum(TREATMENTS).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).default('cash'),
  notes: z.string().trim().max(500).optional(),
});

/** Create a booking. */
router.post('/', requireAuth, requireRole('client'), async (req) => {
  const input = parse(createSchema, req.body);
  const result = await createBooking(req.user, input);
  const detail = await getBookingDetail(getDb(), result.booking.id);
  return {
    booking: S.booking(detail.booking),
    items: detail.items.map(S.bookingItem),
    colours: detail.colours,
    pointsSpent: result.pointsSpent,
  };
});

/** The signed-in client's own bookings. */
router.get('/mine', requireAuth, async (req) => {
  const query = parse(
    z.object({
      status: z.enum(BOOKING_STATUSES).optional(),
      section: z.string().optional(),
      upcoming: z.coerce.boolean().optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['b.client_id = ?'];
  const params = [req.user.id];
  if (query.status) {
    conditions.push('b.status = ?');
    params.push(query.status);
  }
  if (query.section) {
    conditions.push('b.section = ?');
    params.push(query.section);
  }
  if (query.upcoming) {
    conditions.push('b.starts_at >= ?');
    conditions.push("b.status IN ('pending','confirmed')");
    params.push(nowIso());
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(`SELECT COUNT(*) AS c FROM bookings b ${where}`, params);
  const rows = await db.all(
    `SELECT b.*, biz.name_ar AS business_name, biz.name_en AS business_name_en,
            s.name AS staff_name, c.label AS chair_label,
            (SELECT COUNT(*) FROM reviews r WHERE r.booking_id = b.id) AS review_count
       FROM bookings b
       JOIN businesses biz ON biz.id = b.business_id
       LEFT JOIN staff s ON s.id = b.staff_id
       LEFT JOIN chairs c ON c.id = b.chair_id
       ${where}
      ORDER BY b.starts_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return S.page(
    rows.map((row) =>
      S.booking(row, {
        // A booking can only be rated once it has been completed.
        canReview: row.status === 'completed' && Number(row.review_count) === 0,
      }),
    ),
    { page, limit, total },
  );
});

/** One booking, visible to its client, the business owner, or an admin. */
router.get('/:bookingId', requireAuth, async (req) => {
  const db = getDb();
  const detail = await getBookingDetail(db, Number(req.params.bookingId));
  if (!detail) throw notFound('booking_not_found');
  const business = await db.get('SELECT owner_id FROM businesses WHERE id = ?', [
    detail.booking.business_id,
  ]);
  const allowed =
    req.user.role === 'admin' ||
    Number(detail.booking.client_id) === req.user.id ||
    Number(business?.owner_id) === req.user.id;
  if (!allowed) throw forbidden('not_your_booking');
  return {
    booking: S.booking(detail.booking, {
      canReview: detail.booking.status === 'completed' && !detail.review,
    }),
    items: detail.items.map(S.bookingItem),
    colours: detail.colours,
    review: detail.review ? S.review(detail.review) : null,
  };
});

router.post('/:bookingId/cancel', requireAuth, async (req) => {
  const input = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body || {});
  const booking = await cancelBooking(req.user, Number(req.params.bookingId), input);
  await recordAudit(req, { action: 'cancel', entity: 'booking', entityId: booking.id });
  return S.booking(booking);
});

// ---------------------------------------------------------------------------
// Owner diary
// ---------------------------------------------------------------------------

/** All bookings for one business, filterable by day, staff member or status. */
router.get('/business/:businessId', requireAuth, requireOwnership(), async (req) => {
  const query = parse(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      status: z.enum(BOOKING_STATUSES).optional(),
      staffId: z.coerce.number().int().positive().optional(),
      chairId: z.coerce.number().int().positive().optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['b.business_id = ?'];
  const params = [req.business.id];
  if (query.date) {
    conditions.push('b.starts_at >= ? AND b.starts_at <= ?');
    params.push(`${query.date}T00:00:00.000Z`, `${query.date}T23:59:59.999Z`);
  }
  if (query.from) {
    conditions.push('b.starts_at >= ?');
    params.push(`${query.from}T00:00:00.000Z`);
  }
  if (query.to) {
    conditions.push('b.starts_at <= ?');
    params.push(`${query.to}T23:59:59.999Z`);
  }
  if (query.status) {
    conditions.push('b.status = ?');
    params.push(query.status);
  }
  if (query.staffId) {
    conditions.push('b.staff_id = ?');
    params.push(query.staffId);
  }
  if (query.chairId) {
    conditions.push('b.chair_id = ?');
    params.push(query.chairId);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(`SELECT COUNT(*) AS c FROM bookings b ${where}`, params);
  const rows = await db.all(
    `SELECT b.*, u.full_name AS client_name, u.phone AS client_phone,
            s.name AS staff_name, c.label AS chair_label
       FROM bookings b
       JOIN users u ON u.id = b.client_id
       LEFT JOIN staff s ON s.id = b.staff_id
       LEFT JOIN chairs c ON c.id = b.chair_id
       ${where}
      ORDER BY b.starts_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const items = [];
  for (const row of rows) {
    const lineItems = await db.all('SELECT * FROM booking_items WHERE booking_id = ?', [row.id]);
    const colours = await db.all(
      `SELECT bnc.placement, nc.name_ar, nc.hex_code FROM booking_nail_colors bnc
         JOIN nail_colors nc ON nc.id = bnc.nail_color_id WHERE bnc.booking_id = ?`,
      [row.id],
    );
    items.push(S.booking(row, { items: lineItems.map(S.bookingItem), colours }));
  }
  return S.page(items, { page, limit, total });
});

/** Mark an appointment completed — required before the client can rate it. */
router.post('/:bookingId/complete', requireAuth, async (req) => {
  const db = getDb();
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.bookingId)]);
  if (!booking) throw notFound('booking_not_found');
  const business = await db.get('SELECT owner_id FROM businesses WHERE id = ?', [booking.business_id]);
  if (req.user.role !== 'admin' && Number(business?.owner_id) !== req.user.id) {
    throw forbidden('not_your_business', 'Only the business can mark an appointment completed.');
  }
  const updated = await completeBooking(db, booking.id);
  await recordAudit(req, { action: 'complete', entity: 'booking', entityId: booking.id });
  return S.booking(updated);
});

/** Mark a no-show. */
router.post('/:bookingId/no-show', requireAuth, async (req) => {
  const db = getDb();
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.bookingId)]);
  if (!booking) throw notFound('booking_not_found');
  const business = await db.get('SELECT owner_id FROM businesses WHERE id = ?', [booking.business_id]);
  if (req.user.role !== 'admin' && Number(business?.owner_id) !== req.user.id) {
    throw forbidden('not_your_business');
  }
  const updated = await db.update('bookings', booking.id, {
    status: 'no_show',
    updated_at: nowIso(),
  });
  return S.booking(updated);
});

export default router;
