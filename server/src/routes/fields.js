/**
 * Section 1 — Sports fields.
 *
 * Clients browse open sessions and join them; a match confirms when the quota
 * (14 players by default) fills. Owners manage pitches, publish sessions, set
 * the per-person price, and mark sessions played.
 */
import { Router } from '../lib/router.js';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole, requireOwnership, optionalAuth } from '../middleware/auth.js';
import { parse, pagination, z, money, limitedDescription, isoDateTime } from '../lib/validate.js';
import * as S from '../lib/serialize.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { nowIso, distanceKm } from '../lib/time.js';
import {
  createSlot,
  joinSlot,
  leaveSlot,
  completeSlot,
  cancelSlot,
  assertOwnsSlot,
} from '../services/fields.js';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';

const router = new Router();

const fieldSchema = z.object({
  name: z.string().trim().min(2).max(120),
  surface: z.enum(['grass', 'artificial', 'indoor', 'sand']).optional(),
  sizeLabel: z.string().trim().max(40).optional(),
  pricePerPerson: money,
  // The owner may raise or lower the quota; the platform default is 14.
  requiredPlayers: z.coerce.number().int().min(2).max(60).default(config.rules.fieldRequiredPlayers),
  description: limitedDescription.optional(),
  isActive: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Public: pitches and open sessions
// ---------------------------------------------------------------------------

/** Every pitch, with its venue. */
router.get('/', optionalAuth, async (req) => {
  const query = parse(
    z.object({
      governorate: z.string().trim().max(60).optional(),
      q: z.string().trim().max(120).optional(),
      surface: z.enum(['grass', 'artificial', 'indoor', 'sand']).optional(),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();
  const conditions = ['f.is_active = ?', 'b.is_active = ?'];
  const params = [true, true];
  if (query.governorate) {
    conditions.push('b.governorate = ?');
    params.push(query.governorate);
  }
  if (query.surface) {
    conditions.push('f.surface = ?');
    params.push(query.surface);
  }
  if (query.q) {
    conditions.push('(f.name LIKE ? OR b.name_ar LIKE ? OR b.city LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(
    `SELECT COUNT(*) AS c FROM fields f JOIN businesses b ON b.id = f.business_id ${where}`,
    params,
  );
  const rows = await db.all(
    `SELECT f.*, b.name_ar AS business_name, b.name_en AS business_name_en, b.city, b.governorate,
            b.lat, b.lng, b.cover_url
       FROM fields f JOIN businesses b ON b.id = f.business_id
       ${where}
      ORDER BY f.rating_avg DESC, f.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return S.page(
    rows.map((row) =>
      S.field(row, {
        business: { id: Number(row.business_id), name: { ar: row.business_name, en: row.business_name_en } },
        city: row.city,
        governorate: row.governorate,
        coverUrl: row.cover_url,
        distanceKm: distanceKm(req.user?.lat, req.user?.lng, row.lat, row.lng),
      }),
    ),
    { page, limit, total },
  );
});

/**
 * Open sessions a client can join, soonest first.
 * `?onlyJoinable=true` hides full matches.
 */
router.get('/slots', optionalAuth, async (req) => {
  const query = parse(
    z.object({
      fieldId: z.coerce.number().int().positive().optional(),
      businessId: z.coerce.number().int().positive().optional(),
      governorate: z.string().trim().max(60).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      status: z.enum(['open', 'confirmed', 'completed', 'cancelled']).optional(),
      onlyJoinable: z.coerce.boolean().default(false),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();

  const conditions = ['f.is_active = ?', 'b.is_active = ?'];
  const params = [true, true];
  if (query.fieldId) {
    conditions.push('s.field_id = ?');
    params.push(query.fieldId);
  }
  if (query.businessId) {
    conditions.push('f.business_id = ?');
    params.push(query.businessId);
  }
  if (query.governorate) {
    conditions.push('b.governorate = ?');
    params.push(query.governorate);
  }
  if (query.date) {
    conditions.push('s.starts_at >= ? AND s.starts_at <= ?');
    params.push(`${query.date}T00:00:00.000Z`, `${query.date}T23:59:59.999Z`);
  }
  if (query.status) {
    conditions.push('s.status = ?');
    params.push(query.status);
  } else {
    conditions.push("s.status IN ('open', 'confirmed')");
    conditions.push('s.starts_at > ?');
    params.push(nowIso());
  }
  if (query.onlyJoinable) {
    conditions.push('s.joined_players < s.required_players');
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = await db.value(
    `SELECT COUNT(*) AS c FROM field_slots s
       JOIN fields f ON f.id = s.field_id JOIN businesses b ON b.id = f.business_id ${where}`,
    params,
  );
  const rows = await db.all(
    `SELECT s.*, f.name AS field_name, f.surface, f.business_id,
            b.name_ar AS business_name, b.name_en AS business_name_en,
            b.city, b.governorate, b.lat, b.lng
       FROM field_slots s
       JOIN fields f ON f.id = s.field_id
       JOIN businesses b ON b.id = f.business_id
       ${where}
      ORDER BY s.starts_at ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  // Flag the sessions the signed-in client is already in.
  let joinedIds = new Set();
  if (req.user && rows.length) {
    const mine = await db.all(
      `SELECT slot_id FROM field_participants WHERE user_id = ? AND status = 'joined'`,
      [req.user.id],
    );
    joinedIds = new Set(mine.map((r) => Number(r.slot_id)));
  }

  return S.page(
    rows.map((row) =>
      S.fieldSlot(row, {
        surface: row.surface,
        business: { id: Number(row.business_id), name: { ar: row.business_name, en: row.business_name_en } },
        city: row.city,
        governorate: row.governorate,
        distanceKm: distanceKm(req.user?.lat, req.user?.lng, row.lat, row.lng),
        hasJoined: joinedIds.has(Number(row.id)),
      }),
    ),
    { page, limit, total },
  );
});

router.get('/slots/:slotId', optionalAuth, async (req) => {
  const db = getDb();
  const row = await db.get(
    `SELECT s.*, f.name AS field_name, f.surface, f.description, f.business_id,
            b.name_ar AS business_name, b.name_en AS business_name_en, b.city, b.address, b.map_url
       FROM field_slots s
       JOIN fields f ON f.id = s.field_id
       JOIN businesses b ON b.id = f.business_id
      WHERE s.id = ?`,
    [Number(req.params.slotId)],
  );
  if (!row) throw notFound('slot_not_found');
  const participants = await db.all(
    `SELECT p.*, u.full_name AS user_name FROM field_participants p
       JOIN users u ON u.id = p.user_id
      WHERE p.slot_id = ? AND p.status = 'joined' ORDER BY p.joined_at`,
    [row.id],
  );
  return S.fieldSlot(row, {
    surface: row.surface,
    description: row.description,
    business: {
      id: Number(row.business_id),
      name: { ar: row.business_name, en: row.business_name_en },
      city: row.city,
      address: row.address,
      mapUrl: row.map_url,
    },
    participants: participants.map(S.participant),
    hasJoined: req.user ? participants.some((p) => Number(p.user_id) === req.user.id) : false,
  });
});

router.get('/:fieldId', optionalAuth, async (req) => {
  const db = getDb();
  const row = await db.get(
    `SELECT f.*, b.name_ar AS business_name, b.name_en AS business_name_en, b.city, b.governorate,
            b.address, b.map_url, b.lat, b.lng, b.cover_url, b.phone
       FROM fields f JOIN businesses b ON b.id = f.business_id WHERE f.id = ?`,
    [Number(req.params.fieldId)],
  );
  if (!row) throw notFound('field_not_found');
  const slots = await db.all(
    `SELECT * FROM field_slots
      WHERE field_id = ? AND status IN ('open','confirmed') AND starts_at > ?
      ORDER BY starts_at LIMIT 60`,
    [row.id, nowIso()],
  );
  const reviews = await db.all(
    `SELECT r.*, u.full_name AS user_name FROM reviews r JOIN users u ON u.id = r.user_id
      WHERE r.field_id = ? ORDER BY r.created_at DESC LIMIT 20`,
    [row.id],
  );
  return S.field(row, {
    business: {
      id: Number(row.business_id),
      name: { ar: row.business_name, en: row.business_name_en },
      city: row.city,
      governorate: row.governorate,
      address: row.address,
      mapUrl: row.map_url,
      phone: row.phone,
      coverUrl: row.cover_url,
    },
    distanceKm: distanceKm(req.user?.lat, req.user?.lng, row.lat, row.lng),
    slots: slots.map((s) => S.fieldSlot(s)),
    reviews: reviews.map(S.review),
  });
});

// ---------------------------------------------------------------------------
// Client actions
// ---------------------------------------------------------------------------

/** Join a session, optionally bringing friends. */
router.post('/slots/:slotId/join', requireAuth, requireRole('client'), async (req) => {
  const input = parse(
    z.object({
      playersCount: z.coerce.number().int().min(1).max(30).default(1),
      paymentMethod: z.enum(['cash', 'card']).default('cash'),
    }),
    req.body,
  );
  const result = await joinSlot(req.user, Number(req.params.slotId), input);
  return {
    slot: S.fieldSlot(result.slot),
    playersCount: result.playersCount,
    amountDue: result.amountDue,
    confirmed: result.confirmed,
    playersNeeded: result.playersNeeded,
    message: result.confirmed
      ? 'The quota has been reached — the match is confirmed.'
      : `${result.playersNeeded} more player(s) needed to confirm this match.`,
  };
});

router.delete('/slots/:slotId/join', requireAuth, async (req) => {
  const slot = await leaveSlot(req.user, Number(req.params.slotId));
  return S.fieldSlot(slot);
});

// ---------------------------------------------------------------------------
// Owner management
// ---------------------------------------------------------------------------

router.post('/business/:businessId', requireAuth, requireOwnership('businessId', { section: 'sports_field' }), async (req) => {
  const input = parse(fieldSchema, req.body);
  const db = getDb();
  const row = await db.insert('fields', {
    business_id: req.business.id,
    name: input.name,
    surface: input.surface ?? null,
    size_label: input.sizeLabel ?? null,
    price_per_person: input.pricePerPerson,
    required_players: input.requiredPlayers,
    description: input.description ?? null,
    is_active: input.isActive,
  });
  await recordAudit(req, { action: 'create', entity: 'field', entityId: row.id });
  return S.field(row);
});

/** Owner guard for routes keyed by field id rather than business id. */
async function loadOwnedField(req) {
  const db = getDb();
  const row = await db.get(
    `SELECT f.*, b.owner_id, b.section FROM fields f JOIN businesses b ON b.id = f.business_id
      WHERE f.id = ?`,
    [Number(req.params.fieldId)],
  );
  if (!row) throw notFound('field_not_found');
  if (req.user.role !== 'admin' && Number(row.owner_id) !== req.user.id) {
    throw forbidden('not_your_business', 'You do not manage this field.');
  }
  return row;
}

router.put('/:fieldId', requireAuth, async (req) => {
  const field = await loadOwnedField(req);
  const input = parse(fieldSchema.partial(), req.body);
  const db = getDb();
  const row = await db.update('fields', field.id, {
    name: input.name,
    surface: input.surface,
    size_label: input.sizeLabel,
    price_per_person: input.pricePerPerson,
    required_players: input.requiredPlayers,
    description: input.description,
    is_active: input.isActive,
    updated_at: nowIso(),
  });
  return S.field(row);
});

router.delete('/:fieldId', requireAuth, async (req) => {
  const field = await loadOwnedField(req);
  const db = getDb();
  await db.delete('fields', field.id);
  await recordAudit(req, { action: 'delete', entity: 'field', entityId: field.id });
  return { ok: true };
});

/** Publish one session. */
router.post('/:fieldId/slots', requireAuth, async (req) => {
  const field = await loadOwnedField(req);
  const input = parse(
    z.object({
      startsAt: isoDateTime,
      durationMin: z.coerce.number().int().min(15).max(480).default(config.rules.fieldSlotMinutes),
      pricePerPerson: money.optional(),
      requiredPlayers: z.coerce.number().int().min(2).max(60).optional(),
    }),
    req.body,
  );
  const db = getDb();
  const slot = await createSlot(db, field, input);
  return S.fieldSlot(slot);
});

/**
 * Publish a repeating series — e.g. 19:00 and 20:30 every day for two weeks.
 * This is how owners realistically fill a schedule.
 */
router.post('/:fieldId/slots/bulk', requireAuth, async (req) => {
  const field = await loadOwnedField(req);
  const input = parse(
    z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      days: z.coerce.number().int().min(1).max(60).default(7),
      times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(12),
      durationMin: z.coerce.number().int().min(15).max(480).default(config.rules.fieldSlotMinutes),
      pricePerPerson: money.optional(),
      requiredPlayers: z.coerce.number().int().min(2).max(60).optional(),
      weekdays: z.array(z.coerce.number().int().min(0).max(6)).optional(),
    }),
    req.body,
  );
  const db = getDb();
  const created = [];
  const skipped = [];
  for (let day = 0; day < input.days; day += 1) {
    const date = new Date(`${input.startDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + day);
    if (input.weekdays && !input.weekdays.includes(date.getUTCDay())) continue;
    const dateStr = date.toISOString().slice(0, 10);
    for (const time of input.times) {
      try {
        const slot = await createSlot(db, field, {
          startsAt: `${dateStr}T${time}:00.000Z`,
          durationMin: input.durationMin,
          pricePerPerson: input.pricePerPerson,
          requiredPlayers: input.requiredPlayers,
        });
        created.push(S.fieldSlot(slot));
      } catch (err) {
        skipped.push({ date: dateStr, time, reason: err.code || 'error' });
      }
    }
  }
  return { created, skipped, createdCount: created.length };
});

/** Sessions for an owner's own field, including past ones. */
router.get('/:fieldId/slots/manage', requireAuth, async (req) => {
  const field = await loadOwnedField(req);
  const db = getDb();
  const rows = await db.all(
    'SELECT * FROM field_slots WHERE field_id = ? ORDER BY starts_at DESC LIMIT 200',
    [field.id],
  );
  const slots = [];
  for (const row of rows) {
    const participants = await db.all(
      `SELECT p.*, u.full_name AS user_name, u.phone FROM field_participants p
         JOIN users u ON u.id = p.user_id
        WHERE p.slot_id = ? AND p.status = 'joined' ORDER BY p.joined_at`,
      [row.id],
    );
    slots.push(S.fieldSlot(row, { participants: participants.map(S.participant) }));
  }
  return { items: slots };
});

/** Marking a session played is what lets its players rate the field. */
router.post('/slots/:slotId/complete', requireAuth, async (req) => {
  await assertOwnsSlot(getDb(), req.user, Number(req.params.slotId));
  const slot = await completeSlot(getDb(), Number(req.params.slotId));
  await recordAudit(req, { action: 'complete', entity: 'field_slot', entityId: slot.id });
  return S.fieldSlot(slot);
});

router.post('/slots/:slotId/cancel', requireAuth, async (req) => {
  await assertOwnsSlot(getDb(), req.user, Number(req.params.slotId));
  const slot = await cancelSlot(getDb(), Number(req.params.slotId));
  await recordAudit(req, { action: 'cancel', entity: 'field_slot', entityId: slot.id });
  return S.fieldSlot(slot);
});

router.delete('/slots/:slotId', requireAuth, async (req) => {
  const slot = await assertOwnsSlot(getDb(), req.user, Number(req.params.slotId));
  const db = getDb();
  if (Number(slot.joined_players) > 0) {
    throw badRequest('slot_has_players', 'Cancel the session instead — players have already joined.');
  }
  await db.delete('field_slots', slot.id);
  return { ok: true };
});

export default router;
