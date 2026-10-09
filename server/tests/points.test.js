/**
 * Section 5's point rules:
 *   • purchased points expire 6 months after purchase
 *   • buying again before that period ends rolls the existing balance into the
 *     new purchase, and the combined balance takes the new expiry date
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  getTestDb,
  get,
  post,
  makeUser,
  makeBusiness,
  makePointPackage,
} from './helpers.js';
import { addMonths, addDays, nowIso } from '../src/lib/time.js';
import { purchasePoints, sweepExpiredLots, balanceOf, walletSummary } from '../src/services/points.js';

before(startTestServer);
after(stopTestServer);

async function gymFixture({ pointsPerEntry = 2, expiryMonths = 6 } = {}) {
  const db = getTestDb();
  const owner = await makeUser({ role: 'owner' });
  const gym = await makeBusiness({
    section: 'gym',
    ownerId: owner.id,
    genderPolicy: 'any',
    lat: 31.9539,
    lng: 35.9106,
  });
  await db.insert('gym_settings', {
    business_id: gym.id,
    points_per_entry: pointsPerEntry,
    expiry_months: expiryMonths,
    allows_points: true,
    allows_monthly: true,
  });
  const pack = await makePointPackage(gym.id, { points: 10, price: 12 });
  const client = await makeUser({ role: 'client' });
  return { owner, gym, pack, client, db };
}

describe('buying points', () => {
  test('a purchase credits the balance and sets a 6-month expiry', async () => {
    const { gym, pack, client } = await gymFixture();
    const res = await post(
      `/api/gyms/${gym.id}/points/purchase`,
      { packageId: pack.id },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.purchasedPoints, 10);
    assert.equal(res.body.rolledOverPoints, 0);
    assert.equal(res.body.balance, 10);

    // Six months from today, to the day.
    const expected = addMonths(nowIso(), 6).slice(0, 10);
    assert.equal(String(res.body.expiresAt).slice(0, 10), expected);
  });

  test('bonus points are credited on top', async () => {
    const { gym, client } = await gymFixture();
    const pack = await makePointPackage(gym.id, { points: 25, bonus_points: 3, price: 28 });
    const res = await post(
      `/api/gyms/${gym.id}/points/purchase`,
      { packageId: pack.id },
      { token: client.token },
    );
    assert.equal(res.body.purchasedPoints, 28, '25 + 3 bonus');
    assert.equal(res.body.balance, 28);
  });

  test('the money ledger records the sale', async () => {
    const { gym, pack, client, db } = await gymFixture();
    await post(`/api/gyms/${gym.id}/points/purchase`, { packageId: pack.id }, { token: client.token });
    const tx = await db.get(
      "SELECT * FROM transactions WHERE user_id = ? AND kind = 'points_purchase'",
      [client.id],
    );
    assert.ok(tx);
    assert.equal(Number(tx.amount), 12);
    assert.equal(tx.status, 'paid');
  });

  test('the point ledger balances line up with the final balance', async () => {
    const { gym, pack, client, db } = await gymFixture();
    await post(`/api/gyms/${gym.id}/points/purchase`, { packageId: pack.id }, { token: client.token });
    const entries = await db.all(
      'SELECT * FROM point_transactions WHERE user_id = ? ORDER BY id',
      [client.id],
    );
    const sum = entries.reduce((total, e) => total + Number(e.points), 0);
    assert.equal(sum, 10);
    assert.equal(Number(entries[entries.length - 1].balance_after), 10);
  });
});

describe('the 6-month expiry rule', () => {
  test('points past their expiry are written off and no longer spendable', async () => {
    const { gym, client, db } = await gymFixture();
    // A lot bought seven months ago: already past its six-month window.
    const purchasedAt = addMonths(nowIso(), -7);
    await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 10,
      points_remaining: 10,
      price_paid: 12,
      purchased_at: purchasedAt,
      expires_at: addMonths(purchasedAt, 6),
      status: 'active',
    });

    const written = await sweepExpiredLots(db, { userId: client.id, businessId: gym.id });
    assert.equal(written, 10, 'all ten points written off');
    assert.equal(await balanceOf(db, client.id, gym.id), 0);

    const lot = await db.get('SELECT * FROM point_lots WHERE user_id = ?', [client.id]);
    assert.equal(lot.status, 'expired');
    assert.equal(Number(lot.points_remaining), 0);

    const ledger = await db.get(
      "SELECT * FROM point_transactions WHERE user_id = ? AND kind = 'expiry'",
      [client.id],
    );
    assert.ok(ledger, 'the write-off is recorded in the ledger');
    assert.equal(Number(ledger.points), -10);
  });

  test('a balance one day short of expiry is still valid', async () => {
    const { gym, client, db } = await gymFixture();
    await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 8,
      points_remaining: 8,
      price_paid: 10,
      purchased_at: addMonths(nowIso(), -6),
      expires_at: addDays(nowIso(), 1),
      status: 'active',
    });
    await sweepExpiredLots(db, { userId: client.id, businessId: gym.id });
    assert.equal(await balanceOf(db, client.id, gym.id), 8);
  });

  test('an expired balance cannot pay for entry', async () => {
    const { gym, client, db } = await gymFixture();
    const purchasedAt = addMonths(nowIso(), -8);
    await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 20,
      points_remaining: 20,
      price_paid: 24,
      purchased_at: purchasedAt,
      expires_at: addMonths(purchasedAt, 6),
      status: 'active',
    });
    const res = await post(`/api/gyms/${gym.id}/entry`, {}, { token: client.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'insufficient_points');
  });

  test('a month-end purchase date clamps rather than overflowing', async () => {
    // 31 August + 6 months has no 31st; it must land on the last day of February.
    const expiry = addMonths('2025-08-31T10:00:00.000Z', 6);
    assert.equal(expiry.slice(0, 10), '2026-02-28');
  });
});

describe('the rollover rule', () => {
  test('buying again before expiry combines the balances and resets the clock', async () => {
    const { gym, pack, client, db } = await gymFixture();

    // An earlier purchase, three months ago, with 6 points left.
    const firstPurchase = addMonths(nowIso(), -3);
    const oldLot = await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 10,
      points_remaining: 6,
      price_paid: 12,
      purchased_at: firstPurchase,
      expires_at: addMonths(firstPurchase, 6),
      status: 'active',
    });
    assert.equal(await balanceOf(db, client.id, gym.id), 6);

    const res = await post(
      `/api/gyms/${gym.id}/points/purchase`,
      { packageId: pack.id },
      { token: client.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.rolledOverPoints, 6, 'the surviving points roll over');
    assert.equal(res.body.purchasedPoints, 10);
    assert.equal(res.body.balance, 16, 'old and new combine');

    // The old lot is closed and points to its successor.
    const closed = await db.get('SELECT * FROM point_lots WHERE id = ?', [oldLot.id]);
    assert.equal(closed.status, 'rolled_over');
    assert.equal(Number(closed.points_remaining), 0);
    assert.equal(Number(closed.rolled_into_lot_id), Number(res.body.lot.id));

    // The whole combined balance now expires six months from this purchase.
    const newLot = await db.get('SELECT * FROM point_lots WHERE id = ?', [res.body.lot.id]);
    assert.equal(Number(newLot.points_rolled_in), 6);
    assert.equal(Number(newLot.points_remaining), 16);
    assert.equal(newLot.expires_at.slice(0, 10), addMonths(nowIso(), 6).slice(0, 10));

    // And the ledger explains where the 16 came from.
    const kinds = (
      await db.all('SELECT kind, points FROM point_transactions WHERE user_id = ? ORDER BY id', [client.id])
    ).map((e) => `${e.kind}:${e.points}`);
    assert.deepEqual(kinds, ['rollover_out:-6', 'rollover_in:6', 'purchase:10']);
    assert.equal(await balanceOf(db, client.id, gym.id), 16);
  });

  test('points already expired are not resurrected by a new purchase', async () => {
    const { gym, pack, client, db } = await gymFixture();
    const stale = addMonths(nowIso(), -9);
    await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 10,
      points_remaining: 10,
      price_paid: 12,
      purchased_at: stale,
      expires_at: addMonths(stale, 6),
      status: 'active',
    });
    const res = await post(
      `/api/gyms/${gym.id}/points/purchase`,
      { packageId: pack.id },
      { token: client.token },
    );
    assert.equal(res.body.rolledOverPoints, 0, 'lapsed points do not roll over');
    assert.equal(res.body.balance, 10, 'only the new purchase counts');
  });

  test('several surviving lots all roll into the new one', async () => {
    const { gym, pack, client, db } = await gymFixture();
    for (const [monthsAgo, remaining] of [
      [-1, 3],
      [-2, 4],
    ]) {
      const at = addMonths(nowIso(), monthsAgo);
      await db.insert('point_lots', {
        user_id: client.id,
        business_id: gym.id,
        points_purchased: 10,
        points_remaining: remaining,
        price_paid: 12,
        purchased_at: at,
        expires_at: addMonths(at, 6),
        status: 'active',
      });
    }
    const res = await post(
      `/api/gyms/${gym.id}/points/purchase`,
      { packageId: pack.id },
      { token: client.token },
    );
    assert.equal(res.body.rolledOverPoints, 7, '3 + 4');
    assert.equal(res.body.balance, 17);
    const rolled = await db.all(
      "SELECT * FROM point_lots WHERE user_id = ? AND status = 'rolled_over'",
      [client.id],
    );
    assert.equal(rolled.length, 2);
  });

  test('points are scoped to one gym and never cross over', async () => {
    const a = await gymFixture();
    const b = await gymFixture();
    const client = a.client;
    await post(`/api/gyms/${a.gym.id}/points/purchase`, { packageId: a.pack.id }, { token: client.token });

    assert.equal(await balanceOf(a.db, client.id, a.gym.id), 10);
    assert.equal(await balanceOf(a.db, client.id, b.gym.id), 0);

    const res = await post(`/api/gyms/${b.gym.id}/entry`, {}, { token: client.token });
    assert.equal(res.status, 409, 'the other gym’s balance is not usable here');
  });
});

describe('spending points on entry', () => {
  test('entry deducts the gym’s own cost per visit', async () => {
    const { gym, pack, client } = await gymFixture({ pointsPerEntry: 3 });
    await post(`/api/gyms/${gym.id}/points/purchase`, { packageId: pack.id }, { token: client.token });
    const res = await post(`/api/gyms/${gym.id}/entry`, {}, { token: client.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.method, 'points');
    assert.equal(res.body.pointsSpent, 3);
    assert.equal(res.body.balance, 7);
    assert.equal(res.body.entriesAvailable, 2, 'floor(7 / 3)');
  });

  test('the soonest-expiring lot is spent first', async () => {
    const { gym, client, db } = await gymFixture({ pointsPerEntry: 4 });
    const soon = await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 3,
      points_remaining: 3,
      price_paid: 4,
      purchased_at: addMonths(nowIso(), -5),
      expires_at: addDays(nowIso(), 10),
      status: 'active',
    });
    const later = await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 10,
      points_remaining: 10,
      price_paid: 12,
      purchased_at: nowIso(),
      expires_at: addMonths(nowIso(), 6),
      status: 'active',
    });
    const res = await post(`/api/gyms/${gym.id}/entry`, {}, { token: client.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 9, '13 − 4');

    const soonRow = await db.get('SELECT * FROM point_lots WHERE id = ?', [soon.id]);
    const laterRow = await db.get('SELECT * FROM point_lots WHERE id = ?', [later.id]);
    assert.equal(Number(soonRow.points_remaining), 0, 'drained first');
    assert.equal(soonRow.status, 'consumed');
    assert.equal(Number(laterRow.points_remaining), 9, 'only the remainder taken from the newer lot');
  });

  test('a visit is refused when the balance cannot cover it', async () => {
    const { gym, client, db } = await gymFixture({ pointsPerEntry: 5 });
    await db.insert('point_lots', {
      user_id: client.id,
      business_id: gym.id,
      points_purchased: 3,
      points_remaining: 3,
      price_paid: 4,
      purchased_at: nowIso(),
      expires_at: addMonths(nowIso(), 6),
      status: 'active',
    });
    const res = await post(`/api/gyms/${gym.id}/entry`, {}, { token: client.token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'insufficient_points');
    assert.equal(await balanceOf(db, client.id, gym.id), 3, 'nothing was deducted');
  });

  test('an active subscription covers entry with no points deducted', async () => {
    const { gym, pack, client, db } = await gymFixture();
    await post(`/api/gyms/${gym.id}/points/purchase`, { packageId: pack.id }, { token: client.token });
    const plan = await db.insert('gym_plans', {
      business_id: gym.id,
      name_ar: 'شهري',
      kind: 'monthly',
      price: 30,
      duration_days: 30,
      is_active: true,
    });
    const subscribed = await post(
      `/api/gyms/${gym.id}/subscribe`,
      { planId: Number(plan.id) },
      { token: client.token },
    );
    assert.equal(subscribed.status, 200);

    const res = await post(`/api/gyms/${gym.id}/entry`, {}, { token: client.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.method, 'subscription');
    assert.equal(res.body.pointsSpent, 0);
    assert.equal(res.body.balance, 10, 'the point balance is untouched');
  });

  test('renewing a subscription early extends rather than overwrites', async () => {
    const { gym, client, db } = await gymFixture();
    const plan = await db.insert('gym_plans', {
      business_id: gym.id,
      name_ar: 'شهري',
      kind: 'monthly',
      price: 30,
      duration_days: 30,
      is_active: true,
    });
    const first = await post(`/api/gyms/${gym.id}/subscribe`, { planId: Number(plan.id) }, { token: client.token });
    const second = await post(`/api/gyms/${gym.id}/subscribe`, { planId: Number(plan.id) }, { token: client.token });
    assert.equal(second.status, 200);
    assert.equal(second.body.extendedFrom, first.body.subscription.endsOn);
    assert.ok(
      new Date(second.body.subscription.startsOn) > new Date(first.body.subscription.endsOn),
      'the renewal begins after the current period ends',
    );
  });
});

describe('wallet reporting', () => {
  test('the wallet reports balance, expiry and entries available', async () => {
    const { gym, pack, client } = await gymFixture({ pointsPerEntry: 2 });
    await post(`/api/gyms/${gym.id}/points/purchase`, { packageId: pack.id }, { token: client.token });
    const res = await get(`/api/gyms/${gym.id}/wallet`, { token: client.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.balance, 10);
    assert.equal(res.body.pointsPerEntry, 2);
    assert.equal(res.body.expiryMonths, 6);
    assert.equal(res.body.entriesAvailable, 5);
    assert.equal(res.body.expiresAt.slice(0, 10), addMonths(nowIso(), 6).slice(0, 10));
    assert.ok(res.body.history.length >= 1);
  });

  test('a client dashboard aggregates wallets across gyms', async () => {
    const a = await gymFixture();
    const b = await gymFixture();
    const client = a.client;
    await post(`/api/gyms/${a.gym.id}/points/purchase`, { packageId: a.pack.id }, { token: client.token });
    await post(`/api/gyms/${b.gym.id}/points/purchase`, { packageId: b.pack.id }, { token: client.token });
    const res = await get('/api/me/dashboard', { token: client.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.gymWallets.length, 2);
    assert.ok(res.body.gymWallets.every((w) => w.balance === 10));
  });

  test('an owner can grant points, and the sweep reports platform-wide write-offs', async () => {
    const { gym, owner, client, db } = await gymFixture();
    const granted = await post(
      `/api/gyms/${gym.id}/members/${client.id}/points`,
      { points: 5, note: 'cash sale' },
      { token: owner.token },
    );
    assert.equal(granted.status, 200);
    assert.equal(granted.body.balance, 5);

    // Age that grant past its expiry and sweep as an admin. The sweep is
    // platform-wide, so assert on this client's balance and on the sweep being
    // idempotent rather than on a total that other fixtures also contribute to.
    await db.run('UPDATE point_lots SET expires_at = ? WHERE user_id = ?', [
      addDays(nowIso(), -1),
      client.id,
    ]);
    const admin = await makeUser({ role: 'admin' });
    const swept = await post('/api/admin/points/sweep', {}, { token: admin.token });
    assert.equal(swept.status, 200);
    assert.ok(swept.body.pointsExpired >= 5, 'at least this client’s five points were written off');
    assert.equal(await balanceOf(db, client.id, gym.id), 0);

    // A second sweep must find nothing: points are never written off twice.
    const again = await post('/api/admin/points/sweep', {}, { token: admin.token });
    assert.equal(again.body.pointsExpired, 0);

    const writeOffs = await db.all(
      "SELECT * FROM point_transactions WHERE user_id = ? AND kind = 'expiry'",
      [client.id],
    );
    assert.equal(writeOffs.length, 1, 'exactly one write-off entry for this client');
    assert.equal(Number(writeOffs[0].points), -5);
  });

  test('the onboarding explainer states both rules before signup', async () => {
    const res = await get('/api/gyms/how-it-works');
    assert.equal(res.status, 200);
    assert.equal(res.body.expiryMonths, 6);
    assert.deepEqual(res.body.options.map((o) => o.key), ['monthly', 'points']);
    const keys = res.body.pointRules.map((r) => r.key);
    assert.ok(keys.includes('expiry'));
    assert.ok(keys.includes('rollover'));
    // Both languages are present for every rule.
    assert.ok(res.body.pointRules.every((r) => r.ar && r.en));
  });
});

describe('purchase through the service layer', () => {
  test('purchasePoints is transactional and idempotent in its ledger', async () => {
    const { gym, pack, client, db } = await gymFixture();
    const first = await purchasePoints({ userId: client.id, businessId: gym.id, packageId: pack.id });
    const second = await purchasePoints({ userId: client.id, businessId: gym.id, packageId: pack.id });
    assert.equal(first.balance, 10);
    assert.equal(second.rolledIn, 10);
    assert.equal(second.balance, 20);

    const summary = await walletSummary(client.id, gym.id);
    assert.equal(summary.balance, 20);
    assert.equal(summary.lots.length, 1, 'rollover consolidates into a single active lot');
  });

  test('an unknown package is rejected and nothing is written', async () => {
    const { gym, client, db } = await gymFixture();
    await assert.rejects(
      () => purchasePoints({ userId: client.id, businessId: gym.id, packageId: 999999 }),
      /does not exist/,
    );
    const lots = await db.all('SELECT * FROM point_lots WHERE user_id = ?', [client.id]);
    assert.equal(lots.length, 0);
  });
});
