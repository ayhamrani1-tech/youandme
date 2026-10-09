/**
 * Review eligibility and rating aggregates.
 *
 * The platform-wide rule from the specification is that a client may only rate
 * a service *after* it has been completed — never at booking time. That check
 * lives in `assertReviewable` and is the single gate every review passes
 * through.
 *
 * `rating_avg` / `rating_count` on businesses, staff and fields are maintained
 * as caches so listing pages never aggregate at read time; they are recomputed
 * from the `reviews` table whenever a review is written or removed.
 */
import { getDb } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';

/**
 * Confirm the caller may review this booking or field slot.
 * Returns `{ businessId, bookingId, slotId, fieldId }` to attach to the review.
 */
export async function assertReviewable(db, user, { bookingId, slotId }) {
  if (!bookingId && !slotId) {
    throw badRequest('review_target_required', 'A booking or a field session must be given.');
  }

  if (bookingId) {
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!booking) throw notFound('booking_not_found', 'That booking does not exist.');
    if (user.role !== 'admin' && Number(booking.client_id) !== user.id) {
      throw forbidden('not_your_booking', 'You can only review your own bookings.');
    }
    if (booking.status !== 'completed') {
      throw conflict(
        'booking_not_completed',
        'You can rate this only after the appointment has been completed.',
      );
    }
    const existing = await db.get('SELECT id FROM reviews WHERE booking_id = ?', [bookingId]);
    if (existing) throw conflict('already_reviewed', 'You have already rated this booking.');
    return {
      businessId: Number(booking.business_id),
      bookingId: Number(booking.id),
      slotId: null,
      fieldId: null,
      staffId: booking.staff_id === null ? null : Number(booking.staff_id),
    };
  }

  const slot = await db.get(
    `SELECT s.*, f.business_id, f.id AS field_id
       FROM field_slots s JOIN fields f ON f.id = s.field_id
      WHERE s.id = ?`,
    [slotId],
  );
  if (!slot) throw notFound('slot_not_found', 'That session does not exist.');
  if (slot.status !== 'completed') {
    throw conflict(
      'session_not_completed',
      'You can rate the field only after the session has been played.',
    );
  }
  if (user.role !== 'admin') {
    const joined = await db.get(
      "SELECT id FROM field_participants WHERE slot_id = ? AND user_id = ? AND status = 'joined'",
      [slotId, user.id],
    );
    if (!joined) throw forbidden('not_a_participant', 'You did not play in this session.');
  }
  const existing = await db.get('SELECT id FROM reviews WHERE slot_id = ? AND user_id = ?', [
    slotId,
    user.id,
  ]);
  if (existing) throw conflict('already_reviewed', 'You have already rated this session.');
  return {
    businessId: Number(slot.business_id),
    bookingId: null,
    slotId: Number(slot.id),
    fieldId: Number(slot.field_id),
    staffId: null,
  };
}

async function recomputeFor(db, table, idColumn, id, ratingColumn = 'rating') {
  if (!id) return;
  const row = await db.get(
    `SELECT COUNT(*) AS count, COALESCE(AVG(${ratingColumn}), 0) AS avg
       FROM reviews WHERE ${idColumn} = ? AND ${ratingColumn} IS NOT NULL`,
    [id],
  );
  const avg = Math.round(Number(row?.avg ?? 0) * 100) / 100;
  await db.run(`UPDATE ${table} SET rating_avg = ?, rating_count = ? WHERE id = ?`, [
    avg,
    Number(row?.count ?? 0),
    id,
  ]);
}

/** Refresh every aggregate a review touches. */
export async function refreshAggregates(db, { businessId, staffId, fieldId }) {
  await recomputeFor(db, 'businesses', 'business_id', businessId);
  if (staffId) await recomputeFor(db, 'staff', 'staff_id', staffId, 'staff_rating');
  if (fieldId) await recomputeFor(db, 'fields', 'field_id', fieldId);
}

/** Rating breakdown (how many 5s, 4s, …) for a business page. */
export async function ratingBreakdown(businessId) {
  const db = getDb();
  const rows = await db.all(
    `SELECT rating, COUNT(*) AS count FROM reviews WHERE business_id = ? GROUP BY rating`,
    [businessId],
  );
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of rows) breakdown[Number(row.rating)] = Number(row.count);
  return breakdown;
}
