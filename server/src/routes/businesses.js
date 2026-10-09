/**
 * Businesses: public discovery for clients and full management for owners.
 *
 * Discovery is deliberately open (an unauthenticated visitor can browse), but
 * the gender-restricted sections are filtered: a signed-in client only ever
 * sees barber shops or salons their own gender is allowed to book, and the
 * detail route refuses outright. Management routes all sit behind
 * `requireOwnership`, which also lets an admin through.
 */
import { Router } from '../lib/router.js';
import { getDb, bool } from '../db/index.js';
import { requireAuth, optionalAuth, requireRole, requireOwnership, assertGenderAllowed } from '../middleware/auth.js';
import {
  parse,
  pagination,
  z,
  SECTIONS,
  GENDERS,
  TREATMENTS,
  NAIL_SCOPES,
  BOOKING_TYPES,
  timeOfDay,
  jordanPhone,
  limitedDescription,
  hexColor,
  money,
  latitude,
  longitude,
} from '../lib/validate.js';
import * as S from '../lib/serialize.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { distanceKm, nowIso } from '../lib/time.js';
import { availabilityForDay } from '../services/availability.js';
import { ratingBreakdown } from '../services/ratings.js';
import { getGymSettings } from '../services/points.js';
import { recordAudit } from '../services/audit.js';

const router = new Router();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Sections a given viewer is allowed to see businesses from. */
function genderFilterSql(user) {
  if (!user || user.role === 'admin') return { sql: '', params: [] };
  // A client only sees businesses whose policy is 'any' or matches their gender.
  return { sql: ' AND (b.gender_policy = ? OR b.gender_policy = ?)', params: ['any', user.gender] };
}

const businessWriteSchema = z.object({
  nameAr: z.string().trim().min(2).max(120),
  nameEn: z.string().trim().max(120).optional(),
  descriptionAr: limitedDescription.optional(),
  descriptionEn: limitedDescription.optional(),
  phone: jordanPhone.optional(),
  governorate: z.string().trim().max(60).optional(),
  city: z.string().trim().max(60).optional(),
  address: z.string().trim().max(200).optional(),
  lat: latitude.optional(),
  lng: longitude.optional(),
  mapUrl: z.string().trim().url().max(500).optional(),
  coverUrl: z.string().trim().url().max(500).optional(),
  opensAt: timeOfDay.optional(),
  closesAt: timeOfDay.optional(),
  slotMinutes: z.coerce.number().int().min(5).max(240).optional(),
});

