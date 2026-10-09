/**
 * Section-specific rules: gender gating, barber chairs and packages, salon nail
 * services, dental treatments, and availability.
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
  makeUser,
  makeBusiness,
  makeService,
  makeStaff,
  makeChair,
  futureAt,
  futureDate,
} from './helpers.js';

before(startTestServer);
after(stopTestServer);

describe('gender-restricted sections', () => {
  test('a female client cannot open or book a men’s barber shop', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const service = await makeService(barber.id, { price: 7 });
    const female = await makeUser({ role: 'client', gender: 'female' });

    const detail = await get(`/api/businesses/${barber.id}`, { token: female.token });
    assert.equal(detail.status, 403);
    assert.equal(detail.body.error.code, 'male_only_section');

    const booking = await post(
      '/api/bookings',
      {
        businessId: barber.id,
        startsAt: futureAt('14:00'),
        items: [{ serviceId: service.id }],
      },
      { token: female.token },
    );
    assert.equal(booking.status, 403);
    assert.equal(booking.body.error.code, 'male_only_section');
  });

  test('a male client cannot open or book a women’s salon', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'female' });
    const salon = await makeBusiness({ section: 'salon', ownerId: owner.id });
    const service = await makeService(salon.id, { price: 12 });
    const male = await makeUser({ role: 'client', gender: 'male' });

    const detail = await get(`/api/businesses/${salon.id}`, { token: male.token });
    assert.equal(detail.status, 403);
    assert.equal(detail.body.error.code, 'female_only_section');

    const booking = await post(
      '/api/bookings',
      { businessId: salon.id, startsAt: futureAt('14:00'), items: [{ serviceId: service.id }] },
      { token: male.token },
    );
    assert.equal(booking.status, 403);
  });

  test('restricted businesses are filtered out of the listing for the wrong gender', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    await makeBusiness({ section: 'barber', ownerId: owner.id, nameAr: 'حلاق الرجال' });
    const female = await makeUser({ role: 'client', gender: 'female' });

    const asFemale = await get('/api/businesses?section=barber', { token: female.token });
    assert.equal(asFemale.status, 200);
    assert.equal(asFemale.body.items.length, 0);

    const male = await makeUser({ role: 'client', gender: 'male' });
    const asMale = await get('/api/businesses?section=barber', { token: male.token });
    assert.ok(asMale.body.items.length > 0);
  });

  test('an admin is exempt from the gender gate', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'female' });
    const salon = await makeBusiness({ section: 'salon', ownerId: owner.id });
    const admin = await makeUser({ role: 'admin', gender: 'male' });
    const res = await get(`/api/businesses/${salon.id}`, { token: admin.token });
    assert.equal(res.status, 200);
  });

  test('creating a barber shop or salon fixes its gender policy automatically', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await post(
      '/api/businesses',
      { section: 'barber', nameAr: 'حلاق تلقائي' },
      { token: owner.token },
    );
    assert.equal(barber.status, 200);
    assert.equal(barber.body.genderPolicy, 'male');

    const salon = await post(
      '/api/businesses',
      { section: 'salon', nameAr: 'صالون تلقائي' },
      { token: owner.token },
    );
    assert.equal(salon.body.genderPolicy, 'female');

    const clinic = await post(
      '/api/businesses',
      { section: 'dental', nameAr: 'عيادة' },
      { token: owner.token },
    );
    assert.equal(clinic.body.genderPolicy, 'any');
  });
});

describe('barber shop', () => {
  test('booking a chair implies the barber sitting at it', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const mazen = await makeStaff(barber.id, { name: 'مازن' });
    const chair = await makeChair(barber.id, { label: 'كرسي 2', staff_id: mazen.id });
    const service = await makeService(barber.id, { price: 7, booking_type: 'regular' });
    const client = await makeUser({ role: 'client', gender: 'male' });

    const res = await post(
      '/api/bookings',
      {
        businessId: barber.id,
        chairId: chair.id,
        startsAt: futureAt('14:00'),
        items: [{ serviceId: service.id }],
      },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.chairId, chair.id);
    assert.equal(res.body.booking.staffId, mazen.id, 'the chair’s barber is assigned');
    assert.equal(res.body.booking.staffName, 'مازن');
    assert.equal(res.body.booking.bookingType, 'regular');
  });

  test('a groom’s package is recorded and priced with its discount', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const groom = await makeService(barber.id, {
      kind: 'package',
      name_ar: 'باقة العريس',
      price: 100,
      discount_percent: 10,
      duration_min: 120,
      booking_type: 'groom',
    });
    const client = await makeUser({ role: 'client', gender: 'male' });

    const res = await post(
      '/api/bookings',
      {
        businessId: barber.id,
        startsAt: futureAt('12:00'),
        items: [{ serviceId: groom.id }],
        bookingType: 'groom',
      },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.bookingType, 'groom');
    assert.equal(res.body.booking.totalAmount, 90, '10% discount applied from the owner’s own price');
  });

  test('the same chair cannot be double-booked for an overlapping time', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const chair = await makeChair(barber.id);
    const service = await makeService(barber.id, { duration_min: 30 });
    const first = await makeUser({ role: 'client', gender: 'male' });
    const second = await makeUser({ role: 'client', gender: 'male' });

    const payload = {
      businessId: barber.id,
      chairId: chair.id,
      startsAt: futureAt('15:00'),
      items: [{ serviceId: service.id }],
    };
    assert.equal((await post('/api/bookings', payload, { token: first.token })).status, 200);
    const clash = await post('/api/bookings', payload, { token: second.token });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'chair_unavailable');
  });

  test('the same barber cannot be double-booked across chairs', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const staff = await makeStaff(barber.id);
    const chairA = await makeChair(barber.id, { label: 'A', staff_id: staff.id });
    const chairB = await makeChair(barber.id, { label: 'B', staff_id: staff.id });
    const service = await makeService(barber.id, { duration_min: 30 });
    const a = await makeUser({ role: 'client', gender: 'male' });
    const b = await makeUser({ role: 'client', gender: 'male' });

    assert.equal(
      (
        await post(
          '/api/bookings',
          { businessId: barber.id, chairId: chairA.id, startsAt: futureAt('16:00'), items: [{ serviceId: service.id }] },
          { token: a.token },
        )
      ).status,
      200,
    );
    const clash = await post(
      '/api/bookings',
      { businessId: barber.id, chairId: chairB.id, startsAt: futureAt('16:00'), items: [{ serviceId: service.id }] },
      { token: b.token },
    );
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'staff_unavailable');
  });

  test('setting a chair count creates numbered chairs', async () => {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const res = await put(
      `/api/businesses/${barber.id}/chairs/count`,
      { count: 4 },
      { token: owner.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 4);
    assert.deepEqual(
      res.body.items.map((c) => c.label),
      ['كرسي 1', 'كرسي 2', 'كرسي 3', 'كرسي 4'],
    );
  });
});

describe('women’s salon', () => {
  async function salonFixture() {
    const owner = await makeUser({ role: 'owner', gender: 'female' });
    const salon = await makeBusiness({ section: 'salon', ownerId: owner.id });
    const hala = await makeStaff(salon.id, { name: 'هالة', gender: 'female' });
    const client = await makeUser({ role: 'client', gender: 'female' });
    const db = getTestDb();
    const red = await db.insert('nail_colors', {
      business_id: salon.id,
      name_ar: 'أحمر',
      hex_code: '#C0172B',
      is_active: true,
    });
    const navy = await db.insert('nail_colors', {
      business_id: salon.id,
      name_ar: 'كحلي',
      hex_code: '#1E2A52',
      is_active: true,
    });
    return { owner, salon, hala, client, red, navy };
  }

  test('a nail booking records hands, feet or both with the exact colours', async () => {
    const { salon, hala, client, red, navy } = await salonFixture();
    const both = await makeService(salon.id, { name_ar: 'مناكير وبديكير', price: 20, nail_scope: 'both', duration_min: 80 });

    const res = await post(
      '/api/bookings',
      {
        businessId: salon.id,
        staffId: hala.id,
        startsAt: futureAt('11:00'),
        items: [{ serviceId: both.id }],
        nailScope: 'both',
        nailColorIds: [
          { nailColorId: Number(red.id), placement: 'hands' },
          { nailColorId: Number(navy.id), placement: 'feet' },
        ],
      },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.nailScope, 'both');
    assert.equal(res.body.colours.length, 2);
    const hands = res.body.colours.find((c) => c.placement === 'hands');
    assert.equal(hands.hex_code, '#C0172B');
  });

  test('choosing hands only rejects a colour assigned to feet', async () => {
    const { salon, client, red } = await salonFixture();
    const hands = await makeService(salon.id, { nail_scope: 'hands', price: 10 });
    const res = await post(
      '/api/bookings',
      {
        businessId: salon.id,
        startsAt: futureAt('13:00'),
        items: [{ serviceId: hands.id }],
        nailScope: 'hands',
        nailColorIds: [{ nailColorId: Number(red.id), placement: 'feet' }],
      },
      { token: client.token },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'placement_mismatch');
  });

  test('a colour from another salon’s palette is rejected', async () => {
    const { salon, client } = await salonFixture();
    const other = await salonFixture();
    const service = await makeService(salon.id, { nail_scope: 'hands' });
    const res = await post(
      '/api/bookings',
      {
        businessId: salon.id,
        startsAt: futureAt('13:30'),
        items: [{ serviceId: service.id }],
        nailScope: 'hands',
        nailColorIds: [{ nailColorId: Number(other.red.id), placement: 'hands' }],
      },
      { token: client.token },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'nail_color_not_found');
  });

  test('clients can see each staff member’s own rating', async () => {
    const { salon, hala } = await salonFixture();
    const db = getTestDb();
    await db.run('UPDATE staff SET rating_avg = ?, rating_count = ? WHERE id = ?', [4.5, 2, hala.id]);
    const res = await get(`/api/businesses/${salon.id}/staff`);
    assert.equal(res.status, 200);
    const found = res.body.items.find((s) => s.id === hala.id);
    assert.equal(found.rating.avg, 4.5);
    assert.equal(found.rating.count, 2);
  });
});

describe('dental clinic', () => {
  async function clinicFixture() {
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const clinic = await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any' });
    const treatments = {};
    for (const [code, price, duration] of [
      ['extraction', 20, 30],
      ['filling', 25, 45],
      ['cleaning', 30, 40],
      ['veneer', 180, 90],
      ['checkup', 10, 20],
    ]) {
      treatments[code] = await makeService(clinic.id, {
        kind: 'treatment',
        name_ar: code,
        treatment_code: code,
        price,
        duration_min: duration,
      });
    }
    const client = await makeUser({ role: 'client' });
    return { owner, clinic, treatments, client };
  }

  test('a procedure must be chosen', async () => {
    const { clinic, treatments, client } = await clinicFixture();
    const res = await post(
      '/api/bookings',
      { businessId: clinic.id, startsAt: futureAt('10:00'), items: [{ serviceId: treatments.filling.id }] },
      { token: client.token },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'treatment_required');
  });

  test('the chosen procedure is priced from the clinic’s own fixed price', async () => {
    const { clinic, client } = await clinicFixture();
    const res = await post(
      '/api/bookings',
      { businessId: clinic.id, startsAt: futureAt('10:00'), treatmentCode: 'veneer' },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.treatmentCode, 'veneer');
    assert.equal(res.body.booking.totalAmount, 180);
    assert.equal(res.body.items.length, 1);
  });

  test('a procedure the clinic does not offer is rejected', async () => {
    const owner = await makeUser({ role: 'owner' });
    const clinic = await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any' });
    await makeService(clinic.id, { kind: 'treatment', treatment_code: 'checkup', price: 10 });
    const client = await makeUser({ role: 'client' });
    const res = await post(
      '/api/bookings',
      { businessId: clinic.id, startsAt: futureAt('10:00'), treatmentCode: 'veneer' },
      { token: client.token },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'treatment_not_offered');
  });

  test('all five procedures from the specification are accepted', async () => {
    const { clinic, client } = await clinicFixture();
    const codes = ['extraction', 'filling', 'cleaning', 'veneer', 'checkup'];
    let hour = 9;
    for (const code of codes) {
      const res = await post(
        '/api/bookings',
        { businessId: clinic.id, startsAt: futureAt(`${String(hour).padStart(2, '0')}:00`), treatmentCode: code },
        { token: client.token },
      );
      assert.equal(res.status, 200, `${code} should be bookable`);
      hour += 2;
    }
  });
});

describe('availability and working hours', () => {
  test('a booking outside working hours is refused', async () => {
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({
      section: 'dental',
      ownerId: owner.id,
      genderPolicy: 'any',
      opensAt: '09:00',
      closesAt: '17:00',
    });
    await makeService(business.id, { kind: 'treatment', treatment_code: 'checkup', price: 10, duration_min: 30 });
    const client = await makeUser({ role: 'client' });
    const res = await post(
      '/api/bookings',
      { businessId: business.id, startsAt: futureAt('20:00'), treatmentCode: 'checkup' },
      { token: client.token },
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'outside_working_hours');
  });

  test('a booking in the past is refused', async () => {
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any' });
    await makeService(business.id, { kind: 'treatment', treatment_code: 'checkup', price: 10 });
    const client = await makeUser({ role: 'client' });
    const res = await post(
      '/api/bookings',
      { businessId: business.id, startsAt: '2020-01-01T10:00:00.000Z', treatmentCode: 'checkup' },
      { token: client.token },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'slot_in_past');
  });

  test('a closed weekday blocks booking and reports as closed', async () => {
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any' });
    await makeService(business.id, { kind: 'treatment', treatment_code: 'checkup', price: 10 });

    // Close the weekday that a date three days out falls on.
    const date = futureDate(3);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const saved = await put(
      `/api/businesses/${business.id}/hours`,
      { hours: [{ weekday, isClosed: true }] },
      { token: owner.token },
    );
    assert.equal(saved.status, 200);

    const availability = await get(`/api/businesses/${business.id}/availability?date=${date}`);
    assert.equal(availability.status, 200);
    assert.equal(availability.body.isClosed, true);
    assert.equal(availability.body.slots.length, 0);

    const client = await makeUser({ role: 'client' });
    const res = await post(
      '/api/bookings',
      { businessId: business.id, startsAt: `${date}T10:00:00.000Z`, treatmentCode: 'checkup' },
      { token: client.token },
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'closed_that_day');
  });

  test('availability marks already-booked times as unavailable', async () => {
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({
      section: 'dental',
      ownerId: owner.id,
      genderPolicy: 'any',
      opensAt: '09:00',
      closesAt: '12:00',
      slotMinutes: 30,
    });
    await makeService(business.id, { kind: 'treatment', treatment_code: 'checkup', price: 10, duration_min: 30 });
    const staff = await makeStaff(business.id);
    const client = await makeUser({ role: 'client' });
    const date = futureDate(4);

    const before = await get(`/api/businesses/${business.id}/availability?date=${date}&staffId=${staff.id}`);
    assert.equal(before.body.slots.length, 6, '09:00 to 12:00 in 30-minute steps');
    assert.ok(before.body.slots.every((s) => s.available));

    await post(
      '/api/bookings',
      {
        businessId: business.id,
        staffId: staff.id,
        startsAt: `${date}T10:00:00.000Z`,
        treatmentCode: 'checkup',
      },
      { token: client.token },
    );
    const after = await get(`/api/businesses/${business.id}/availability?date=${date}&staffId=${staff.id}`);
    const taken = after.body.slots.find((s) => s.time === '10:00');
    assert.equal(taken.available, false);
    assert.equal(taken.reason, 'booked');
    assert.equal(after.body.slots.filter((s) => s.available).length, 5);
  });
});

describe('field descriptions', () => {
  test('a description longer than 200 words is rejected', async () => {
    const owner = await makeUser({ role: 'owner' });
    const venue = await makeBusiness({ section: 'sports_field', ownerId: owner.id, genderPolicy: 'any' });
    const res = await post(
      `/api/fields/business/${venue.id}`,
      {
        name: 'ملعب',
        pricePerPerson: 5,
        description: Array.from({ length: 201 }, (_, i) => `كلمة${i}`).join(' '),
      },
      { token: owner.token },
    );
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d) => d.path === 'description'));
  });

  test('exactly 200 words is accepted', async () => {
    const owner = await makeUser({ role: 'owner' });
    const venue = await makeBusiness({ section: 'sports_field', ownerId: owner.id, genderPolicy: 'any' });
    const res = await post(
      `/api/fields/business/${venue.id}`,
      {
        name: 'ملعب مقبول',
        pricePerPerson: 5,
        description: Array.from({ length: 200 }, (_, i) => `كلمة${i}`).join(' '),
      },
      { token: owner.token },
    );
    assert.equal(res.status, 200);
  });
});
