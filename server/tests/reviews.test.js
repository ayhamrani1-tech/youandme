/**
 * The platform-wide review rule: a client may only rate a service *after* it has
 * been completed, once, and only something they took part in.
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
  del,
  makeUser,
  makeBusiness,
  makeService,
  makeStaff,
  makeField,
  makeSlot,
  futureAt,
} from './helpers.js';

before(startTestServer);
after(stopTestServer);

/** A confirmed barber booking, ready to be completed. */
async function bookingFixture() {
  const owner = await makeUser({ role: 'owner', gender: 'male' });
  const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
  const staff = await makeStaff(barber.id, { name: 'محمود' });
  const service = await makeService(barber.id, { price: 7, duration_min: 30 });
  const client = await makeUser({ role: 'client', gender: 'male' });
  const created = await post(
    '/api/bookings',
    {
      businessId: barber.id,
      staffId: staff.id,
      startsAt: futureAt('14:00'),
      items: [{ serviceId: service.id }],
    },
    { token: client.token },
  );
  assert.equal(created.status, 200);
  return { owner, barber, staff, service, client, booking: created.body.booking };
}

describe('reviewing an appointment', () => {
  test('rating before completion is refused', async () => {
    const { client, booking } = await bookingFixture();
    const res = await post('/api/reviews', { bookingId: booking.id, rating: 5 }, { token: client.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'booking_not_completed');
  });

  test('rating is allowed once the business marks it completed', async () => {
    const { owner, client, booking, staff } = await bookingFixture();

    const completed = await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, 'completed');

    const res = await post(
      '/api/reviews',
      { bookingId: booking.id, rating: 5, staffRating: 4, comment: 'حلاقة ممتازة' },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.rating, 5);
    assert.equal(res.body.staffRating, 4);
    assert.equal(res.body.staffId, staff.id);
  });

  test('a client cannot rate twice', async () => {
    const { owner, client, booking } = await bookingFixture();
    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    assert.equal(
      (await post('/api/reviews', { bookingId: booking.id, rating: 4 }, { token: client.token })).status,
      200,
    );
    const second = await post('/api/reviews', { bookingId: booking.id, rating: 1 }, { token: client.token });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'already_reviewed');
  });

  test('a client cannot rate someone else’s booking', async () => {
    const { owner, booking } = await bookingFixture();
    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    const stranger = await makeUser({ role: 'client', gender: 'male' });
    const res = await post('/api/reviews', { bookingId: booking.id, rating: 5 }, { token: stranger.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'not_your_booking');
  });

  test('the rating must be between 1 and 5', async () => {
    const { owner, client, booking } = await bookingFixture();
    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    for (const rating of [0, 6, -1, 2.5]) {
      const res = await post('/api/reviews', { bookingId: booking.id, rating }, { token: client.token });
      assert.equal(res.status, 422, `rating ${rating} must be rejected`);
    }
  });

  test('a cancelled booking can never be rated', async () => {
    const { client, booking } = await bookingFixture();
    const cancelled = await post(`/api/bookings/${booking.id}/cancel`, {}, { token: client.token });
    assert.equal(cancelled.status, 200);
    const res = await post('/api/reviews', { bookingId: booking.id, rating: 5 }, { token: client.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'booking_not_completed');
  });

  test('only the business or an admin may mark a booking completed', async () => {
    const { client, booking } = await bookingFixture();
    const res = await post(`/api/bookings/${booking.id}/complete`, {}, { token: client.token });
    assert.equal(res.status, 403, 'a client cannot complete their own booking to unlock rating');
  });
});

describe('rating aggregates', () => {
  test('business and staff averages update as reviews arrive', async () => {
    const db = getTestDb();
    const owner = await makeUser({ role: 'owner', gender: 'male' });
    const barber = await makeBusiness({ section: 'barber', ownerId: owner.id });
    const staff = await makeStaff(barber.id);
    const service = await makeService(barber.id, { duration_min: 30 });

    const ratings = [5, 4, 3];
    let hour = 9;
    for (const rating of ratings) {
      const client = await makeUser({ role: 'client', gender: 'male' });
      const created = await post(
        '/api/bookings',
        {
          businessId: barber.id,
          staffId: staff.id,
          startsAt: futureAt(`${String(hour).padStart(2, '0')}:00`),
          items: [{ serviceId: service.id }],
        },
        { token: client.token },
      );
      assert.equal(created.status, 200);
      await post(`/api/bookings/${created.body.booking.id}/complete`, {}, { token: owner.token });
      await post(
        '/api/reviews',
        { bookingId: created.body.booking.id, rating, staffRating: rating },
        { token: client.token },
      );
      hour += 1;
    }

    const businessRow = await db.get('SELECT * FROM businesses WHERE id = ?', [barber.id]);
    assert.equal(Number(businessRow.rating_count), 3);
    assert.equal(Number(businessRow.rating_avg), 4, '(5 + 4 + 3) / 3');

    const staffRow = await db.get('SELECT * FROM staff WHERE id = ?', [staff.id]);
    assert.equal(Number(staffRow.rating_count), 3);
    assert.equal(Number(staffRow.rating_avg), 4);

    const listed = await get(`/api/reviews/business/${barber.id}`);
    assert.equal(listed.body.total, 3);
    assert.deepEqual(listed.body.breakdown, { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 });
  });

  test('deleting a review recomputes the average', async () => {
    const db = getTestDb();
    const { owner, client, booking, barber } = await bookingFixture();
    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    const review = await post('/api/reviews', { bookingId: booking.id, rating: 2 }, { token: client.token });
    let row = await db.get('SELECT * FROM businesses WHERE id = ?', [barber.id]);
    assert.equal(Number(row.rating_avg), 2);

    const removed = await del(`/api/reviews/${review.body.id}`, { token: client.token });
    assert.equal(removed.status, 200);
    row = await db.get('SELECT * FROM businesses WHERE id = ?', [barber.id]);
    assert.equal(Number(row.rating_count), 0);
    assert.equal(Number(row.rating_avg), 0);
  });

  test('a client can edit their own review but not another’s', async () => {
    const { owner, client, booking } = await bookingFixture();
    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    const review = await post('/api/reviews', { bookingId: booking.id, rating: 3 }, { token: client.token });

    const edited = await put(`/api/reviews/${review.body.id}`, { rating: 5 }, { token: client.token });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.rating, 5);

    const stranger = await makeUser({ role: 'client', gender: 'male' });
    const denied = await put(`/api/reviews/${review.body.id}`, { rating: 1 }, { token: stranger.token });
    assert.equal(denied.status, 403);
  });

  test('an admin can moderate any review', async () => {
    const { owner, client, booking } = await bookingFixture();
    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    const review = await post('/api/reviews', { bookingId: booking.id, rating: 1, comment: 'سيئ' }, { token: client.token });
    const admin = await makeUser({ role: 'admin' });
    const res = await del(`/api/reviews/${review.body.id}`, { token: admin.token });
    assert.equal(res.status, 200);
  });
});

