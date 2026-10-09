/**
 * Gym point wallet.
 *
 * The specification's two rules drive the whole design:
 *
 *   1. Purchased points expire 6 months after the purchase date.
 *   2. If a client buys again *before* that period ends, the existing points
 *      roll over and combine with the new balance.
 *
 * Both are modelled with point *lots*: one row per purchase, each with its own
 * expiry. A new purchase closes every still-valid lot (`rolled_over`), carries
 * their remaining points into the new lot as `points_rolled_in`, and the whole
 * combined balance then shares the new lot's expiry date. Lots that reach their
 * expiry untouched are swept to `expired` and their points written off.
 *
 * Every movement is appended to `point_transactions` with the running balance,
 * so a client's history is auditable and a balance can always be re-derived.
 *
 * Expiry is applied lazily — swept whenever a balance is read or changed — so
 * the system needs no scheduled job to stay correct.
 */
import { getDb } from '../db/index.js';
import { addMonths, nowIso } from '../lib/time.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { config } from '../config.js';

/** Settings row for a gym, creating the default on first use. */
export async function getGymSettings(db, businessId) {
  let row = await db.get('SELECT * FROM gym_settings WHERE business_id = ?', [businessId]);
  if (!row) {
    row = await db.insert('gym_settings', {
      business_id: businessId,
      points_per_entry: 1,
      expiry_months: config.rules.pointsExpiryMonths,
      allows_points: true,
      allows_monthly: true,
    });
  }
  return row;
}

/**
 * Mark every lot whose expiry has passed as expired and write off its points.
 * Returns the number of points written off.
 */
export async function sweepExpiredLots(db, { userId, businessId } = {}) {
  const now = nowIso();
  const conditions = ["status = 'active'", 'expires_at <= ?', 'points_remaining > 0'];
  const params = [now];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (businessId) {
    conditions.push('business_id = ?');
    params.push(businessId);
  }
  const stale = await db.all(
    `SELECT * FROM point_lots WHERE ${conditions.join(' AND ')} ORDER BY expires_at`,
    params,
  );
  let written = 0;
  for (const lot of stale) {
    const lost = Number(lot.points_remaining);
    await db.run(
      "UPDATE point_lots SET status = 'expired', points_remaining = 0 WHERE id = ?",
      [lot.id],
    );
    const balance = await balanceOf(db, lot.user_id, lot.business_id, { sweep: false });
    await db.insert('point_transactions', {
      user_id: lot.user_id,
      business_id: lot.business_id,
      lot_id: lot.id,
      kind: 'expiry',
      points: -lost,
      balance_after: balance,
      note: `Lot expired on ${String(lot.expires_at).slice(0, 10)}`,
    });
    written += lost;
  }
  // Fully spent lots are closed off so they stop appearing as active.
  await db.run(
    `UPDATE point_lots SET status = 'consumed'
      WHERE status = 'active' AND points_remaining = 0 AND expires_at > ?`,
    [now],
  );
  return written;
}

/** Current usable balance for one client at one gym. */
export async function balanceOf(db, userId, businessId, { sweep = true } = {}) {
  if (sweep) await sweepExpiredLots(db, { userId, businessId });
  const row = await db.get(
    `SELECT COALESCE(SUM(points_remaining), 0) AS balance
       FROM point_lots
      WHERE user_id = ? AND business_id = ? AND status = 'active' AND expires_at > ?`,
    [userId, businessId, nowIso()],
  );
  return Number(row?.balance ?? 0);
}

/** Active lots, soonest expiry first — the order points are consumed in. */
export async function activeLots(db, userId, businessId) {
  return db.all(
    `SELECT * FROM point_lots
      WHERE user_id = ? AND business_id = ? AND status = 'active'
        AND points_remaining > 0 AND expires_at > ?
      ORDER BY expires_at ASC, id ASC`,
    [userId, businessId, nowIso()],
  );
}

