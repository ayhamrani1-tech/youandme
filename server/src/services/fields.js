/**
 * Sports field sessions.
 *
 * Fields are not booked by one person taking a whole pitch; the owner publishes
 * a session (e.g. a 1.5-hour slot) priced *per person*, players join
 * individually, and the match confirms automatically once the quota — 14 players
 * by default — is reached. The quota and the per-person price are both set by
 * the owner.
 *
 * Joining is serialised: Postgres takes a row lock on the slot
 * (`SELECT … FOR UPDATE`) and SQLite's write lock does the same job, so two
 * players joining the 14th place at once cannot both succeed.
 */
import { getDb } from '../db/index.js';
import { addMinutes, isPast, nowIso } from '../lib/time.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { config } from '../config.js';

/** Publish a bookable session on a field. */
export async function createSlot(db, field, { startsAt, durationMin, pricePerPerson, requiredPlayers }) {
  const start = new Date(startsAt).toISOString();
  const duration = Number(durationMin) || config.rules.fieldSlotMinutes;
  const existing = await db.get('SELECT id FROM field_slots WHERE field_id = ? AND starts_at = ?', [
    field.id,
    start,
  ]);
  if (existing) throw conflict('slot_exists', 'A session already starts at that time.');

  // Reject a session that overlaps another on the same pitch.
  const end = addMinutes(start, duration);
  const clash = await db.get(
    `SELECT id FROM field_slots
      WHERE field_id = ? AND status != 'cancelled' AND starts_at < ? AND ends_at > ?`,
    [field.id, end, start],
  );
  if (clash) throw conflict('slot_overlap', 'That session overlaps one already scheduled.');

  return db.insert('field_slots', {
    field_id: field.id,
    starts_at: start,
    ends_at: end,
    duration_min: duration,
    price_per_person:
      pricePerPerson === undefined ? Number(field.price_per_person) : Number(pricePerPerson),
    required_players:
      requiredPlayers === undefined ? Number(field.required_players) : Number(requiredPlayers),
    joined_players: 0,
    status: 'open',
  });
}

/**
 * Join a session.
 *
 * `playersCount` lets one person bring friends (a group of 3 fills 3 places and
 * is charged for 3). The match confirms the moment the quota is met.
 */
export async function joinSlot(user, slotId, { playersCount = 1, paymentMethod = 'cash' } = {}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const slot = await tx.get(
      `SELECT s.*, f.business_id, f.name AS field_name, f.id AS field_id
         FROM field_slots s JOIN fields f ON f.id = s.field_id
        WHERE s.id = ?${tx.forUpdate ? ' FOR UPDATE OF s' : ''}`,
      [slotId],
    );
    if (!slot) throw notFound('slot_not_found', 'That session does not exist.');
    if (slot.status === 'cancelled') throw conflict('slot_cancelled', 'That session was cancelled.');
    if (slot.status === 'completed') throw conflict('slot_completed', 'That session has already been played.');
    if (isPast(slot.starts_at)) throw conflict('slot_started', 'That session has already started.');

    const business = await tx.get('SELECT * FROM businesses WHERE id = ?', [slot.business_id]);
    if (!business?.is_active && business?.is_active !== 1) {
      throw badRequest('business_inactive', 'This venue is not accepting bookings.');
    }

    const already = await tx.get('SELECT * FROM field_participants WHERE slot_id = ? AND user_id = ?', [
      slotId,
      user.id,
    ]);
    if (already && already.status === 'joined') {
      throw conflict('already_joined', 'You have already joined this session.');
    }

    const count = Math.max(1, Number(playersCount));
    const required = Number(slot.required_players);
    const joined = Number(slot.joined_players);
    const remaining = required - joined;
    if (remaining <= 0) throw conflict('slot_full', 'This match is already full.');
    if (count > remaining) {
      throw conflict(
        'not_enough_places',
        `Only ${remaining} place${remaining === 1 ? '' : 's'} left in this match.`,
      );
    }

    const amountDue = Math.round(Number(slot.price_per_person) * count * 100) / 100;

    if (already) {
      await tx.run(
        "UPDATE field_participants SET status = 'joined', players_count = ?, amount_due = ?, joined_at = ?, cancelled_at = NULL WHERE id = ?",
        [count, amountDue, nowIso(), already.id],
      );
    } else {
      await tx.insert('field_participants', {
        slot_id: slotId,
        user_id: user.id,
        players_count: count,
        amount_due: amountDue,
        status: 'joined',
      });
    }

    const newJoined = joined + count;
    // The quota being met is what confirms the match.
    const confirmed = newJoined >= required;
    await tx.run(
      'UPDATE field_slots SET joined_players = ?, status = ?, confirmed_at = ? WHERE id = ?',
      [
        newJoined,
        confirmed ? 'confirmed' : 'open',
        confirmed ? (slot.confirmed_at ?? nowIso()) : null,
        slotId,
      ],
    );

    await tx.insert('transactions', {
      user_id: user.id,
      business_id: slot.business_id,
      slot_id: slotId,
      kind: 'field_payment',
      amount: amountDue,
      currency: config.rules.currency,
      method: paymentMethod,
      status: paymentMethod === 'cash' ? 'pending' : 'paid',
      note: `${count} player(s) — ${slot.field_name}`,
    });

    return {
      slot: await tx.get('SELECT * FROM field_slots WHERE id = ?', [slotId]),
      playersCount: count,
      amountDue,
      confirmed,
      playersNeeded: Math.max(0, required - newJoined),
    };
  });
}

