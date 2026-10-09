/**
 * Location-based gym discovery, and the admin console's reach.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  getTestDb,
  get,
  post,
  put,
  patch,
  del,
  makeUser,
  makeBusiness,
  makeService,
  PASSWORD,
} from './helpers.js';
import { distanceKm } from '../src/lib/time.js';

before(startTestServer);
after(stopTestServer);

/** Real coordinates, so the distances are checkable against known values. */
const AMMAN = { lat: 31.9539, lng: 35.9106 };
const IRBID = { lat: 32.5556, lng: 35.85 };
const ZARQA = { lat: 32.0728, lng: 36.0876 };
const AQABA = { lat: 29.5321, lng: 35.0063 };

describe('haversine distance', () => {
  test('Amman to Irbid is about 70 km', async () => {
    const d = distanceKm(AMMAN.lat, AMMAN.lng, IRBID.lat, IRBID.lng);
    assert.ok(d > 60 && d < 80, `expected 60–80 km, got ${d}`);
  });

  test('Amman to Aqaba is about 270 km', async () => {
    const d = distanceKm(AMMAN.lat, AMMAN.lng, AQABA.lat, AQABA.lng);
    assert.ok(d > 250 && d < 300, `expected 250–300 km, got ${d}`);
  });

  test('a missing coordinate yields null rather than a wrong number', async () => {
    assert.equal(distanceKm(31.9, null, 32.5, 35.8), null);
    assert.equal(distanceKm(undefined, 35.9, 32.5, 35.8), null);
  });
});

describe('nearby gyms', () => {
  async function gymsFixture() {
    const owner = await makeUser({ role: 'owner' });
    const db = getTestDb();
    const gyms = {};
    for (const [name, place] of [
      ['amman', AMMAN],
      ['irbid', IRBID],
      ['zarqa', ZARQA],
      ['aqaba', AQABA],
    ]) {
      gyms[name] = await makeBusiness({
        section: 'gym',
        ownerId: owner.id,
        genderPolicy: 'any',
        nameAr: `نادي ${name}`,
        ...place,
      });
      await db.insert('gym_settings', {
        business_id: gyms[name].id,
        points_per_entry: 2,
        expiry_months: 6,
        allows_points: true,
        allows_monthly: true,
      });
    }
    return { owner, gyms };
  }

  test('results are ordered nearest first, with distances attached', async () => {
    const { gyms } = await gymsFixture();
    // A client in Irbid: the Irbid gym first, then Amman/Zarqa, Aqaba last.
    const res = await get(`/api/gyms/nearby?lat=${IRBID.lat}&lng=${IRBID.lng}`);
    assert.equal(res.status, 200);
    const names = res.body.items.map((g) => g.name.ar);
    assert.equal(names[0], 'نادي irbid');
    assert.equal(names[names.length - 1], 'نادي aqaba');

    const distances = res.body.items.map((g) => g.distanceKm);
    assert.ok(distances.every((d) => typeof d === 'number'));
    const sorted = [...distances].sort((a, b) => a - b);
    assert.deepEqual(distances, sorted, 'strictly nearest-first');
    assert.ok(distances[0] < 1, 'the gym at the client’s own location is ~0 km away');
  });

  test('a client in Irbid sees how far the Amman gym is', async () => {
    const { gyms } = await gymsFixture();
    const res = await get(`/api/gyms/nearby?lat=${IRBID.lat}&lng=${IRBID.lng}`);
    const amman = res.body.items.find((g) => g.id === gyms.amman.id);
    assert.ok(amman, 'the Amman gym is still listed');
    assert.ok(amman.distanceKm > 60 && amman.distanceKm < 80);
    // And its entry cost comes along, so the list is actionable.
    assert.equal(amman.gymSettings.pointsPerEntry, 2);
  });

  test('a radius filter excludes gyms beyond it', async () => {
    await gymsFixture();
    const res = await get(`/api/gyms/nearby?lat=${AMMAN.lat}&lng=${AMMAN.lng}&radiusKm=50`);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.every((g) => g.distanceKm <= 50));
    assert.ok(!res.body.items.some((g) => g.name.ar === 'نادي aqaba'));
  });

  test('the client’s saved location is used when no coordinates are sent', async () => {
    await gymsFixture();
    const client = await makeUser({ role: 'client', lat: IRBID.lat, lng: IRBID.lng });
    const res = await get('/api/gyms/nearby', { token: client.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].name.ar, 'نادي irbid');
  });

  test('a location is required when none is known', async () => {
    await gymsFixture();
    const res = await get('/api/gyms/nearby');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'location_required');
  });

  test('saving a location updates the profile and affects results', async () => {
    await gymsFixture();
    const client = await makeUser({ role: 'client' });
    const saved = await put('/api/me/location', { lat: AQABA.lat, lng: AQABA.lng }, { token: client.token });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.lat, AQABA.lat);

    const res = await get('/api/gyms/nearby', { token: client.token });
    assert.equal(res.body.items[0].name.ar, 'نادي aqaba');
  });

  test('a gym cannot be listed without a location', async () => {
    const owner = await makeUser({ role: 'owner' });
    const res = await post(
      '/api/businesses',
      { section: 'gym', nameAr: 'نادي بلا موقع' },
      { token: owner.token },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'location_required');
  });

  test('general business search can also sort by distance', async () => {
    await gymsFixture();
    const res = await get(
      `/api/businesses?section=gym&sort=distance&lat=${ZARQA.lat}&lng=${ZARQA.lng}`,
    );
    assert.equal(res.status, 200);
    const distances = res.body.items.map((b) => b.distanceKm);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
    assert.equal(res.body.items[0].name.ar, 'نادي zarqa');
  });
});

