/** Authentication, token handling and role-based access control. */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  get,
  post,
  put,
  del,
  makeUser,
  makeBusiness,
  PASSWORD,
  getTestDb,
} from './helpers.js';

before(startTestServer);
after(stopTestServer);

describe('registration and login', () => {
  test('registers a client and returns a usable session', async () => {
    const res = await post('/api/auth/register', {
      fullName: 'خالد المصري',
      email: 'auth-client@test.jo',
      password: PASSWORD,
      gender: 'male',
      phone: '0791234567',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.accessToken);
    assert.ok(res.body.refreshToken);
    assert.equal(res.body.user.role, 'client');
    assert.equal(res.body.user.email, 'auth-client@test.jo');
    // The password hash must never be serialised.
    assert.equal(res.body.user.passwordHash, undefined);
    assert.equal(res.body.user.password_hash, undefined);

    const me = await get('/api/auth/me', { token: res.body.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'auth-client@test.jo');
  });

  test('rejects a duplicate email', async () => {
    const payload = {
      fullName: 'Dup',
      email: 'dup@test.jo',
      password: PASSWORD,
      gender: 'female',
    };
    assert.equal((await post('/api/auth/register', payload)).status, 200);
    const second = await post('/api/auth/register', payload);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'email_taken');
  });

  test('requires gender, since it gates the barber and salon sections', async () => {
    const res = await post('/api/auth/register', {
      fullName: 'No Gender',
      email: 'nogender@test.jo',
      password: PASSWORD,
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d) => d.path === 'gender'));
  });

  test('rejects a weak password', async () => {
    const res = await post('/api/auth/register', {
      fullName: 'Weak',
      email: 'weak@test.jo',
      password: 'short',
      gender: 'male',
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d) => d.path === 'password'));
  });

  test('rejects a non-Jordanian phone number', async () => {
    const res = await post('/api/auth/register', {
      fullName: 'Bad Phone',
      email: 'badphone@test.jo',
      password: PASSWORD,
      gender: 'male',
      phone: '0501234567',
    });
    assert.equal(res.status, 422);
  });

  test('never accepts a self-assigned admin role', async () => {
    const res = await post('/api/auth/register', {
      fullName: 'Sneaky',
      email: 'sneaky@test.jo',
      password: PASSWORD,
      gender: 'male',
      role: 'admin',
    });
    assert.equal(res.status, 422);
  });

  test('gives the same error for a wrong password and an unknown email', async () => {
    await post('/api/auth/register', {
      fullName: 'Real',
      email: 'real@test.jo',
      password: PASSWORD,
      gender: 'male',
    });
    const wrongPassword = await post('/api/auth/login', {
      email: 'real@test.jo',
      password: 'Wrong12345',
    });
    const unknownEmail = await post('/api/auth/login', {
      email: 'ghost@test.jo',
      password: PASSWORD,
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.body.error.code, unknownEmail.body.error.code);
  });

  test('refuses a disabled account', async () => {
    const user = await makeUser({ email: 'disabled@test.jo' });
    const db = getTestDb();
    await db.run('UPDATE users SET is_active = ? WHERE id = ?', [false, user.id]);
    const res = await post('/api/auth/login', { email: 'disabled@test.jo', password: PASSWORD });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'account_disabled');
  });
});

