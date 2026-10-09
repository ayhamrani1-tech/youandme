/**
 * Test harness.
 *
 * Each test file gets its own in-memory SQLite database and a live HTTP server,
 * so tests exercise the real routing, middleware and SQL rather than mocks.
 */
// Must be first: sets the environment before `config.js` is evaluated.
import './env.js';

import http from 'node:http';
import { initDb, closeDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/lib/security.js';
import { addDays, addMinutes, dateOnly, nowIso } from '../src/lib/time.js';

export const PASSWORD = 'Passw0rd!';
/** Hashing is deliberately slow, so the fixtures share one hash. */
const PASSWORD_HASH = hashPassword(PASSWORD);

let server = null;
let baseUrl = null;
let db = null;

export async function startTestServer() {
  if (server) return { baseUrl, db };
  db = await initDb();
  await db.migrate();
  const app = createApp();
  server = http.createServer(app.handler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, db };
}

export async function stopTestServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  await closeDb();
  db = null;
}

export function getTestDb() {
  if (!db) throw new Error('Call startTestServer() first');
  return db;
}

/** Minimal fetch wrapper returning `{ status, body }`. */
export async function api(method, path, { token, body, headers } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

export const get = (path, options) => api('GET', path, options);
export const post = (path, body, options) => api('POST', path, { ...options, body });
export const put = (path, body, options) => api('PUT', path, { ...options, body });
export const patch = (path, body, options) => api('PATCH', path, { ...options, body });
export const del = (path, options) => api('DELETE', path, options);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let counter = 0;
const unique = (prefix) => `${prefix}${(counter += 1)}-${Date.now().toString(36)}`;

/** Insert a user directly and return it with a signed-in access token. */
export async function makeUser({
  role = 'client',
  gender = 'male',
  fullName,
  email,
  lat = null,
  lng = null,
  isActive = true,
} = {}) {
  const address = email || `${unique('user')}@test.jo`;
  const row = await db.insert('users', {
    full_name: fullName || `Test ${role}`,
    email: address,
    password_hash: PASSWORD_HASH,
    role,
    gender,
    locale: 'ar',
    lat,
    lng,
    is_active: isActive,
  });
  const login = await post('/api/auth/login', { email: address, password: PASSWORD });
  return {
    ...row,
    id: Number(row.id),
    email: address,
    token: login.body?.accessToken ?? null,
    refreshToken: login.body?.refreshToken ?? null,
    loginStatus: login.status,
  };
}

export async function makeBusiness({
  section = 'barber',
  ownerId,
  nameAr,
  genderPolicy,
  opensAt = '08:00',
  closesAt = '22:00',
  slotMinutes = 30,
  lat = null,
  lng = null,
  isActive = true,
} = {}) {
  const row = await db.insert('businesses', {
    section,
    owner_id: ownerId,
    name_ar: nameAr || unique('business'),
    gender_policy:
      genderPolicy ?? (section === 'barber' ? 'male' : section === 'salon' ? 'female' : 'any'),
    opens_at: opensAt,
    closes_at: closesAt,
    slot_minutes: slotMinutes,
    lat,
    lng,
    is_active: isActive,
  });
  return { ...row, id: Number(row.id) };
}

export async function makeService(businessId, overrides = {}) {
  const row = await db.insert('services', {
    business_id: businessId,
    kind: 'service',
    name_ar: unique('service'),
    price: 10,
    discount_percent: 0,
    duration_min: 30,
    is_active: true,
    ...overrides,
  });
  return { ...row, id: Number(row.id) };
}

export async function makeStaff(businessId, overrides = {}) {
  const row = await db.insert('staff', {
    business_id: businessId,
    name: unique('staff'),
    is_active: true,
    ...overrides,
  });
  return { ...row, id: Number(row.id) };
}

export async function makeChair(businessId, overrides = {}) {
  const row = await db.insert('chairs', {
    business_id: businessId,
    label: unique('chair'),
    position: 1,
    is_active: true,
    ...overrides,
  });
  return { ...row, id: Number(row.id) };
}

export async function makeField(businessId, overrides = {}) {
  const row = await db.insert('fields', {
    business_id: businessId,
    name: unique('field'),
    price_per_person: 5,
    required_players: 14,
    is_active: true,
    ...overrides,
  });
  return { ...row, id: Number(row.id) };
}

export async function makeSlot(fieldId, overrides = {}) {
  const startsAt = overrides.starts_at || addDays(nowIso(), 2);
  const row = await db.insert('field_slots', {
    field_id: fieldId,
    starts_at: startsAt,
    ends_at: addMinutes(startsAt, 90),
    duration_min: 90,
    price_per_person: 5,
    required_players: 14,
    joined_players: 0,
    status: 'open',
    ...overrides,
  });
  return { ...row, id: Number(row.id) };
}

export async function makePointPackage(businessId, overrides = {}) {
  const row = await db.insert('point_packages', {
    business_id: businessId,
    name_ar: unique('package'),
    points: 10,
    bonus_points: 0,
    price: 12,
    is_active: true,
    ...overrides,
  });
  return { ...row, id: Number(row.id) };
}

/** A date a few days out, as YYYY-MM-DD, avoiding "in the past" rejections. */
export const futureDate = (days = 2) => dateOnly(addDays(nowIso(), days));

/** An ISO instant on a future date at a given HH:MM (UTC). */
export const futureAt = (time, days = 2) => `${futureDate(days)}T${time}:00.000Z`;
