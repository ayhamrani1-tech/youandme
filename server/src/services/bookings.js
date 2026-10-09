/**
 * Booking engine for the appointment sections.
 *
 * One flow serves all four, with the section-specific rules applied as checks
 * rather than as separate code paths:
 *
 *   barber  — male-only; a specific chair and the barber at it; regular cut vs
 *             groom's package
 *   salon   — female-only; a chosen staff member; nail work on hands, feet or
 *             both with exact polish colours from the salon's own palette
 *   dental  — a fixed-price treatment chosen from the clinic's catalogue
 *   gym     — a private-training session with a trainer
 *
 * Money is only ever derived from the owner's own price rows, never from
 * anything the client sends.
 */
import { getDb } from '../db/index.js';
import { assertGenderAllowed } from '../middleware/auth.js';
import { assertSlotFree } from './availability.js';
import { spendPoints, getGymSettings, balanceOf } from './points.js';
import { randomReference } from '../lib/security.js';
import { addMinutes, addMonths, nowIso, hoursUntil } from '../lib/time.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { config } from '../config.js';

/** Resolve the services a client picked, priced from the owner's rows. */
async function priceServices(db, businessId, items) {
  if (!items?.length) return { lines: [], total: 0, durationMin: 0 };
  const lines = [];
  let total = 0;
  let durationMin = 0;
  for (const item of items) {
    const row = await db.get('SELECT * FROM services WHERE id = ? AND business_id = ?', [
      item.serviceId,
      businessId,
    ]);
    if (!row) {
      throw badRequest('service_not_found', `Service ${item.serviceId} is not offered here.`);
    }
    if (!row.is_active && row.is_active !== 1) {
      throw badRequest('service_inactive', `"${row.name_ar}" is not currently available.`);
    }
    const qty = Math.max(1, Number(item.qty || 1));
    const unitPrice =
      Math.round(Number(row.price) * (1 - Number(row.discount_percent || 0) / 100) * 100) / 100;
    const lineTotal = Math.round(unitPrice * qty * 100) / 100;
    lines.push({
      service_id: row.id,
      label: row.name_ar,
      unit_price: unitPrice,
      qty,
      line_total: lineTotal,
    });
    total += lineTotal;
    durationMin += Number(row.duration_min || 0) * qty;
  }
  return { lines, total: Math.round(total * 100) / 100, durationMin };
}

/** Section-specific validation, run before anything is written. */
async function validateSectionRules(db, business, input) {
  const section = business.section;

  if (section === 'barber') {
    if (input.bookingType && !['regular', 'groom'].includes(input.bookingType)) {
      throw badRequest('invalid_booking_type', 'Booking type must be regular or groom.');
    }
  }

  if (section === 'salon') {
    if (input.nailScope && !['hands', 'feet', 'both'].includes(input.nailScope)) {
      throw badRequest('invalid_nail_scope', 'Nail scope must be hands, feet or both.');
    }
    if (input.nailColorIds?.length) {
      if (!input.nailScope) {
        throw badRequest('nail_scope_required', 'Choose hands, feet or both before picking colours.');
      }
      for (const entry of input.nailColorIds) {
        const colour = await db.get(
          'SELECT * FROM nail_colors WHERE id = ? AND business_id = ?',
          [entry.nailColorId, business.id],
        );
        if (!colour) {
          throw badRequest('nail_color_not_found', 'That polish colour is not in this salon’s palette.');
        }
        if (input.nailScope !== 'both' && entry.placement !== input.nailScope) {
          throw badRequest(
            'placement_mismatch',
            `You chose ${input.nailScope} only, so colours cannot be set for ${entry.placement}.`,
          );
        }
      }
    }
  }

  if (section === 'dental') {
    if (!input.treatmentCode) {
      throw badRequest('treatment_required', 'Choose the procedure you need.');
    }
    const treatment = await db.get(
      `SELECT * FROM services
        WHERE business_id = ? AND treatment_code = ? AND kind = 'treatment'`,
      [business.id, input.treatmentCode],
    );
    if (!treatment) {
      throw badRequest('treatment_not_offered', 'This clinic does not offer that procedure.');
    }
    return { treatment };
  }

  return {};
}