describe('discovery filters', () => {
  test('searching by name and filtering by governorate both work', async () => {
    const owner = await makeUser({ role: 'owner' });
    const db = getTestDb();
    const a = await makeBusiness({ section: 'dental', ownerId: owner.id, nameAr: 'عيادة النور', genderPolicy: 'any' });
    const b = await makeBusiness({ section: 'dental', ownerId: owner.id, nameAr: 'عيادة الشفاء', genderPolicy: 'any' });
    await db.run('UPDATE businesses SET governorate = ?, city = ? WHERE id = ?', ['إربد', 'إربد', a.id]);
    await db.run('UPDATE businesses SET governorate = ?, city = ? WHERE id = ?', ['العاصمة', 'عمان', b.id]);

    const byName = await get('/api/businesses?q=النور');
    assert.ok(byName.body.items.some((x) => x.id === a.id));
    assert.ok(!byName.body.items.some((x) => x.id === b.id));

    const byGov = await get('/api/businesses?governorate=' + encodeURIComponent('إربد'));
    assert.ok(byGov.body.items.some((x) => x.id === a.id));
    assert.ok(!byGov.body.items.some((x) => x.id === b.id));

    const locations = await get('/api/businesses/locations?section=dental');
    const names = locations.body.governorates.map((g) => g.name);
    assert.ok(names.includes('إربد'));
    assert.ok(names.includes('العاصمة'));
  });

  test('a disabled business disappears from public listings', async () => {
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any', nameAr: 'عيادة مخفية' });
    assert.ok((await get('/api/businesses?q=مخفية')).body.items.length > 0);

    await patch(`/api/businesses/${business.id}/status`, { isActive: false }, { token: owner.token });
    assert.equal((await get('/api/businesses?q=مخفية')).body.items.length, 0);
    assert.equal((await get(`/api/businesses/${business.id}`)).status, 404);

    // The owner can still see their own listing.
    const asOwner = await get(`/api/businesses/${business.id}`, { token: owner.token });
    assert.equal(asOwner.status, 200);
  });

  test('pagination reports totals and pages', async () => {
    const owner = await makeUser({ role: 'owner' });
    for (let i = 0; i < 7; i += 1) {
      await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any', nameAr: `صفحات ${i}` });
    }
    const res = await get('/api/businesses?q=صفحات&limit=3&page=2');
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 3);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.total, 7);
    assert.equal(res.body.pages, 3);
  });
});