/**
 * Buy a point package.
 *
 * Runs in a transaction: sweep expiries, roll any surviving lots into the new
 * one, then record the purchase in both the point ledger and the money ledger.
 */
export async function purchasePoints({ userId, businessId, packageId, method = 'card' }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const pkg = await tx.get(
      'SELECT * FROM point_packages WHERE id = ? AND business_id = ?',
      [packageId, businessId],
    );
    if (!pkg) throw notFound('package_not_found', 'That point package does not exist.');
    if (!pkg.is_active && pkg.is_active !== 1) {
      throw badRequest('package_inactive', 'That point package is no longer on sale.');
    }

    const settings = await getGymSettings(tx, businessId);
    if (!settings.allows_points && settings.allows_points !== 1) {
      throw badRequest('points_disabled', 'This gym does not sell points.');
    }

    await sweepExpiredLots(tx, { userId, businessId });

    // Rule 2: points still inside their window roll over into the new purchase.
    const surviving = await activeLots(tx, userId, businessId);
    const rolledIn = surviving.reduce((sum, lot) => sum + Number(lot.points_remaining), 0);

    const purchased = Number(pkg.points) + Number(pkg.bonus_points || 0);
    const purchasedAt = nowIso();
    // Rule 1: the expiry clock restarts from this purchase for the whole balance.
    const expiresAt = addMonths(purchasedAt, Number(settings.expiry_months));

    const lot = await tx.insert('point_lots', {
      user_id: userId,
      business_id: businessId,
      package_id: pkg.id,
      points_purchased: purchased,
      points_rolled_in: rolledIn,
      points_remaining: purchased + rolledIn,
      price_paid: Number(pkg.price),
      purchased_at: purchasedAt,
      expires_at: expiresAt,
      status: 'active',
    });

    for (const old of surviving) {
      await tx.run(
        `UPDATE point_lots
            SET status = 'rolled_over', points_remaining = 0, rolled_into_lot_id = ?
          WHERE id = ?`,
        [lot.id, old.id],
      );
      await tx.insert('point_transactions', {
        user_id: userId,
        business_id: businessId,
        lot_id: old.id,
        kind: 'rollover_out',
        points: -Number(old.points_remaining),
        balance_after: 0,
        note: `Rolled into lot #${lot.id}`,
      });
    }

    let running = 0;
    if (rolledIn > 0) {
      running += rolledIn;
      await tx.insert('point_transactions', {
        user_id: userId,
        business_id: businessId,
        lot_id: lot.id,
        kind: 'rollover_in',
        points: rolledIn,
        balance_after: running,
        note: `Carried over from ${surviving.length} earlier purchase(s)`,
      });
    }
    running += Number(pkg.points);
    await tx.insert('point_transactions', {
      user_id: userId,
      business_id: businessId,
      lot_id: lot.id,
      kind: 'purchase',
      points: Number(pkg.points),
      balance_after: running,
      note: pkg.name_ar,
    });
    if (Number(pkg.bonus_points || 0) > 0) {
      running += Number(pkg.bonus_points);
      await tx.insert('point_transactions', {
        user_id: userId,
        business_id: businessId,
        lot_id: lot.id,
        kind: 'bonus',
        points: Number(pkg.bonus_points),
        balance_after: running,
        note: 'Bonus points',
      });
    }

    await tx.insert('transactions', {
      user_id: userId,
      business_id: businessId,
      lot_id: lot.id,
      kind: 'points_purchase',
      amount: Number(pkg.price),
      currency: config.rules.currency,
      method,
      status: 'paid',
      note: `${purchased} points`,
    });

    return {
      lot,
      rolledIn,
      purchased,
      balance: running,
      expiresAt,
    };
  });
}

/**
 * Spend points, consuming the soonest-expiring lots first.
 * Returns the new balance. Throws if the client cannot cover the cost.
 */