describe('tokens', () => {
  test('rejects a tampered token', async () => {
    const user = await makeUser();
    const [head, claims] = user.token.split('.');
    const forged = `${head}.${claims}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const res = await get('/api/auth/me', { token: forged });
    assert.equal(res.status, 401);
  });

  test('rejects a request with no token', async () => {
    const res = await get('/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'missing_token');
  });

  test('rotates the refresh token and retires the old one', async () => {
    const user = await makeUser();
    const first = await post('/api/auth/refresh', { refreshToken: user.refreshToken });
    assert.equal(first.status, 200);
    assert.ok(first.body.accessToken);
    assert.notEqual(first.body.refreshToken, user.refreshToken);

    // Reusing the retired token must fail.
    const replay = await post('/api/auth/refresh', { refreshToken: user.refreshToken });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'refresh_revoked');
  });

  test('logout revokes the refresh token', async () => {
    const user = await makeUser();
    assert.equal((await post('/api/auth/logout', { refreshToken: user.refreshToken })).status, 200);
    const res = await post('/api/auth/refresh', { refreshToken: user.refreshToken });
    assert.equal(res.status, 401);
  });

  test('changing a password invalidates existing sessions', async () => {
    const user = await makeUser();
    const res = await post(
      '/api/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'BrandNew123' },
      { token: user.token },
    );
    assert.equal(res.status, 200);
    assert.equal((await post('/api/auth/refresh', { refreshToken: user.refreshToken })).status, 401);
    assert.equal(
      (await post('/api/auth/login', { email: user.email, password: 'BrandNew123' })).status,
      200,
    );
  });
});

describe('role-based access control', () => {
  test('a client cannot reach the admin console', async () => {
    const client = await makeUser({ role: 'client' });
    const res = await get('/api/admin/overview', { token: client.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'insufficient_role');
  });

  test('an owner cannot reach the admin console', async () => {
    const owner = await makeUser({ role: 'owner' });
    const res = await get('/api/admin/users', { token: owner.token });
    assert.equal(res.status, 403);
  });

  test('an admin can reach the admin console', async () => {
    const admin = await makeUser({ role: 'admin' });
    const res = await get('/api/admin/overview', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.users.total === 'number');
  });

  test('a client cannot create a business', async () => {
    const client = await makeUser({ role: 'client' });
    const res = await post(
      '/api/businesses',
      { section: 'barber', nameAr: 'محاولة' },
      { token: client.token },
    );
    assert.equal(res.status, 403);
  });

  test('an owner cannot manage another owner’s business', async () => {
    const ownerA = await makeUser({ role: 'owner' });
    const ownerB = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'barber', ownerId: ownerA.id });

    const update = await put(
      `/api/businesses/${business.id}`,
      { nameAr: 'اختراق' },
      { token: ownerB.token },
    );
    assert.equal(update.status, 403);
    assert.equal(update.body.error.code, 'not_your_business');

    const remove = await del(`/api/businesses/${business.id}`, { token: ownerB.token });
    assert.equal(remove.status, 403);

    const addStaff = await post(
      `/api/businesses/${business.id}/staff`,
      { name: 'دخيل' },
      { token: ownerB.token },
    );
    assert.equal(addStaff.status, 403);
  });

  test('an admin may manage any business', async () => {
    const owner = await makeUser({ role: 'owner' });
    const admin = await makeUser({ role: 'admin' });
    const business = await makeBusiness({ section: 'dental', ownerId: owner.id });
    const res = await put(
      `/api/businesses/${business.id}`,
      { nameAr: 'عيادة بعد التعديل' },
      { token: admin.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.name.ar, 'عيادة بعد التعديل');
  });

  test('a client cannot read another client’s booking', async () => {
    const owner = await makeUser({ role: 'owner' });
    const business = await makeBusiness({ section: 'dental', ownerId: owner.id, genderPolicy: 'any' });
    const db = getTestDb();
    const clientA = await makeUser({ role: 'client' });
    const clientB = await makeUser({ role: 'client' });
    const booking = await db.insert('bookings', {
      reference: 'YM-ISOLATE',
      business_id: business.id,
      client_id: clientA.id,
      section: 'dental',
      starts_at: '2027-01-01T10:00:00.000Z',
      ends_at: '2027-01-01T10:30:00.000Z',
      status: 'confirmed',
      total_amount: 10,
      payment_method: 'cash',
    });
    const mine = await get(`/api/bookings/${booking.id}`, { token: clientA.token });
    assert.equal(mine.status, 200);
    const theirs = await get(`/api/bookings/${booking.id}`, { token: clientB.token });
    assert.equal(theirs.status, 403);
  });
});
