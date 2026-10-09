/**
 * Availability for appointment-based sections (barber, salon, dental, gym
 * training).
 *
 * A time is bookable when all of the following hold:
 *   • the business is open that weekday, and the slot fits inside its hours
 *   • the chosen staff member has no overlapping booking
 *   • the chosen chair/station has no overlapping booking
 *   • the slot has not already passed
 *
 * `resolveHours` resolves the per-weekday override table against the business
 * defaults, which is what lets an owner close on Fridays while keeping normal
 * hours the rest of the week.
 */
import { bool } from '../db/index.js';
import {
  combineDateTime,
  generateSlots,
  minutesOfDay,
  timeOfDayOf,
  weekdayOf,
  isPast,
} from '../lib/time.js';
import { badRequest, conflict } from '../lib/errors.js';

/** Effective opening hours for a business on a given date. */
export async function resolveHours(db, businessId, date) {
  const business = await db.get(
    'SELECT opens_at, closes_at, slot_minutes FROM businesses WHERE id = ?',
    [businessId],
  );
  if (!business) throw badRequest('business_not_found');
  const override = await db.get(
    'SELECT * FROM business_hours WHERE business_id = ? AND weekday = ?',
    [businessId, weekdayOf(`${date}T12:00:00Z`)],
  );
  if (override && bool(override.is_closed)) {
    return { isClosed: true, opensAt: null, closesAt: null, slotMinutes: Number(business.slot_minutes) };
  }
  return {
    isClosed: false,
    opensAt: override?.opens_at || business.opens_at,
    closesAt: override?.closes_at || business.closes_at,
    slotMinutes: Number(business.slot_minutes) || 30,
  };
}

/** Bookings that overlap a window, optionally for one staff member or chair. */
async function overlappingBookings(db, { businessId, startsAt, endsAt, staffId, chairId }) {
  const conditions = [
    'business_id = ?',
    "status IN ('pending', 'confirmed')",
    'starts_at < ?',
    'ends_at > ?',
  ];
  const params = [businessId, endsAt, startsAt];
  if (staffId) {
    conditions.push('staff_id = ?');
    params.push(staffId);
  }
  if (chairId) {
    conditions.push('chair_id = ?');
    params.push(chairId);
  }
  return db.all(`SELECT * FROM bookings WHERE ${conditions.join(' AND ')}`, params);
}

/** Throw unless the window is free for this staff member and chair. */
export async function assertSlotFree(db, { businessId, startsAt, endsAt, staffId, chairId, excludeBookingId }) {
  if (isPast(startsAt)) throw badRequest('slot_in_past', 'That time has already passed.');

  const date = String(startsAt).slice(0, 10);
  const hours = await resolveHours(db, businessId, date);
  if (hours.isClosed) throw conflict('closed_that_day', 'The business is closed on that day.');
  const startMinutes = minutesOfDay(timeOfDayOf(startsAt));
  const endMinutes = minutesOfDay(timeOfDayOf(endsAt));
  const open = minutesOfDay(hours.opensAt);
  const close = minutesOfDay(hours.closesAt);
  if (startMinutes < open || endMinutes > close || endMinutes <= startMinutes) {
    throw conflict(
      'outside_working_hours',
      `That time is outside working hours (${hours.opensAt}–${hours.closesAt}).`,
    );
  }

  if (staffId) {
    const clashes = (
      await overlappingBookings(db, { businessId, startsAt, endsAt, staffId })
    ).filter((b) => Number(b.id) !== Number(excludeBookingId));
    if (clashes.length) {
      throw conflict('staff_unavailable', 'That staff member is already booked at that time.');
    }
  }
  if (chairId) {
    const clashes = (
      await overlappingBookings(db, { businessId, startsAt, endsAt, chairId })
    ).filter((b) => Number(b.id) !== Number(excludeBookingId));
    if (clashes.length) {
      throw conflict('chair_unavailable', 'That chair is already taken at that time.');
    }
  }
}

/**
 * The bookable grid for one day, annotated with what is already taken.
 * `staffId` / `chairId` narrow availability to that resource.
 */
export async function availabilityForDay(db, { businessId, date, durationMinutes, staffId, chairId }) {
  const hours = await resolveHours(db, businessId, date);
  if (hours.isClosed) {
    return { date, isClosed: true, opensAt: null, closesAt: null, slots: [] };
  }
  const slots = generateSlots({
    date,
    opensAt: hours.opensAt,
    closesAt: hours.closesAt,
    stepMinutes: hours.slotMinutes,
    durationMinutes: durationMinutes || hours.slotMinutes,
  });

  const dayStart = combineDateTime(date, '00:00');
  const dayEnd = combineDateTime(date, '23:59');
  const conditions = ['business_id = ?', "status IN ('pending', 'confirmed')", 'starts_at >= ?', 'starts_at <= ?'];
  const params = [businessId, dayStart, dayEnd];
  if (staffId) {
    conditions.push('staff_id = ?');
    params.push(staffId);
  }
  if (chairId) {
    conditions.push('chair_id = ?');
    params.push(chairId);
  }
  const taken = await db.all(
    `SELECT starts_at, ends_at, staff_id, chair_id FROM bookings WHERE ${conditions.join(' AND ')}`,
    params,
  );

  return {
    date,
    isClosed: false,
    opensAt: hours.opensAt,
    closesAt: hours.closesAt,
    slots: slots.map((slot) => {
      const clash = taken.some(
        (b) => new Date(slot.startsAt) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(slot.endsAt),
      );
      const past = isPast(slot.startsAt);
      return { ...slot, available: !clash && !past, reason: past ? 'past' : clash ? 'booked' : null };
    }),
  };
}