describe('reviewing a field session', () => {
  async function sessionFixture() {
    const owner = await makeUser({ role: 'owner' });
    const venue = await makeBusiness({ section: 'sports_field', ownerId: owner.id, genderPolicy: 'any' });
    const field = await makeField(venue.id, { required_players: 2 });
    const slot = await makeSlot(field.id, { required_players: 2 });
    const playerA = await makeUser({ role: 'client' });
    const playerB = await makeUser({ role: 'client' });
    await post(`/api/fields/slots/${slot.id}/join`, {}, { token: playerA.token });
    await post(`/api/fields/slots/${slot.id}/join`, {}, { token: playerB.token });
    return { owner, venue, field, slot, playerA, playerB };
  }

  test('rating a session before it is played is refused', async () => {
    const { slot, playerA } = await sessionFixture();
    const res = await post('/api/reviews', { slotId: slot.id, rating: 5 }, { token: playerA.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'session_not_completed');
  });

  test('a participant can rate the field once the session is marked played', async () => {
    const db = getTestDb();
    const { owner, slot, field, playerA } = await sessionFixture();
    const completed = await post(`/api/fields/slots/${slot.id}/complete`, {}, { token: owner.token });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, 'completed');

    const res = await post(
      '/api/reviews',
      { slotId: slot.id, rating: 5, comment: 'أرضية ممتازة' },
      { token: playerA.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.fieldId, field.id);

    const row = await db.get('SELECT * FROM fields WHERE id = ?', [field.id]);
    assert.equal(Number(row.rating_count), 1);
    assert.equal(Number(row.rating_avg), 5);
  });

  test('someone who did not play cannot rate the session', async () => {
    const { owner, slot } = await sessionFixture();
    await post(`/api/fields/slots/${slot.id}/complete`, {}, { token: owner.token });
    const outsider = await makeUser({ role: 'client' });
    const res = await post('/api/reviews', { slotId: slot.id, rating: 5 }, { token: outsider.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'not_a_participant');
  });

  test('each participant may rate once, independently', async () => {
    const { owner, slot, playerA, playerB } = await sessionFixture();
    await post(`/api/fields/slots/${slot.id}/complete`, {}, { token: owner.token });
    assert.equal((await post('/api/reviews', { slotId: slot.id, rating: 5 }, { token: playerA.token })).status, 200);
    assert.equal((await post('/api/reviews', { slotId: slot.id, rating: 3 }, { token: playerB.token })).status, 200);
    const duplicate = await post('/api/reviews', { slotId: slot.id, rating: 1 }, { token: playerA.token });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'already_reviewed');
  });
});

describe('what the client is shown as rateable', () => {
  test('a completed, unrated booking surfaces on the dashboard', async () => {
    const { owner, client, booking } = await bookingFixture();
    let dash = await get('/api/me/dashboard', { token: client.token });
    assert.equal(dash.body.awaitingReview.bookings.length, 0, 'nothing to rate before completion');
    assert.equal(dash.body.upcomingBookings.length, 1);

    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    dash = await get('/api/me/dashboard', { token: client.token });
    assert.equal(dash.body.awaitingReview.bookings.length, 1);
    assert.equal(dash.body.awaitingReview.bookings[0].id, booking.id);

    await post('/api/reviews', { bookingId: booking.id, rating: 5 }, { token: client.token });
    dash = await get('/api/me/dashboard', { token: client.token });
    assert.equal(dash.body.awaitingReview.bookings.length, 0, 'disappears once rated');
  });

  test('the bookings list flags canReview only after completion', async () => {
    const { owner, client, booking } = await bookingFixture();
    let mine = await get('/api/bookings/mine', { token: client.token });
    assert.equal(mine.body.items.find((b) => b.id === booking.id).canReview, false);

    await post(`/api/bookings/${booking.id}/complete`, {}, { token: owner.token });
    mine = await get('/api/bookings/mine', { token: client.token });
    assert.equal(mine.body.items.find((b) => b.id === booking.id).canReview, true);
  });
});