export async function spendPoints(
  tx,
  { userId, businessId, points, kind = 'entry', bookingId = null, note = null },
) {
  if (!Number.isInteger(points) || points <= 0) {
    throw badRequest('invalid_points', 'Points to spend must be a positive whole number.');
  }
  await sweepExpiredLots(tx, { userId, businessId });
  const lots = await activeLots(tx, userId, businessId);
  const available = lots.reduce((sum, lot) => sum + Number(lot.points_remaining), 0);
  if (available < points) {
    throw conflict(
      'insufficient_points',
      `This gym entry costs ${points} points but only ${available} are available.`,
    );
  }

  let outstanding = points;
  let balance = available;
  for (const lot of lots) {
    if (outstanding <= 0) break;
    const take = Math.min(outstanding, Number(lot.points_remaining));
    const remaining = Number(lot.points_remaining) - take;
    // Status is computed here rather than in SQL so the statement stays free of
    // untyped parameter comparisons that Postgres cannot infer.
    await tx.run('UPDATE point_lots SET points_remaining = ?, status = ? WHERE id = ?', [
      remaining,
      remaining === 0 ? 'consumed' : 'active',
      lot.id,
    ]);
    outstanding -= take;
    balance -= take;
    await tx.insert('point_transactions', {
      user_id: userId,
      business_id: businessId,
      lot_id: lot.id,
      booking_id: bookingId,
      kind,
      points: -take,
      balance_after: balance,
      note,
    });
  }
  return balance;
}

/** Admin adjustment — grant or remove points without a sale. */
export async function adjustPoints({ userId, businessId, points, note }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    if (points === 0) throw badRequest('invalid_points', 'Adjustment cannot be zero.');
    if (points < 0) {
      const balance = await spendPoints(tx, {
        userId,
        businessId,
        points: Math.abs(points),
        kind: 'adjustment',
        note,
      });
      return { balance };
    }
    const settings = await getGymSettings(tx, businessId);
    const purchasedAt = nowIso();
    const lot = await tx.insert('point_lots', {
      user_id: userId,
      business_id: businessId,
      points_purchased: points,
      points_remaining: points,
      price_paid: 0,
      purchased_at: purchasedAt,
      expires_at: addMonths(purchasedAt, Number(settings.expiry_months)),
      status: 'active',
    });
    const balance = await balanceOf(tx, userId, businessId, { sweep: false });
    await tx.insert('point_transactions', {
      user_id: userId,
      business_id: businessId,
      lot_id: lot.id,
      kind: 'adjustment',
      points,
      balance_after: balance,
      note,
    });
    return { balance, lot };
  });
}

/** Wallet summary for one gym: balance, when it expires, and the ledger. */
export async function walletSummary(userId, businessId) {
  const db = getDb();
  await sweepExpiredLots(db, { userId, businessId });
  const balance = await balanceOf(db, userId, businessId, { sweep: false });
  const lots = await activeLots(db, userId, businessId);
  const settings = await getGymSettings(db, businessId);
  const history = await db.all(
    `SELECT * FROM point_transactions
      WHERE user_id = ? AND business_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100`,
    [userId, businessId],
  );
  const subscription = await db.get(
    `SELECT s.*, p.name_ar AS plan_name FROM subscriptions s
       LEFT JOIN gym_plans p ON p.id = s.plan_id
      WHERE s.user_id = ? AND s.business_id = ? AND s.status = 'active' AND s.ends_on >= ?
      ORDER BY s.ends_on DESC LIMIT 1`,
    [userId, businessId, nowIso().slice(0, 10)],
  );
  return {
    balance,
    pointsPerEntry: Number(settings.points_per_entry),
    expiryMonths: Number(settings.expiry_months),
    /** Soonest expiry across active lots — when the balance lapses if unused. */
    expiresAt: lots.length ? lots[0].expires_at : null,
    entriesAvailable: Math.floor(balance / Math.max(1, Number(settings.points_per_entry))),
    lots,
    history,
    subscription,
  };
}
