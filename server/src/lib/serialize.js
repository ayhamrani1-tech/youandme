/**
 * Row → API shape mappers.
 *
 * Every response goes through one of these. That keeps `password_hash` and
 * other internals from ever reaching a client by accident, and normalises the
 * 0/1 integers SQLite returns for boolean columns into real booleans.
 */
import { bool } from '../db/index.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));

export function publicUser(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    fullName: row.full_name,
    email: row.email,
    phone: row.phone ?? null,
    role: row.role,
    gender: row.gender,
    locale: row.locale,
    governorate: row.governorate ?? null,
    city: row.city ?? null,
    address: row.address ?? null,
    lat: num(row.lat),
    lng: num(row.lng),
    isActive: bool(row.is_active),
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
  };
}

export function business(row, extra = {}) {
  if (!row) return null;
  return {
    id: num(row.id),
    section: row.section,
    ownerId: num(row.owner_id),
    name: { ar: row.name_ar, en: row.name_en ?? null },
    description: { ar: row.description_ar ?? null, en: row.description_en ?? null },
    phone: row.phone ?? null,
    governorate: row.governorate ?? null,
    city: row.city ?? null,
    address: row.address ?? null,
    lat: num(row.lat),
    lng: num(row.lng),
    mapUrl: row.map_url ?? null,
    coverUrl: row.cover_url ?? null,
    genderPolicy: row.gender_policy,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    slotMinutes: num(row.slot_minutes),
    isActive: bool(row.is_active),
    rating: { avg: num(row.rating_avg) ?? 0, count: num(row.rating_count) ?? 0 },
    createdAt: row.created_at,
    ...extra,
  };
}

export function businessHour(row) {
  return {
    id: num(row.id),
    weekday: num(row.weekday),
    isClosed: bool(row.is_closed),
    opensAt: row.opens_at ?? null,
    closesAt: row.closes_at ?? null,
  };
}

export function staff(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    name: row.name,
    roleTitle: row.role_title ?? null,
    bio: row.bio ?? null,
    photoUrl: row.photo_url ?? null,
    gender: row.gender ?? null,
    isActive: bool(row.is_active),
    rating: { avg: num(row.rating_avg) ?? 0, count: num(row.rating_count) ?? 0 },
  };
}

export function chair(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    label: row.label,
    position: num(row.position),
    staffId: num(row.staff_id),
    staffName: row.staff_name ?? null,
    isActive: bool(row.is_active),
  };
}

export function service(row) {
  if (!row) return null;
  const price = num(row.price) ?? 0;
  const discount = num(row.discount_percent) ?? 0;
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    kind: row.kind,
    name: { ar: row.name_ar, en: row.name_en ?? null },
    description: row.description ?? null,
    price,
    discountPercent: discount,
    finalPrice: Math.round(price * (1 - discount / 100) * 100) / 100,
    durationMin: num(row.duration_min),
    treatmentCode: row.treatment_code ?? null,
    bookingType: row.booking_type ?? null,
    nailScope: row.nail_scope ?? null,
    stockQty: num(row.stock_qty),
    isActive: bool(row.is_active),
  };
}

export function nailColor(row) {
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    name: { ar: row.name_ar, en: row.name_en ?? null },
    hex: row.hex_code,
    isActive: bool(row.is_active),
  };
}

export function field(row, extra = {}) {
  if (!row) return null;
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    name: row.name,
    surface: row.surface ?? null,
    sizeLabel: row.size_label ?? null,
    pricePerPerson: num(row.price_per_person) ?? 0,
    requiredPlayers: num(row.required_players),
    description: row.description ?? null,
    isActive: bool(row.is_active),
    rating: { avg: num(row.rating_avg) ?? 0, count: num(row.rating_count) ?? 0 },
    ...extra,
  };
}

export function fieldSlot(row, extra = {}) {
  if (!row) return null;
  const required = num(row.required_players) ?? 0;
  const joined = num(row.joined_players) ?? 0;
  return {
    id: num(row.id),
    fieldId: num(row.field_id),
    fieldName: row.field_name ?? undefined,
    businessId: num(row.business_id) ?? undefined,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    durationMin: num(row.duration_min),
    pricePerPerson: num(row.price_per_person) ?? 0,
    requiredPlayers: required,
    joinedPlayers: joined,
    playersNeeded: Math.max(0, required - joined),
    status: row.status,
    confirmedAt: row.confirmed_at ?? null,
    completedAt: row.completed_at ?? null,
    ...extra,
  };
}

export function participant(row) {
  return {
    id: num(row.id),
    slotId: num(row.slot_id),
    userId: num(row.user_id),
    userName: row.user_name ?? null,
    playersCount: num(row.players_count),
    amountDue: num(row.amount_due) ?? 0,
    status: row.status,
    joinedAt: row.joined_at,
  };
}