function businessColumns(input, section) {
  const columns = {
    name_ar: input.nameAr,
    name_en: input.nameEn ?? null,
    description_ar: input.descriptionAr ?? null,
    description_en: input.descriptionEn ?? null,
    phone: input.phone ?? null,
    governorate: input.governorate ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    map_url: input.mapUrl ?? null,
    cover_url: input.coverUrl ?? null,
    opens_at: input.opensAt ?? '09:00',
    closes_at: input.closesAt ?? '21:00',
    slot_minutes: input.slotMinutes ?? 30,
  };
  if (section) {
    columns.section = section;
    // The specification fixes these two: barber shops are male-only, salons female-only.
    columns.gender_policy = section === 'barber' ? 'male' : section === 'salon' ? 'female' : 'any';
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

/**
 * GET /api/businesses
 * ?section=gym&governorate=Amman&q=lion&lat=&lng=&radiusKm=&sort=distance|rating|name
 *
 * When lat/lng are supplied (or taken from the signed-in user's saved
 * location) every result carries its distance, which is what powers "gyms near
 * me" — someone in Irbid can see how far an Amman gym is.
 */
router.get('/', optionalAuth, async (req) => {
  const query = parse(
    z.object({
      section: z.enum(SECTIONS).optional(),
      governorate: z.string().trim().max(60).optional(),
      city: z.string().trim().max(60).optional(),
      q: z.string().trim().max(120).optional(),
      lat: latitude.optional(),
      lng: longitude.optional(),
      radiusKm: z.coerce.number().min(0.1).max(500).optional(),
      sort: z.enum(['distance', 'rating', 'name', 'newest']).default('rating'),
      includeInactive: z.coerce.boolean().default(false),
    }),
    req.query,
  );
  const { page, limit, offset } = pagination(req.query);
  const db = getDb();

  const conditions = ['1 = 1'];
  const params = [];
  if (!(query.includeInactive && req.user?.role === 'admin')) {
    conditions.push('b.is_active = ?');
    params.push(true);
  }
  if (query.section) {
    conditions.push('b.section = ?');
    params.push(query.section);
  }
  if (query.governorate) {
    conditions.push('b.governorate = ?');
    params.push(query.governorate);
  }
  if (query.city) {
    conditions.push('b.city = ?');
    params.push(query.city);
  }
  if (query.q) {
    conditions.push('(b.name_ar LIKE ? OR b.name_en LIKE ? OR b.city LIKE ? OR b.address LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const genderFilter = genderFilterSql(req.user);
  const where = `WHERE ${conditions.join(' AND ')}${genderFilter.sql}`;
  const allParams = [...params, ...genderFilter.params];

  const total = await db.value(`SELECT COUNT(*) AS c FROM businesses b ${where}`, allParams);

  const originLat = query.lat ?? req.user?.lat ?? null;
  const originLng = query.lng ?? req.user?.lng ?? null;
  const geoRequested = originLat !== null && originLng !== null;

  // Distance is computed in JS (haversine) so the query stays portable across
  // SQLite and Postgres rather than depending on PostGIS.
  const needsFullScan = geoRequested && (query.sort === 'distance' || query.radiusKm);
  const orderBy =
    query.sort === 'name'
      ? 'b.name_ar ASC'
      : query.sort === 'newest'
        ? 'b.created_at DESC, b.id DESC'
        : 'b.rating_avg DESC, b.rating_count DESC, b.id DESC';

  const rows = await db.all(
    `SELECT b.*, u.full_name AS owner_name
       FROM businesses b JOIN users u ON u.id = b.owner_id
       ${where}
      ORDER BY ${orderBy}
      ${needsFullScan ? '' : 'LIMIT ? OFFSET ?'}`,
    needsFullScan ? allParams : [...allParams, limit, offset],
  );

  let items = rows.map((row) => {
    const distance = geoRequested ? distanceKm(originLat, originLng, row.lat, row.lng) : null;
    return S.business(row, {
      ownerName: row.owner_name,
      distanceKm: distance,
    });
  });

  if (needsFullScan) {
    if (query.radiusKm) {
      items = items.filter((b) => b.distanceKm !== null && b.distanceKm <= query.radiusKm);
    }
    if (query.sort === 'distance') {
      items.sort((a, b) => {
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
      });
    }
    const sliced = items.slice(offset, offset + limit);
    return S.page(sliced, { page, limit, total: items.length });
  }

  return S.page(items, { page, limit, total });
});

/**
 * Section summary for the landing page.
 *
 * Alongside the number of listed businesses, each section reports the figure a
 * visitor actually cares about in that section — open match sessions, bookable
 * chairs, available specialists, clinics, gyms — rather than one count labelled
 * five different ways.
 */
router.get('/sections/summary', async () => {
  const db = getDb();
  const now = nowIso();
  const rows = await db.all(
    'SELECT section, COUNT(*) AS count FROM businesses WHERE is_active = ? GROUP BY section',
    [true],
  );

  const [openSessions, chairs, salonStaff, gymCount] = await Promise.all([
    db.value(
      `SELECT COUNT(*) AS c FROM field_slots s
         JOIN fields f ON f.id = s.field_id
         JOIN businesses b ON b.id = f.business_id
        WHERE b.is_active = ? AND s.status = 'open' AND s.starts_at > ?`,
      [true, now],
    ),
    db.value(
      `SELECT COUNT(*) AS c FROM chairs c
         JOIN businesses b ON b.id = c.business_id
        WHERE b.section = 'barber' AND b.is_active = ? AND c.is_active = ?`,
      [true, true],
    ),
    db.value(
      `SELECT COUNT(*) AS c FROM staff s
         JOIN businesses b ON b.id = s.business_id
        WHERE b.section = 'salon' AND b.is_active = ? AND s.is_active = ?`,
      [true, true],
    ),
    db.value("SELECT COUNT(*) AS c FROM businesses WHERE section = 'gym' AND is_active = ?", [true]),
  ]);

  const highlights = {
    sports_field: { metric: 'open_sessions', value: Number(openSessions ?? 0) },
    barber: { metric: 'chairs', value: Number(chairs ?? 0) },
    salon: { metric: 'specialists', value: Number(salonStaff ?? 0) },
    dental: { metric: 'clinics', value: 0 },
    gym: { metric: 'gyms', value: Number(gymCount ?? 0) },
  };

  const summary = {};
  for (const section of SECTIONS) {
    const businesses = Number(rows.find((r) => r.section === section)?.count ?? 0);
    if (section === 'dental') highlights.dental.value = businesses;
    summary[section] = {
      businesses,
      metric: highlights[section].metric,
      value: highlights[section].value,
    };
  }
  return summary;
});

/** Distinct governorates/cities that actually have listings — for filter menus. */
router.get('/locations', async (req) => {
  const db = getDb();
  const query = parse(z.object({ section: z.enum(SECTIONS).optional() }), req.query);
  const rows = await db.all(
    `SELECT governorate, city, COUNT(*) AS count
       FROM businesses
      WHERE is_active = ? AND governorate IS NOT NULL
        ${query.section ? 'AND section = ?' : ''}
      GROUP BY governorate, city
      ORDER BY governorate, city`,
    query.section ? [true, query.section] : [true],
  );
  const governorates = {};
  for (const row of rows) {
    governorates[row.governorate] ??= { name: row.governorate, count: 0, cities: [] };
    governorates[row.governorate].count += Number(row.count);
    if (row.city) governorates[row.governorate].cities.push({ name: row.city, count: Number(row.count) });
  }
  return { governorates: Object.values(governorates) };
});

/** Full public profile of one business, with everything a booking page needs. */
router.get('/:businessId', optionalAuth, async (req) => {
  const db = getDb();
  const id = Number(req.params.businessId);
  const row = await db.get(
    `SELECT b.*, u.full_name AS owner_name FROM businesses b
       JOIN users u ON u.id = b.owner_id WHERE b.id = ?`,
    [id],
  );
  if (!row) throw notFound('business_not_found');
  if (!bool(row.is_active) && req.user?.role !== 'admin' && Number(row.owner_id) !== req.user?.id) {
    throw notFound('business_not_found');
  }
  // Refuse the detail page outright for a gender-restricted section.
  if (req.user) assertGenderAllowed(req.user, row);
  else if (row.gender_policy !== 'any') {
    throw forbidden('sign_in_required', 'Sign in to view this section.');
  }

  const [services, staff, chairs, hours, nailColors, reviews] = await Promise.all([
    db.all('SELECT * FROM services WHERE business_id = ? AND is_active = ? ORDER BY kind, id', [id, true]),
    db.all('SELECT * FROM staff WHERE business_id = ? AND is_active = ? ORDER BY id', [id, true]),
    db.all(
      `SELECT c.*, s.name AS staff_name FROM chairs c
         LEFT JOIN staff s ON s.id = c.staff_id
        WHERE c.business_id = ? AND c.is_active = ? ORDER BY c.position, c.id`,
      [id, true],
    ),
    db.all('SELECT * FROM business_hours WHERE business_id = ? ORDER BY weekday', [id]),
    db.all('SELECT * FROM nail_colors WHERE business_id = ? AND is_active = ? ORDER BY id', [id, true]),
    db.all(
      `SELECT r.*, u.full_name AS user_name, s.name AS staff_name FROM reviews r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN staff s ON s.id = r.staff_id
        WHERE r.business_id = ? ORDER BY r.created_at DESC LIMIT 20`,
      [id],
    ),
  ]);

  const extra = {
    ownerName: row.owner_name,
    services: services.map(S.service),
    staff: staff.map(S.staff),
    chairs: chairs.map(S.chair),
    hours: hours.map(S.businessHour),
    reviews: reviews.map(S.review),
    ratingBreakdown: await ratingBreakdown(id),
  };

  if (row.section === 'salon') extra.nailColors = nailColors.map(S.nailColor);
  if (row.section === 'dental') {
    extra.treatments = services
      .filter((s) => s.treatment_code)
      .map((s) => ({ ...S.service(s), treatmentCode: s.treatment_code }));
  }
  if (row.section === 'sports_field') {
    const fields = await db.all('SELECT * FROM fields WHERE business_id = ? AND is_active = ?', [id, true]);
    extra.fields = fields.map((f) => S.field(f));
  }
  if (row.section === 'gym') {
    const [plans, packages, settings] = await Promise.all([
      db.all(
        `SELECT p.*, s.name AS trainer_name FROM gym_plans p
           LEFT JOIN staff s ON s.id = p.trainer_id
          WHERE p.business_id = ? AND p.is_active = ? ORDER BY p.kind, p.price`,
        [id, true],
      ),
      db.all('SELECT * FROM point_packages WHERE business_id = ? AND is_active = ? ORDER BY points', [id, true]),
      getGymSettings(db, id),
    ]);
    extra.plans = plans.map(S.gymPlan);
    extra.pointPackages = packages.map(S.pointPackage);
    extra.gymSettings = S.gymSettings(settings);
  }
  if (req.user) {
    const distance = distanceKm(req.user.lat, req.user.lng, row.lat, row.lng);
    if (distance !== null) extra.distanceKm = distance;
  }

  return S.business(row, extra);
});

/** Bookable times for a date; narrow with ?staffId= or ?chairId=. */
router.get('/:businessId/availability', optionalAuth, async (req) => {
  const db = getDb();
  const id = Number(req.params.businessId);
  const business = await db.get('SELECT * FROM businesses WHERE id = ?', [id]);
  if (!business) throw notFound('business_not_found');
  if (req.user) assertGenderAllowed(req.user, business);

  const query = parse(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      staffId: z.coerce.number().int().positive().optional(),
      chairId: z.coerce.number().int().positive().optional(),
      durationMin: z.coerce.number().int().min(5).max(480).optional(),
      serviceId: z.coerce.number().int().positive().optional(),
    }),
    req.query,
  );

  let durationMinutes = query.durationMin;
  if (!durationMinutes && query.serviceId) {
    const service = await db.get('SELECT duration_min FROM services WHERE id = ? AND business_id = ?', [
      query.serviceId,
      id,
    ]);
    durationMinutes = service ? Number(service.duration_min) : undefined;
  }

  return availabilityForDay(db, {
    businessId: id,
    date: query.date,
    durationMinutes,
    staffId: query.staffId,
    chairId: query.chairId,
  });
});

// ---------------------------------------------------------------------------
// Owner management
// ---------------------------------------------------------------------------

/** Create a business. Owners create their own; admins may assign an owner. */
router.post('/', requireAuth, requireRole('owner'), async (req) => {
  const input = parse(
    businessWriteSchema.extend({
      section: z.enum(SECTIONS),
      ownerId: z.coerce.number().int().positive().optional(),
    }),
    req.body,
  );
  const db = getDb();
  let ownerId = req.user.id;
  if (input.ownerId && input.ownerId !== req.user.id) {
    if (req.user.role !== 'admin') {
      throw forbidden('cannot_assign_owner', 'Only an admin can create a business for someone else.');
    }
    const owner = await db.get('SELECT id, role FROM users WHERE id = ?', [input.ownerId]);
    if (!owner) throw badRequest('owner_not_found');
    ownerId = Number(owner.id);
  }
  // Gyms are discovered by distance, so a location is required up front.
  if (input.section === 'gym' && (input.lat === undefined || input.lng === undefined)) {
    throw badRequest('location_required', 'A gym must have its geographic location set.');
  }

  const business = await db.insert('businesses', {
    ...businessColumns(input, input.section),
    owner_id: ownerId,
    is_active: true,
  });
  if (input.section === 'gym') await getGymSettings(db, business.id);
  await recordAudit(req, { action: 'create', entity: 'business', entityId: business.id });
  return S.business(business);
});

/** Field name → database column, used for partial updates. */
const BUSINESS_FIELD_MAP = {
  nameAr: 'name_ar',
  nameEn: 'name_en',
  descriptionAr: 'description_ar',
  descriptionEn: 'description_en',
  phone: 'phone',
  governorate: 'governorate',
  city: 'city',
  address: 'address',
  lat: 'lat',
  lng: 'lng',
  mapUrl: 'map_url',
  coverUrl: 'cover_url',
  opensAt: 'opens_at',
  closesAt: 'closes_at',
  slotMinutes: 'slot_minutes',
};

router.put('/:businessId', requireAuth, requireOwnership(), async (req) => {
  const input = parse(businessWriteSchema.partial(), req.body);
  const db = getDb();
  // Only the fields actually sent are written.
  const columns = { updated_at: nowIso() };
  for (const [field, column] of Object.entries(BUSINESS_FIELD_MAP)) {
    if (input[field] !== undefined) columns[column] = input[field];
  }
  const updated = await db.update('businesses', req.business.id, columns);
  await recordAudit(req, { action: 'update', entity: 'business', entityId: req.business.id });
  return S.business(updated);
});

/** Enable or disable a listing. */
router.patch('/:businessId/status', requireAuth, requireOwnership(), async (req) => {
  const input = parse(z.object({ isActive: z.boolean() }), req.body);
  const db = getDb();
  const updated = await db.update('businesses', req.business.id, {
    is_active: input.isActive,
    updated_at: nowIso(),
  });
  await recordAudit(req, {
    action: input.isActive ? 'enable' : 'disable',
    entity: 'business',
    entityId: req.business.id,
  });
  return S.business(updated);
});

router.delete('/:businessId', requireAuth, requireOwnership(), async (req) => {
  const db = getDb();
  await db.delete('businesses', req.business.id);
  await recordAudit(req, { action: 'delete', entity: 'business', entityId: req.business.id });
  return { ok: true };
});

// -- working hours ----------------------------------------------------------
router.put('/:businessId/hours', requireAuth, requireOwnership(), async (req) => {
  const input = parse(
    z.object({
      hours: z
        .array(
          z.object({
            weekday: z.coerce.number().int().min(0).max(6),
            isClosed: z.boolean().default(false),
            opensAt: timeOfDay.optional(),
            closesAt: timeOfDay.optional(),
          }),
        )
        .max(7),
    }),
    req.body,
  );
  const db = getDb();
  await db.run('DELETE FROM business_hours WHERE business_id = ?', [req.business.id]);
  for (const entry of input.hours) {
    if (!entry.isClosed && entry.opensAt && entry.closesAt && entry.opensAt >= entry.closesAt) {
      throw badRequest('invalid_hours', 'Closing time must be after opening time.');
    }
    await db.insert('business_hours', {
      business_id: req.business.id,
      weekday: entry.weekday,
      is_closed: entry.isClosed,
      opens_at: entry.opensAt ?? null,
      closes_at: entry.closesAt ?? null,
    });
  }
  const hours = await db.all('SELECT * FROM business_hours WHERE business_id = ? ORDER BY weekday', [
    req.business.id,
  ]);
  return { hours: hours.map(S.businessHour) };
});

// -- staff ------------------------------------------------------------------
const staffSchema = z.object({
  name: z.string().trim().min(2).max(120),
  roleTitle: z.string().trim().max(80).optional(),
  bio: z.string().trim().max(600).optional(),
  photoUrl: z.string().trim().url().max(500).optional(),
  gender: z.enum(GENDERS).optional(),
  isActive: z.boolean().default(true),
});

router.get('/:businessId/staff', async (req) => {
  const db = getDb();
  const rows = await db.all('SELECT * FROM staff WHERE business_id = ? ORDER BY id', [
    Number(req.params.businessId),
  ]);
  return { items: rows.map(S.staff) };
});

router.post('/:businessId/staff', requireAuth, requireOwnership(), async (req) => {
  const input = parse(staffSchema, req.body);
  const db = getDb();
  const row = await db.insert('staff', {
    business_id: req.business.id,
    name: input.name,
    role_title: input.roleTitle ?? null,
    bio: input.bio ?? null,
    photo_url: input.photoUrl ?? null,
    gender: input.gender ?? null,
    is_active: input.isActive,
  });
  return S.staff(row);
});

router.put('/:businessId/staff/:staffId', requireAuth, requireOwnership(), async (req) => {
  const input = parse(staffSchema.partial(), req.body);
  const db = getDb();
  const existing = await db.get('SELECT * FROM staff WHERE id = ? AND business_id = ?', [
    Number(req.params.staffId),
    req.business.id,
  ]);
  if (!existing) throw notFound('staff_not_found');
  const row = await db.update('staff', existing.id, {
    name: input.name,
    role_title: input.roleTitle,
    bio: input.bio,
    photo_url: input.photoUrl,
    gender: input.gender,
    is_active: input.isActive,
  });
  return S.staff(row);
});

router.delete('/:businessId/staff/:staffId', requireAuth, requireOwnership(), async (req) => {
  const db = getDb();
  const existing = await db.get('SELECT id FROM staff WHERE id = ? AND business_id = ?', [
    Number(req.params.staffId),
    req.business.id,
  ]);
  if (!existing) throw notFound('staff_not_found');
  await db.delete('staff', existing.id);
  return { ok: true };
});

// -- chairs / stations ------------------------------------------------------
const chairSchema = z.object({
  label: z.string().trim().min(1).max(60),
  position: z.coerce.number().int().min(1).max(100).default(1),
  staffId: z.coerce.number().int().positive().nullable().optional(),
  isActive: z.boolean().default(true),
});

router.get('/:businessId/chairs', async (req) => {
  const db = getDb();
  const rows = await db.all(
    `SELECT c.*, s.name AS staff_name FROM chairs c
       LEFT JOIN staff s ON s.id = c.staff_id
      WHERE c.business_id = ? ORDER BY c.position, c.id`,
    [Number(req.params.businessId)],
  );
  return { items: rows.map(S.chair) };
});

/** Bulk-set the number of chairs, which is how owners usually configure a shop. */
router.put('/:businessId/chairs/count', requireAuth, requireOwnership(), async (req) => {
  const input = parse(
    z.object({ count: z.coerce.number().int().min(0).max(60), labelPrefix: z.string().trim().max(30).optional() }),
    req.body,
  );
  const db = getDb();
  const existing = await db.all('SELECT * FROM chairs WHERE business_id = ? ORDER BY position, id', [
    req.business.id,
  ]);
  const prefix = input.labelPrefix || (req.business.section === 'salon' ? 'كرسي' : 'كرسي');
  if (input.count > existing.length) {
    for (let i = existing.length + 1; i <= input.count; i += 1) {
      await db.insert('chairs', {
        business_id: req.business.id,
        label: `${prefix} ${i}`,
        position: i,
        is_active: true,
      });
    }
  } else if (input.count < existing.length) {
    // Remove from the end, but never one that still has upcoming bookings.
    for (const chair of existing.slice(input.count).reverse()) {
      const booked = await db.get(
        "SELECT id FROM bookings WHERE chair_id = ? AND status IN ('pending','confirmed') AND starts_at > ?",
        [chair.id, nowIso()],
      );
      if (booked) {
        throw badRequest('chair_has_bookings', `"${chair.label}" still has upcoming bookings.`);
      }
      await db.delete('chairs', chair.id);
    }
  }
  const rows = await db.all(
    `SELECT c.*, s.name AS staff_name FROM chairs c
       LEFT JOIN staff s ON s.id = c.staff_id
      WHERE c.business_id = ? ORDER BY c.position, c.id`,
    [req.business.id],
  );
  return { items: rows.map(S.chair) };
});

router.post('/:businessId/chairs', requireAuth, requireOwnership(), async (req) => {
  const input = parse(chairSchema, req.body);
  const db = getDb();
  const row = await db.insert('chairs', {
    business_id: req.business.id,
    label: input.label,
    position: input.position,
    staff_id: input.staffId ?? null,
    is_active: input.isActive,
  });
  return S.chair(row);
});

router.put('/:businessId/chairs/:chairId', requireAuth, requireOwnership(), async (req) => {
  const input = parse(chairSchema.partial(), req.body);
  const db = getDb();
  const existing = await db.get('SELECT * FROM chairs WHERE id = ? AND business_id = ?', [
    Number(req.params.chairId),
    req.business.id,
  ]);
  if (!existing) throw notFound('chair_not_found');
  const row = await db.update('chairs', existing.id, {
    label: input.label,
    position: input.position,
    staff_id: input.staffId,
    is_active: input.isActive,
  });
  return S.chair(row);
});

router.delete('/:businessId/chairs/:chairId', requireAuth, requireOwnership(), async (req) => {
  const db = getDb();
  await db.run('DELETE FROM chairs WHERE id = ? AND business_id = ?', [
    Number(req.params.chairId),
    req.business.id,
  ]);
  return { ok: true };
});

// -- services / products / treatments --------------------------------------
const serviceSchema = z.object({
  kind: z.enum(['service', 'product', 'treatment', 'package', 'training']).default('service'),
  nameAr: z.string().trim().min(1).max(140),
  nameEn: z.string().trim().max(140).optional(),
  description: z.string().trim().max(1000).optional(),
  price: money,
  discountPercent: z.coerce.number().int().min(0).max(100).default(0),
  durationMin: z.coerce.number().int().min(5).max(480).default(30),
  treatmentCode: z.enum(TREATMENTS).optional(),
  bookingType: z.enum(BOOKING_TYPES).optional(),
  nailScope: z.enum(NAIL_SCOPES).optional(),
  stockQty: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().default(true),
});

router.get('/:businessId/services', async (req) => {
  const db = getDb();
  const query = parse(z.object({ kind: z.string().optional() }), req.query);
  const rows = await db.all(
    `SELECT * FROM services WHERE business_id = ? ${query.kind ? 'AND kind = ?' : ''} ORDER BY kind, id`,
    query.kind ? [Number(req.params.businessId), query.kind] : [Number(req.params.businessId)],
  );
  return { items: rows.map(S.service) };
});

router.post('/:businessId/services', requireAuth, requireOwnership(), async (req) => {
  const input = parse(serviceSchema, req.body);
  const db = getDb();
  if (req.business.section === 'dental' && input.kind === 'treatment' && !input.treatmentCode) {
    throw badRequest('treatment_code_required', 'Choose which procedure this price is for.');
  }
  const row = await db.insert('services', {
    business_id: req.business.id,
    kind: input.kind,
    name_ar: input.nameAr,
    name_en: input.nameEn ?? null,
    description: input.description ?? null,
    price: input.price,
    discount_percent: input.discountPercent,
    duration_min: input.durationMin,
    treatment_code: input.treatmentCode ?? null,
    booking_type: input.bookingType ?? null,
    nail_scope: input.nailScope ?? null,
    stock_qty: input.stockQty ?? null,
    is_active: input.isActive,
  });
  return S.service(row);
});

router.put('/:businessId/services/:serviceId', requireAuth, requireOwnership(), async (req) => {
  const input = parse(serviceSchema.partial(), req.body);
  const db = getDb();
  const existing = await db.get('SELECT * FROM services WHERE id = ? AND business_id = ?', [
    Number(req.params.serviceId),
    req.business.id,
  ]);
  if (!existing) throw notFound('service_not_found');
  const row = await db.update('services', existing.id, {
    kind: input.kind,
    name_ar: input.nameAr,
    name_en: input.nameEn,
    description: input.description,
    price: input.price,
    discount_percent: input.discountPercent,
    duration_min: input.durationMin,
    treatment_code: input.treatmentCode,
    booking_type: input.bookingType,
    nail_scope: input.nailScope,
    stock_qty: input.stockQty,
    is_active: input.isActive,
    updated_at: nowIso(),
  });
  return S.service(row);
});

router.delete('/:businessId/services/:serviceId', requireAuth, requireOwnership(), async (req) => {
  const db = getDb();
  await db.run('DELETE FROM services WHERE id = ? AND business_id = ?', [
    Number(req.params.serviceId),
    req.business.id,
  ]);
  return { ok: true };
});

// -- nail polish palette (salon) -------------------------------------------
router.get('/:businessId/nail-colors', async (req) => {
  const db = getDb();
  const rows = await db.all('SELECT * FROM nail_colors WHERE business_id = ? ORDER BY id', [
    Number(req.params.businessId),
  ]);
  return { items: rows.map(S.nailColor) };
});

router.post('/:businessId/nail-colors', requireAuth, requireOwnership('businessId', { section: 'salon' }), async (req) => {
  const input = parse(
    z.object({
      nameAr: z.string().trim().min(1).max(60),
      nameEn: z.string().trim().max(60).optional(),
      hex: hexColor,
      isActive: z.boolean().default(true),
    }),
    req.body,
  );
  const db = getDb();
  const row = await db.insert('nail_colors', {
    business_id: req.business.id,
    name_ar: input.nameAr,
    name_en: input.nameEn ?? null,
    hex_code: input.hex.toUpperCase(),
    is_active: input.isActive,
  });
  return S.nailColor(row);
});

router.delete(
  '/:businessId/nail-colors/:colorId',
  requireAuth,
  requireOwnership('businessId', { section: 'salon' }),
  async (req) => {
    const db = getDb();
    await db.run('DELETE FROM nail_colors WHERE id = ? AND business_id = ?', [
      Number(req.params.colorId),
      req.business.id,
    ]);
    return { ok: true };
  },
);

export default router;