describe('admin console', () => {
  test('the overview totals every section and role', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner' });
    await makeBusiness({ section: 'barber', ownerId: owner.id });
    await makeBusiness({ section: 'salon', ownerId: owner.id });

    const res = await get('/api/admin/overview', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.users.total >= 2);
    assert.ok(res.body.businesses.barber >= 1);
    assert.ok(res.body.businesses.salon >= 1);
    assert.ok(typeof res.body.revenuePaid === 'number');
    assert.ok(typeof res.body.gym.pointsOutstanding === 'number');
    assert.ok(Array.isArray(res.body.recentBookings));
  });

  test('an admin can create, update and delete any user', async () => {
    const admin = await makeUser({ role: 'admin' });
    const created = await post(
      '/api/admin/users',
      {
        fullName: 'مالك جديد',
        email: 'created-by-admin@test.jo',
        password: PASSWORD,
        role: 'owner',
        gender: 'male',
      },
      { token: admin.token },
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.role, 'owner');

    const updated = await put(
      `/api/admin/users/${created.body.id}`,
      { fullName: 'مالك معدّل', isActive: false },
      { token: admin.token },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.fullName, 'مالك معدّل');
    assert.equal(updated.body.isActive, false);

    // Disabling the account must end its sessions.
    const login = await post('/api/auth/login', { email: 'created-by-admin@test.jo', password: PASSWORD });
    assert.equal(login.status, 401);

    const removed = await del(`/api/admin/users/${created.body.id}`, { token: admin.token });
    assert.equal(removed.status, 200);
  });

  test('an admin can reset a password', async () => {
    const admin = await makeUser({ role: 'admin' });
    const user = await makeUser({ role: 'client' });
    const res = await put(
      `/api/admin/users/${user.id}`,
      { password: 'ResetByAdmin1' },
      { token: admin.token },
    );
    assert.equal(res.status, 200);
    assert.equal((await post('/api/auth/login', { email: user.email, password: 'ResetByAdmin1' })).status, 200);
    assert.equal((await post('/api/auth/login', { email: user.email, password: PASSWORD })).status, 401);
  });

  test('the last active admin cannot be demoted or disabled', async () => {
    const db = getTestDb();
    // Work on a clean slate of admins for this assertion.
    await db.run("UPDATE users SET is_active = ? WHERE role = 'admin'", [false]);
    const soleAdmin = await makeUser({ role: 'admin' });
    const demote = await put(`/api/admin/users/${soleAdmin.id}`, { role: 'client' }, { token: soleAdmin.token });
    assert.equal(demote.status, 400);
    assert.equal(demote.body.error.code, 'last_admin');

    const disable = await put(`/api/admin/users/${soleAdmin.id}`, { isActive: false }, { token: soleAdmin.token });
    assert.equal(disable.status, 400);

    // Restore the other admins so later tests are unaffected.
    await db.run("UPDATE users SET is_active = ? WHERE role = 'admin'", [true]);
  });

  test('an admin cannot delete their own account', async () => {
    const admin = await makeUser({ role: 'admin' });
    const res = await del(`/api/admin/users/${admin.id}`, { token: admin.token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'cannot_delete_self');
  });

  test('an owner with businesses cannot be deleted until they are reassigned', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'barber', ownerId: owner.id });

    const blocked = await del(`/api/admin/users/${owner.id}`, { token: admin.token });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'owner_has_businesses');

    const newOwner = await makeUser({ role: 'owner' });
    const reassigned = await patch(
      `/api/admin/businesses/${business.id}/owner`,
      { ownerId: newOwner.id },
      { token: admin.token },
    );
    assert.equal(reassigned.status, 200);
    assert.equal(reassigned.body.ownerId, newOwner.id);

    assert.equal((await del(`/api/admin/users/${owner.id}`, { token: admin.token })).status, 200);
  });

  test('a business cannot be reassigned to a client account', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const client = await makeUser({ role: 'client' });
    const res = await patch(
      `/api/admin/businesses/${business.id}/owner`,
      { ownerId: client.id },
      { token: admin.token },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'not_an_owner');
  });

  test('bulk status changes apply to a whole section', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner' });
    await makeBusiness({ section: 'gym', ownerId: owner.id, genderPolicy: 'any', lat: 31.9, lng: 35.9 });
    await makeBusiness({ section: 'gym', ownerId: owner.id, genderPolicy: 'any', lat: 32.0, lng: 35.8 });

    const res = await post(
      '/api/admin/businesses/bulk-status',
      { isActive: false, section: 'gym' },
      { token: admin.token },
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.updated >= 2);

    const listed = await get('/api/businesses?section=gym');
    assert.equal(listed.body.items.length, 0);

    await post('/api/admin/businesses/bulk-status', { isActive: true, section: 'gym' }, { token: admin.token });
    assert.ok((await get('/api/businesses?section=gym')).body.items.length >= 2);
  });

  test('every privileged action is written to the audit trail', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any' });
    await patch(`/api/admin/businesses/${business.id}/status`, { isActive: false }, { token: admin.token });

    const res = await get('/api/admin/audit', { token: admin.token });
    assert.equal(res.status, 200);
    const entry = res.body.items.find(
      (e) => e.entity === 'business' && String(e.entityId) === String(business.id) && e.action === 'disable',
    );
    assert.ok(entry, 'the disable action was recorded');
    assert.equal(entry.actorId, admin.id);
  });

  test('an admin can list and filter bookings across the platform', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const service = await makeService(barber.id, { duration_min: 30 });
    const client = await makeUser({ role: 'client', gender: 'male' });
    await post(
      '/api/bookings',
      { businessId: barber.id, startsAt: '2027-06-01T10:00:00.000Z', items: [{ serviceId: service.id }] },
      { token: client.token },
    );

    const res = await get('/api/admin/bookings?section=barber', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 1);
    assert.ok(res.body.items.every((b) => b.section === 'barber'));

    const byClient = await get(`/api/admin/bookings?clientId=${client.id}`, { token: admin.token });
    assert.equal(byClient.body.items.length, 1);
  });

  test('an admin can complete a booking on a business’s behalf', async () => {
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const service = await makeService(barber.id, { duration_min: 30 });
    const client = await makeUser({ role: 'client', gender: 'male' });
    const created = await post(
      '/api/bookings',
      { businessId: barber.id, startsAt: '2027-06-02T10:00:00.000Z', items: [{ serviceId: service.id }] },
      { token: client.token },
    );
    const res = await patch(
      `/api/admin/bookings/${created.body.booking.id}/status`,
      { status: 'completed' },
      { token: admin.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'completed');
  });

  test('the transaction ledger is readable with a total', async () => {
    const admin = await makeUser({ role: 'admin' });
    const res = await get('/api/admin/transactions', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.sumAmount === 'number');
    assert.ok(Array.isArray(res.body.items));
  });
});