export function booking(row, extra = {}) {
  if (!row) return null;
  return {
    id: num(row.id),
    reference: row.reference,
    businessId: num(row.business_id),
    businessName: row.business_name ? { ar: row.business_name, en: row.business_name_en ?? null } : undefined,
    clientId: num(row.client_id),
    clientName: row.client_name ?? undefined,
    clientPhone: row.client_phone ?? undefined,
    section: row.section,
    staffId: num(row.staff_id),
    staffName: row.staff_name ?? null,
    chairId: num(row.chair_id),
    chairLabel: row.chair_label ?? null,
    slotId: num(row.slot_id),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    bookingType: row.booking_type ?? null,
    nailScope: row.nail_scope ?? null,
    treatmentCode: row.treatment_code ?? null,
    status: row.status,
    totalAmount: num(row.total_amount) ?? 0,
    paymentMethod: row.payment_method,
    pointsSpent: num(row.points_spent) ?? 0,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    ...extra,
  };
}

export function bookingItem(row) {
  return {
    id: num(row.id),
    serviceId: num(row.service_id),
    label: row.label,
    unitPrice: num(row.unit_price) ?? 0,
    qty: num(row.qty) ?? 1,
    lineTotal: num(row.line_total) ?? 0,
  };
}

export function gymPlan(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    name: { ar: row.name_ar, en: row.name_en ?? null },
    kind: row.kind,
    price: num(row.price) ?? 0,
    durationDays: num(row.duration_days),
    sessionsIncluded: num(row.sessions_included),
    trainerId: num(row.trainer_id),
    trainerName: row.trainer_name ?? null,
    description: row.description ?? null,
    isActive: bool(row.is_active),
  };
}

export function pointPackage(row) {
  if (!row) return null;
  const points = num(row.points) ?? 0;
  const bonus = num(row.bonus_points) ?? 0;
  const price = num(row.price) ?? 0;
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    name: { ar: row.name_ar, en: row.name_en ?? null },
    points,
    bonusPoints: bonus,
    totalPoints: points + bonus,
    price,
    pricePerPoint: points + bonus > 0 ? Math.round((price / (points + bonus)) * 1000) / 1000 : 0,
    isActive: bool(row.is_active),
  };
}

export function pointLot(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    packageId: num(row.package_id),
    pointsPurchased: num(row.points_purchased) ?? 0,
    pointsRolledIn: num(row.points_rolled_in) ?? 0,
    pointsRemaining: num(row.points_remaining) ?? 0,
    pricePaid: num(row.price_paid) ?? 0,
    purchasedAt: row.purchased_at,
    expiresAt: row.expires_at,
    rolledIntoLotId: num(row.rolled_into_lot_id),
    status: row.status,
  };
}

export function pointTransaction(row) {
  return {
    id: num(row.id),
    businessId: num(row.business_id),
    lotId: num(row.lot_id),
    bookingId: num(row.booking_id),
    kind: row.kind,
    points: num(row.points),
    balanceAfter: num(row.balance_after),
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

export function subscription(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    userId: num(row.user_id),
    businessId: num(row.business_id),
    businessName: row.business_name ?? undefined,
    planId: num(row.plan_id),
    planName: row.plan_name ?? undefined,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    amountPaid: num(row.amount_paid) ?? 0,
    sessionsLeft: num(row.sessions_left),
    status: row.status,
    createdAt: row.created_at,
  };
}

export function review(row) {
  if (!row) return null;
  return {
    id: num(row.id),
    userId: num(row.user_id),
    userName: row.user_name ?? null,
    businessId: num(row.business_id),
    businessName: row.business_name ?? undefined,
    bookingId: num(row.booking_id),
    slotId: num(row.slot_id),
    fieldId: num(row.field_id),
    staffId: num(row.staff_id),
    staffName: row.staff_name ?? null,
    rating: num(row.rating),
    staffRating: num(row.staff_rating),
    comment: row.comment ?? null,
    createdAt: row.created_at,
  };
}

export function transaction(row) {
  return {
    id: num(row.id),
    userId: num(row.user_id),
    businessId: num(row.business_id),
    bookingId: num(row.booking_id),
    subscriptionId: num(row.subscription_id),
    lotId: num(row.lot_id),
    slotId: num(row.slot_id),
    kind: row.kind,
    amount: num(row.amount) ?? 0,
    currency: row.currency,
    method: row.method,
    status: row.status,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

export function gymSettings(row) {
  if (!row) return null;
  return {
    businessId: num(row.business_id),
    pointsPerEntry: num(row.points_per_entry) ?? 1,
    expiryMonths: num(row.expiry_months) ?? 6,
    allowsPoints: bool(row.allows_points),
    allowsMonthly: bool(row.allows_monthly),
    intro: { ar: row.intro_ar ?? null, en: row.intro_en ?? null },
  };
}

export function auditEntry(row) {
  return {
    id: num(row.id),
    actorId: num(row.actor_id),
    actorName: row.actor_name ?? null,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    meta: typeof row.meta === 'string' ? safeJson(row.meta) : (row.meta ?? null),
    ip: row.ip ?? null,
    createdAt: row.created_at,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Wrap a page of rows in a consistent envelope. */
export function page(items, { page: current, limit, total }) {
  return {
    items,
    page: current,
    limit,
    total: Number(total) || 0,
    pages: Math.max(1, Math.ceil((Number(total) || 0) / limit)),
  };
}