/** Validate the chosen chair and staff member belong to this business. */
async function resolveResources(db, business, { staffId, chairId }) {
  let staff = null;
  let chair = null;
  if (chairId) {
    chair = await db.get('SELECT * FROM chairs WHERE id = ? AND business_id = ?', [
      chairId,
      business.id,
    ]);
    if (!chair) throw badRequest('chair_not_found', 'That chair does not belong to this business.');
    if (!chair.is_active && chair.is_active !== 1) {
      throw badRequest('chair_inactive', 'That chair is out of service.');
    }
  }
  if (staffId) {
    staff = await db.get('SELECT * FROM staff WHERE id = ? AND business_id = ?', [
      staffId,
      business.id,
    ]);
    if (!staff) throw badRequest('staff_not_found', 'That staff member does not work here.');
    if (!staff.is_active && staff.is_active !== 1) {
      throw badRequest('staff_inactive', 'That staff member is not taking bookings.');
    }
  } else if (chair?.staff_id) {
    // Booking "Chair 2 with Mazen" — the chair implies its barber.
    staff = await db.get('SELECT * FROM staff WHERE id = ?', [chair.staff_id]);
  }
  return { staff, chair };
}

/**
 * Create a booking.
 *
 * `input`: { businessId, startsAt, durationMin?, staffId?, chairId?, items[],
 *            bookingType?, nailScope?, nailColorIds[], treatmentCode?,
 *            paymentMethod?, notes? }
 */
export async function createBooking(user, input) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const business = await tx.get('SELECT * FROM businesses WHERE id = ?', [input.businessId]);
    if (!business) throw notFound('business_not_found', 'That business does not exist.');
    if (!business.is_active && business.is_active !== 1) {
      throw badRequest('business_inactive', 'This business is not accepting bookings.');
    }
    if (business.section === 'sports_field') {
      throw badRequest(
        'use_field_sessions',
        'Sports fields are booked by joining a session, not through this endpoint.',
      );
    }

    // Men's barber shop / women's salon access control.
    assertGenderAllowed(user, business);

    const extras = await validateSectionRules(tx, business, input);
    const { staff, chair } = await resolveResources(tx, business, input);

    // Price everything from the owner's catalogue.
    const items = [...(input.items || [])];
    if (business.section === 'dental' && extras.treatment) {
      const alreadyListed = items.some((i) => Number(i.serviceId) === Number(extras.treatment.id));
      if (!alreadyListed) items.unshift({ serviceId: extras.treatment.id, qty: 1 });
    }
    const priced = await priceServices(tx, business.id, items);
    if (!priced.lines.length) {
      throw badRequest('no_services', 'Choose at least one service.');
    }

    const durationMin =
      Number(input.durationMin) || priced.durationMin || Number(business.slot_minutes) || 30;
    const startsAt = new Date(input.startsAt).toISOString();
    const endsAt = addMinutes(startsAt, durationMin);

    await assertSlotFree(tx, {
      businessId: business.id,
      startsAt,
      endsAt,
      staffId: staff?.id,
      chairId: chair?.id,
    });

    // Gym private training may be paid from the point wallet.
    let pointsSpent = 0;
    const paymentMethod = input.paymentMethod || 'cash';
    if (paymentMethod === 'points') {
      if (business.section !== 'gym') {
        throw badRequest('points_not_accepted', 'Points can only be spent at gyms.');
      }
      const settings = await getGymSettings(tx, business.id);
      pointsSpent = Number(settings.points_per_entry);
      await spendPoints(tx, {
        userId: user.id,
        businessId: business.id,
        points: pointsSpent,
        kind: 'entry',
        note: 'Gym session',
      });
    }

    const booking = await tx.insert('bookings', {
      reference: randomReference(),
      business_id: business.id,
      client_id: user.id,
      section: business.section,
      staff_id: staff?.id ?? null,
      chair_id: chair?.id ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      booking_type: business.section === 'barber' ? input.bookingType || 'regular' : null,
      nail_scope: business.section === 'salon' ? input.nailScope || null : null,
      treatment_code: business.section === 'dental' ? input.treatmentCode : null,
      status: 'confirmed',
      total_amount: paymentMethod === 'points' ? 0 : priced.total,
      payment_method: paymentMethod,
      points_spent: pointsSpent,
      notes: input.notes || null,
    });

    for (const line of priced.lines) {
      await tx.insert('booking_items', { booking_id: booking.id, ...line });
    }

    if (business.section === 'salon' && input.nailColorIds?.length) {
      for (const entry of input.nailColorIds) {
        await tx.insert('booking_nail_colors', {
          booking_id: booking.id,
          nail_color_id: entry.nailColorId,
          placement: entry.placement,
        });
      }
    }

    if (paymentMethod !== 'points' && priced.total > 0) {
      await tx.insert('transactions', {
        user_id: user.id,
        business_id: business.id,
        booking_id: booking.id,
        kind: 'booking_payment',
        amount: priced.total,
        currency: config.rules.currency,
        method: paymentMethod,
        status: paymentMethod === 'cash' ? 'pending' : 'paid',
        note: booking.reference,
      });
    }

    return { booking, items: priced.lines, pointsSpent };
  });
}