/** Leave a session; the match reverts to `open` if it drops below the quota. */
export async function leaveSlot(user, slotId) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const slot = await tx.get(
      `SELECT * FROM field_slots WHERE id = ?${tx.forUpdate ? tx.forUpdate : ''}`,
      [slotId],
    );
    if (!slot) throw notFound('slot_not_found');
    if (slot.status === 'completed') {
      throw conflict('slot_completed', 'That session has already been played.');
    }
    const participant = await tx.get(
      "SELECT * FROM field_participants WHERE slot_id = ? AND user_id = ? AND status = 'joined'",
      [slotId, user.id],
    );
    if (!participant) throw notFound('not_joined', 'You are not in this session.');

    await tx.run(
      "UPDATE field_participants SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
      [nowIso(), participant.id],
    );
    const newJoined = Math.max(0, Number(slot.joined_players) - Number(participant.players_count));
    const stillConfirmed = newJoined >= Number(slot.required_players);
    await tx.run(
      'UPDATE field_slots SET joined_players = ?, status = ?, confirmed_at = ? WHERE id = ?',
      [newJoined, stillConfirmed ? 'confirmed' : 'open', stillConfirmed ? slot.confirmed_at : null, slotId],
    );
    await tx.run(
      "UPDATE transactions SET status = 'refunded' WHERE slot_id = ? AND user_id = ? AND status IN ('pending','paid')",
      [slotId, user.id],
    );
    return tx.get('SELECT * FROM field_slots WHERE id = ?', [slotId]);
  });
}

/** Owner marks a session played — this is what unlocks rating the field. */
export async function completeSlot(db, slotId) {
  const slot = await db.get('SELECT * FROM field_slots WHERE id = ?', [slotId]);
  if (!slot) throw notFound('slot_not_found');
  if (slot.status === 'cancelled') {
    throw conflict('slot_cancelled', 'A cancelled session cannot be completed.');
  }
  const now = nowIso();
  await db.run("UPDATE field_slots SET status = 'completed', completed_at = ? WHERE id = ?", [
    now,
    slotId,
  ]);
  await db.run(
    "UPDATE transactions SET status = 'paid' WHERE slot_id = ? AND status = 'pending'",
    [slotId],
  );
  return db.get('SELECT * FROM field_slots WHERE id = ?', [slotId]);
}

export async function cancelSlot(db, slotId) {
  const slot = await db.get('SELECT * FROM field_slots WHERE id = ?', [slotId]);
  if (!slot) throw notFound('slot_not_found');
  if (slot.status === 'completed') {
    throw conflict('slot_completed', 'A played session cannot be cancelled.');
  }
  await db.run("UPDATE field_slots SET status = 'cancelled', confirmed_at = NULL WHERE id = ?", [slotId]);
  await db.run("UPDATE field_participants SET status = 'cancelled', cancelled_at = ? WHERE slot_id = ?", [
    nowIso(),
    slotId,
  ]);
  await db.run(
    "UPDATE transactions SET status = 'refunded' WHERE slot_id = ? AND status IN ('pending','paid')",
    [slotId],
  );
  return db.get('SELECT * FROM field_slots WHERE id = ?', [slotId]);
}

/** Guard used by owner-side slot endpoints. */
export async function assertOwnsSlot(db, user, slotId) {
  const row = await db.get(
    `SELECT s.*, f.business_id, b.owner_id
       FROM field_slots s
       JOIN fields f ON f.id = s.field_id
       JOIN businesses b ON b.id = f.business_id
      WHERE s.id = ?`,
    [slotId],
  );
  if (!row) throw notFound('slot_not_found');
  if (user.role !== 'admin' && Number(row.owner_id) !== user.id) {
    throw forbidden('not_your_business', 'You do not manage this field.');
  }
  return row;
}