describe('owner dashboard', () => {
  test('an owner sees figures only for their own businesses', async () => {
    const ownerA = await makeUser({ role: 'owner', gender: 'male' });
    const ownerB = await makeUser({ role: 'owner', gender: 'male' });
    const barberA = await makeBusiness({ section: 'barber', ownerId: ownerA.id, nameAr: 'حلاق أ' });
    await makeBusiness({ section: 'barber', ownerId: ownerB.id, nameAr: 'حلاق ب' });

    const res = await get('/api/me/owner/dashboard', { token: ownerA.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.businesses.length, 1);
    assert.equal(res.body.businesses[0].business.id, barberA.id);
  });

  test('the owner diary is scoped to the owner’s business', async () => {
    const ownerA = await makeUser({ role: 'owner', gender: 'male' });
    const ownerB = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: ownerA.id });
    const service = await makeService(barber.id, { duration_min: 30 });
    const client = await makeUser({ role: 'client', gender: 'male' });
    await post(
      '/api/bookings',
      { businessId: barber.id, startsAt: '2027-07-01T10:00:00.000Z', items: [{ serviceId: service.id }] },
      { token: client.token },
    );

    const mine = await get(`/api/bookings/business/${barber.id}`, { token: ownerA.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.items.length, 1);
    assert.equal(mine.body.items[0].clientName, client.full_name);

    const theirs = await get(`/api/bookings/business/${barber.id}`, { token: ownerB.token });
    assert.equal(theirs.status, 403);
  });
});
