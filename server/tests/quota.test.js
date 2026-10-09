/**
 * Section 1's defining rule: a match confirms once the quota of participating
 * players is reached (14 by default), and the per-person price is the owner's.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  getTestDb,
  get,
  post,
  del,
  makeUser,
  makeBusiness,
  makeField,
  makeSlot,
} from './helpers.js';

before(startTestServer);
after(stopTestServer);

async function venueFixture({ requiredPlayers = 14, pricePerPerson = 4.5 } = {}) {
  const owner = await makeUser({ role: 'owner' });
  const venue = await makeBusiness({ section: 'sports_field', ownerId: owner.id, genderPolicy: 'any' });
  const field = await makeField(venue.id, {
    required_players: requiredPlayers,
    price_per_person: pricePerPerson,
  });
  const slot = await makeSlot(field.id, {
    required_players: requiredPlayers,
    price_per_person: pricePerPerson,
  });
  return { owner, venue, field, slot };
}

describe('player quota', () => {
  test('the match confirms exactly when the 14th player joins', async () => {
    const { slot } = await venueFixture({ requiredPlayers: 14 });
    let last = null;
    for (let i = 0; i < 14; i += 1) {
      const player = await makeUser({ role: 'client' });
      last = await post(`/api/fields/slots/${slot.id}/join`, {}, { token: player.token });
      assert.equal(last.status, 200, `player ${i + 1} should be able to join`);
      if (i < 13) {
        assert.equal(last.body.confirmed, false, `still open after ${i + 1} players`);
        assert.equal(last.body.slot.status, 'open');
        assert.equal(last.body.playersNeeded, 13 - i);
      }
    }
    assert.equal(last.body.confirmed, true, 'confirmed on the 14th');
    assert.equal(last.body.slot.status, 'confirmed');
    assert.equal(last.body.slot.joinedPlayers, 14);
    assert.equal(last.body.playersNeeded, 0);
    assert.ok(last.body.slot.confirmedAt);
  });

  test('a 15th player is refused once the match is full', async () => {
    const { slot } = await venueFixture({ requiredPlayers: 14 });
    for (let i = 0; i < 14; i += 1) {
      const player = await makeUser({ role: 'client' });
      await post(`/api/fields/slots/${slot.id}/join`, {}, { token: player.token });
    }
    const extra = await makeUser({ role: 'client' });
    const res = await post(`/api/fields/slots/${slot.id}/join`, {}, { token: extra.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'slot_full');
  });

  test('a group booking cannot exceed the remaining places', async () => {
    const { slot } = await venueFixture({ requiredPlayers: 14 });
    const first = await makeUser({ role: 'client' });
    // 12 places taken, 2 left.
    const joined = await post(
      `/api/fields/slots/${slot.id}/join`,
      { playersCount: 12 },
      { token: first.token },
    );
    assert.equal(joined.status, 200);
    assert.equal(joined.body.playersNeeded, 2);

    const greedy = await makeUser({ role: 'client' });
    const tooMany = await post(
      `/api/fields/slots/${slot.id}/join`,
      { playersCount: 5 },
      { token: greedy.token },
    );
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.body.error.code, 'not_enough_places');

    const exact = await post(
      `/api/fields/slots/${slot.id}/join`,
      { playersCount: 2 },
      { token: greedy.token },
    );
    assert.equal(exact.status, 200);
    assert.equal(exact.body.confirmed, true);
  });

  test('the owner’s per-person price decides the amount due', async () => {
    const { slot } = await venueFixture({ pricePerPerson: 6.25 });
    const client = await makeUser({ role: 'client' });
    const res = await post(
      `/api/fields/slots/${slot.id}/join`,
      { playersCount: 3 },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.amountDue, 18.75, '3 × 6.25');

    const db = getTestDb();
    const tx = await db.get(
      "SELECT * FROM transactions WHERE slot_id = ? AND kind = 'field_payment'",
      [slot.id],
    );
    assert.equal(Number(tx.amount), 18.75);
  });

  test('an owner may set a quota other than 14', async () => {
    const { slot } = await venueFixture({ requiredPlayers: 10 });
    let last;
    for (let i = 0; i < 10; i += 1) {
      const player = await makeUser({ role: 'client' });
      last = await post(`/api/fields/slots/${slot.id}/join`, {}, { token: player.token });
    }
    assert.equal(last.body.confirmed, true);
    assert.equal(last.body.slot.requiredPlayers, 10);
  });

  test('joining twice is refused', async () => {
    const { slot } = await venueFixture();
    const client = await makeUser({ role: 'client' });
    assert.equal((await post(`/api/fields/slots/${slot.id}/join`, {}, { token: client.token })).status, 200);
    const again = await post(`/api/fields/slots/${slot.id}/join`, {}, { token: client.token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_joined');
  });

  test('leaving a confirmed match reopens it', async () => {
    const { slot } = await venueFixture({ requiredPlayers: 3 });
    const players = [];
    for (let i = 0; i < 3; i += 1) {
      const player = await makeUser({ role: 'client' });
      players.push(player);
      await post(`/api/fields/slots/${slot.id}/join`, {}, { token: player.token });
    }
    const db = getTestDb();
    let row = await db.get('SELECT * FROM field_slots WHERE id = ?', [slot.id]);
    assert.equal(row.status, 'confirmed');

    const left = await del(`/api/fields/slots/${slot.id}/join`, { token: players[0].token });
    assert.equal(left.status, 200);
    assert.equal(left.body.status, 'open');
    assert.equal(left.body.joinedPlayers, 2);
    assert.equal(left.body.playersNeeded, 1);

    row = await db.get('SELECT * FROM field_slots WHERE id = ?', [slot.id]);
    assert.equal(row.confirmed_at, null, 'the confirmation is cleared');
  });

  test('concurrent joins cannot oversubscribe the quota', async () => {
    const { slot } = await venueFixture({ requiredPlayers: 5 });
    const players = [];
    for (let i = 0; i < 8; i += 1) players.push(await makeUser({ role: 'client' }));

    const results = await Promise.all(
      players.map((p) => post(`/api/fields/slots/${slot.id}/join`, {}, { token: p.token })),
    );
    const accepted = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 409);
    assert.equal(accepted.length, 5, 'exactly the quota is admitted');
    assert.equal(rejected.length, 3);

    const db = getTestDb();
    const row = await db.get('SELECT * FROM field_slots WHERE id = ?', [slot.id]);
    assert.equal(Number(row.joined_players), 5, 'never exceeds the quota');
    assert.equal(row.status, 'confirmed');
    const count = await db.value(
      "SELECT COUNT(*) AS c FROM field_participants WHERE slot_id = ? AND status = 'joined'",
      [slot.id],
    );
    assert.equal(Number(count), 5);
  });

  test('a past or cancelled session cannot be joined', async () => {
    const { field } = await venueFixture();
    const past = await makeSlot(field.id, {
      starts_at: '2020-01-01T10:00:00.000Z',
      ends_at: '2020-01-01T11:30:00.000Z',
    });
    const cancelled = await makeSlot(field.id, {
      starts_at: '2030-01-01T10:00:00.000Z',
      ends_at: '2030-01-01T11:30:00.000Z',
      status: 'cancelled',
    });
    const client = await makeUser({ role: 'client' });
    assert.equal(
      (await post(`/api/fields/slots/${past.id}/join`, {}, { token: client.token })).body.error.code,
      'slot_started',
    );
    assert.equal(
      (await post(`/api/fields/slots/${cancelled.id}/join`, {}, { token: client.token })).body.error.code,
      'slot_cancelled',
    );
  });
});

describe('session management', () => {
  test('a bulk schedule creates one session per time per day', async () => {
    const { owner, venue } = await venueFixture();
    // A pitch of its own, so the fixture's existing session cannot overlap one
    // of the generated times and skew the count.
    const field = await makeField(venue.id, { required_players: 14 });
    const start = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await post(
      `/api/fields/${field.id}/slots/bulk`,
      { startDate: start, days: 5, times: ['18:00', '19:30'], durationMin: 90 },
      { token: owner.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.createdCount, 10, '5 days × 2 times');
    assert.equal(res.body.skipped.length, 0);
  });

  test('a bulk schedule can be limited to chosen weekdays', async () => {
    const { owner, venue } = await venueFixture();
    const field = await makeField(venue.id);
    const start = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await post(
      `/api/fields/${field.id}/slots/bulk`,
      { startDate: start, days: 14, times: ['20:00'], weekdays: [1, 3] },
      { token: owner.token },
    );
    assert.equal(res.status, 200);
    // Fourteen days always contain exactly two Mondays and two Wednesdays.
    assert.equal(res.body.createdCount, 4);
  });

  test('overlapping sessions on the same pitch are refused', async () => {
    const { owner, field } = await venueFixture();
    const startsAt = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 11) + '18:00:00.000Z';
    assert.equal(
      (await post(`/api/fields/${field.id}/slots`, { startsAt, durationMin: 90 }, { token: owner.token })).status,
      200,
    );
    const overlapping = await post(
      `/api/fields/${field.id}/slots`,
      { startsAt: startsAt.replace('18:00', '19:00'), durationMin: 90 },
      { token: owner.token },
    );
    assert.equal(overlapping.status, 409);
    assert.equal(overlapping.body.error.code, 'slot_overlap');
  });

  test('only the owner can publish or complete a session', async () => {
    const { field, slot } = await venueFixture();
    const stranger = await makeUser({ role: 'owner' });
    const startsAt = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 11) + '18:00:00.000Z';
    assert.equal(
      (await post(`/api/fields/${field.id}/slots`, { startsAt }, { token: stranger.token })).status,
      403,
    );
    assert.equal(
      (await post(`/api/fields/slots/${slot.id}/complete`, {}, { token: stranger.token })).status,
      403,
    );
  });

  test('only joinable sessions are listed when asked for', async () => {
    const { field } = await venueFixture({ requiredPlayers: 2 });
    const full = await makeSlot(field.id, {
      required_players: 2,
      starts_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      ends_at: new Date(Date.now() + 7 * 86400000 + 5400000).toISOString(),
    });
    for (let i = 0; i < 2; i += 1) {
      const player = await makeUser({ role: 'client' });
      await post(`/api/fields/slots/${full.id}/join`, {}, { token: player.token });
    }
    const res = await get(`/api/fields/slots?fieldId=${field.id}&onlyJoinable=true`);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.every((s) => s.joinedPlayers < s.requiredPlayers));
    assert.ok(!res.body.items.some((s) => s.id === full.id));
  });
});