/** Full booking detail, including line items and chosen polish colours. */
export async function getBookingDetail(db, bookingId) {
  const booking = await db.get(
    `SELECT b.*, s.name AS staff_name, c.label AS chair_label,
            biz.name_ar AS business_name, biz.name_en AS business_name_en,
            biz.section AS business_section,
            u.full_name AS client_name, u.phone AS client_phone
       FROM bookings b
       JOIN businesses biz ON biz.id = b.business_id
       JOIN users u ON u.id = b.client_id
       LEFT JOIN staff s ON s.id = b.staff_id
       LEFT JOIN chairs c ON c.id = b.chair_id
      WHERE b.id = ?`,
    [bookingId],
  );
  if (!booking) return null;
  const items = await db.all('SELECT * FROM booking_items WHERE booking_id = ?', [bookingId]);
  const colours = await db.all(
    `SELECT bnc.placement, nc.id, nc.name_ar, nc.name_en, nc.hex_code
       FROM booking_nail_colors bnc
       JOIN nail_colors nc ON nc.id = bnc.nail_color_id
      WHERE bnc.booking_id = ?`,
    [bookingId],
  );
  const review = await db.get('SELECT * FROM reviews WHERE booking_id = ?', [bookingId]);
  return { booking, items, colours, review };
}

/** Owner/admin marks an appointment done — this is what unlocks rating it. */
export async function completeBooking(db, bookingId) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  if (!booking) throw notFound('booking_not_found');
  if (booking.status === 'completed') return booking;
  if (booking.status === 'cancelled') {
    throw conflict('booking_cancelled', 'A cancelled booking cannot be completed.');
  }
  const now = nowIso();
  await db.run(
    "UPDATE bookings SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
    [now, now, bookingId],
  );
  await db.run(
    "UPDATE transactions SET status = 'paid' WHERE booking_id = ? AND status = 'pending'",
    [bookingId],
  );
  return db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
}

/** Cancel a booking, refunding any points that were spent on it. */
export async function cancelBooking(user, bookingId, { reason } = {}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const booking = await tx.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!booking) throw notFound('booking_not_found');

    const business = await tx.get('SELECT owner_id FROM businesses WHERE id = ?', [
      booking.business_id,
    ]);
    const isOwner = Number(business?.owner_id) === user.id;
    const isClient = Number(booking.client_id) === user.id;
    if (user.role !== 'admin' && !isOwner && !isClient) {
      throw forbidden('not_your_booking', 'You cannot cancel this booking.');
    }
    if (booking.status === 'cancelled') return booking;
    if (booking.status === 'completed') {
      throw conflict('booking_completed', 'A completed booking cannot be cancelled.');
    }
    // Clients are held to the cancellation window; owners and admins are not.
    if (isClient && user.role === 'client' && !isOwner) {
      const hours = hoursUntil(booking.starts_at);
      if (hours < config.rules.cancellationWindowHours) {
        throw conflict(
          'too_late_to_cancel',
          `Bookings can only be cancelled more than ${config.rules.cancellationWindowHours} hours in advance.`,
        );
      }
    }

    const now = nowIso();
    const notes = booking.notes || reason || null;
    await tx.run(
      "UPDATE bookings SET status = 'cancelled', cancelled_at = ?, updated_at = ?, notes = ? WHERE id = ?",
      [now, now, notes, bookingId],
    );

    if (Number(booking.points_spent) > 0) {
      const settings = await getGymSettings(tx, booking.business_id);
      const refundedAt = nowIso();
      const lot = await tx.insert('point_lots', {
        user_id: booking.client_id,
        business_id: booking.business_id,
        points_purchased: Number(booking.points_spent),
        points_remaining: Number(booking.points_spent),
        price_paid: 0,
        purchased_at: refundedAt,
        expires_at: addMonths(refundedAt, Number(settings.expiry_months)),
        status: 'active',
      });
      const balance = await balanceOf(tx, booking.client_id, booking.business_id, { sweep: false });
      await tx.insert('point_transactions', {
        user_id: booking.client_id,
        business_id: booking.business_id,
        lot_id: lot.id,
        booking_id: bookingId,
        kind: 'refund',
        points: Number(booking.points_spent),
        balance_after: balance,
        note: `Refund for cancelled booking ${booking.reference}`,
      });
    }

    await tx.run(
      "UPDATE transactions SET status = 'refunded' WHERE booking_id = ? AND status IN ('pending', 'paid')",
      [bookingId],
    );
    return tx.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
  });
}
