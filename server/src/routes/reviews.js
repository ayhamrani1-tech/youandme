/**
 * Reviews and ratings.
 *
 * The one rule that governs this whole file: a client may only rate something
 * that has already been completed. `assertReviewable` enforces it for both
 * appointment bookings and played field sessions, and no route writes a review
 * without passing through it.
 *
 * Salon and barber reviews can carry a second score for the individual staff
 * member, which is what feeds the per-hairdresser ratings clients choose from.
 */
import { Router } from '../lib/router.js';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { parse, pagination, z, rating } from '../lib/validate.js';
import * as S from '../lib/serialize.js';
import { forbidden, notFound, badRequest } from '../lib/errors.js';
import { assertReviewable, refreshAggregates, ratingBreakdown } from '../services/ratings.js';
import { recordAudit } from '../services/audit.js';

const router = new Router();

const createSchema = z
  .object({
    bookingId: z.coerce.number().int().positive().optional(),
    slotId: z.coerce.number().int().positive().optional(),
    rating,
    staffRating: rating.optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.bookingId || v.slotId, {
    message: 'Either bookingId or slotId is required',
    path: ['bookingId'],
  });

/** Leave a review. Rejected unless the booking or session is completed. */
router.post('/', requireAuth, async (req) => {
  const input = parse(createSchema, req.body);
  const db = getDb();
  const target = await assertReviewable(db, req.user, input);

  if (input.staffRating && !target.staffId) {
    throw badRequest('no_staff_to_rate', 'This booking had no staff member assigned.');
  }

  const row = await db.insert('reviews', {
    user_id: req.user.id,
    business_id: target.businessId,
    booking_id: target.bookingId,
    slot_id: target.slotId,
    field_id: target.fieldId,
    staff_id: target.staffId,
    rating: input.rating,
    staff_rating: input.staffRating ?? null,
    comment: input.comment ?? null,
  });
  await refreshAggregates(db, {
    businessId: target.businessId,
    staffId: target.staffId,
    fieldId: target.fieldId,
  });
  await recordAudit(req, { action: 'create', entity: 'review', entityId: row.id });
  return S.review(row);
});

/** Reviews for a business, newest first. */
router.get('/business/:businessId', async (req) => {
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const businessId = Number(req.params.businessId);
  const total = await db.value('SELECT COUNT(*) AS c FROM reviews WHERE business_id = ?', [businessId]);
  const rows = await db.all(
    `SELECT r.*, u.full_name AS user_name, s.name AS staff_name
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN staff s ON s.id = r.staff_id
      WHERE r.business_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    [businessId, limit, offset],
  );
  return {
    ...S.page(rows.map(S.review), { page, limit, total }),
    breakdown: await ratingBreakdown(businessId),
  };
});

/** Reviews for one staff member — the per-hairdresser rating clients browse. */
router.get('/staff/:staffId', async (req) => {
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const staffId = Number(req.params.staffId);
  const staff = await db.get('SELECT * FROM staff WHERE id = ?', [staffId]);
  if (!staff) throw notFound('staff_not_found');
  const total = await db.value(
    'SELECT COUNT(*) AS c FROM reviews WHERE staff_id = ? AND staff_rating IS NOT NULL',
    [staffId],
  );
  const rows = await db.all(
    `SELECT r.*, u.full_name AS user_name FROM reviews r
       JOIN users u ON u.id = r.user_id
      WHERE r.staff_id = ? AND r.staff_rating IS NOT NULL
      ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [staffId, limit, offset],
  );
  return { staff: S.staff(staff), ...S.page(rows.map(S.review), { page, limit, total }) };
});

/** Reviews for one pitch. */
router.get('/field/:fieldId', async (req) => {
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const fieldId = Number(req.params.fieldId);
  const total = await db.value('SELECT COUNT(*) AS c FROM reviews WHERE field_id = ?', [fieldId]);
  const rows = await db.all(
    `SELECT r.*, u.full_name AS user_name FROM reviews r
       JOIN users u ON u.id = r.user_id
      WHERE r.field_id = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [fieldId, limit, offset],
  );
  return S.page(rows.map(S.review), { page, limit, total });
});

/** The signed-in client's own reviews. */
router.get('/mine', requireAuth, async (req) => {
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const total = await db.value('SELECT COUNT(*) AS c FROM reviews WHERE user_id = ?', [req.user.id]);
  const rows = await db.all(
    `SELECT r.*, biz.name_ar AS business_name, s.name AS staff_name FROM reviews r
       JOIN businesses biz ON biz.id = r.business_id
       LEFT JOIN staff s ON s.id = r.staff_id
      WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [req.user.id, limit, offset],
  );
  return S.page(rows.map(S.review), { page, limit, total });
});

/** Edit your own review. */
router.put('/:reviewId', requireAuth, async (req) => {
  const input = parse(
    z.object({ rating: rating.optional(), staffRating: rating.optional(), comment: z.string().trim().max(1000).optional() }),
    req.body,
  );
  const db = getDb();
  const existing = await db.get('SELECT * FROM reviews WHERE id = ?', [Number(req.params.reviewId)]);
  if (!existing) throw notFound('review_not_found');
  if (req.user.role !== 'admin' && Number(existing.user_id) !== req.user.id) {
    throw forbidden('not_your_review', 'You can only edit your own review.');
  }
  const row = await db.update('reviews', existing.id, {
    rating: input.rating,
    staff_rating: input.staffRating,
    comment: input.comment,
  });
  await refreshAggregates(db, {
    businessId: Number(existing.business_id),
    staffId: existing.staff_id ? Number(existing.staff_id) : null,
    fieldId: existing.field_id ? Number(existing.field_id) : null,
  });
  return S.review(row);
});

/** Delete a review — its author, or an admin moderating. */
router.delete('/:reviewId', requireAuth, async (req) => {
  const db = getDb();
  const existing = await db.get('SELECT * FROM reviews WHERE id = ?', [Number(req.params.reviewId)]);
  if (!existing) throw notFound('review_not_found');
  if (req.user.role !== 'admin' && Number(existing.user_id) !== req.user.id) {
    throw forbidden('not_your_review');
  }
  await db.delete('reviews', existing.id);
  await refreshAggregates(db, {
    businessId: Number(existing.business_id),
    staffId: existing.staff_id ? Number(existing.staff_id) : null,
    fieldId: existing.field_id ? Number(existing.field_id) : null,
  });
  await recordAudit(req, { action: 'delete', entity: 'review', entityId: existing.id });
  return { ok: true };
});

export default router;
