// API checks use an isolated PostgreSQL schema, leaving application data untouched.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp, createPool } from './backend/server.js';
import { readFile } from 'node:fs/promises';

export async function createFixture({ disableRateLimit = true } = {}) {
  const schema = `roomly_test_${randomBytes(8).toString('hex')}`;
  const admin = createPool();
  let pool;
  let server;
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 16, options: `-c search_path=${schema},public` });
    await pool.query(await readFile(new URL('./backend/database.sql', import.meta.url), 'utf8'));
    const current = await pool.query('SELECT current_schema() AS name');
    if (current.rows[0].name !== schema) throw new Error('Test database isolation failed.');
    server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    server.on('request', createApp(pool, { disableRateLimit, origin, production: false }));
    return {
      pool, origin, schema,
      async close() {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    if (server) server.close();
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    throw error;
  }
}

export function indiaDate(daysAhead = 1) {
  return new Date(Date.now() + daysAhead * 86400000 + 330 * 60000).toISOString().slice(0, 10);
}

export function createAgent(origin) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(`${origin}/api${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: response.status, data: await response.json(), headers: response.headers };
    },
  };
}

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let fixture, alice, bob, visitor, rooms, booking;
const date = indiaDate();
const credentials = { name: 'Alice Example', email: 'alice@example.test', password: 'correct horse battery staple' };
const payload = overrides => ({ roomId: rooms[0].id, date, start: '09:00', end: '10:00', guests: 2, purpose: 'Project planning', ...overrides });

before(async () => {
  fixture = await createFixture();
  alice = createAgent(fixture.origin);
  bob = createAgent(fixture.origin);
  visitor = createAgent(fixture.origin);
  assert.equal((await alice.request('/auth/register', { method: 'POST', body: credentials })).status, 201);
  assert.equal((await bob.request('/auth/register', { method: 'POST', body: { ...credentials, email: 'bob@example.test', name: 'Bob Example' } })).status, 201);
  rooms = (await visitor.request(`/rooms?date=${date}&start=09:00&end=10:00`)).data.rooms;
});
after(async () => { if (fixture) await fixture.close(); });

test('health endpoint verifies a real PostgreSQL connection', async () => {
  const response = await visitor.request('/health');
  assert.equal(response.status, 200);
  assert.equal(response.data.database, 'connected');
});
test('all six workspaces are seeded and capacity/type filters work', async () => {
  assert.equal(rooms.length, 6);
  const response = await visitor.request(`/rooms?date=${date}&capacity=6&kind=meeting-room&sort=price-low`);
  assert.equal(response.status, 200);
  assert.equal(response.data.rooms.length, 2);
  assert.ok(response.data.rooms.every(r => r.capacity >= 6 && r.kind === 'meeting-room'));
  assert.ok(response.data.rooms[0].hourly_rate <= response.data.rooms[1].hourly_rate);
});
test('room search rejects malformed dates, times, filters, and injection attempts', async () => {
  for (const query of [`date=2026-02-30`, `date=${date}&start=22:00&end=08:00`, `date=${date}&start=09:15`, `date=${date}&capacity=-1`, `date=${date}&sort=price;DROP TABLE rooms`, `date=${date}&kind=unknown`]) {
    assert.equal((await visitor.request(`/rooms?${query}`)).status, 400, query);
  }
  const response = await visitor.request(`/rooms?date=${date}&q=${encodeURIComponent("' OR 1=1;--")}`);
  assert.equal(response.status, 200);
  assert.equal(response.data.rooms.length, 0);
});
test('booking creation and history require authentication', async () => {
  assert.equal((await visitor.request('/bookings')).status, 401);
  assert.equal((await visitor.request('/bookings', { method: 'POST', body: payload() })).status, 401);
});
test('session identifies the signed-in user and stores only password/token hashes', async () => {
  const response = await alice.request('/auth/me');
  assert.equal(response.data.user.name, credentials.name);
  assert.equal(response.data.user.password_hash, undefined);
  const stored = await fixture.pool.query('SELECT password_hash FROM users WHERE email = $1', [credentials.email]);
  assert.notEqual(stored.rows[0].password_hash, credentials.password);
  assert.match(stored.rows[0].password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const tokens = await fixture.pool.query('SELECT token_hash FROM sessions');
  assert.ok(tokens.rows.every(row => row.token_hash !== alice.cookie.split('=')[1]));
});
test('registration validates passwords and rejects duplicate normalized emails', async () => {
  assert.equal((await visitor.request('/auth/register', { method: 'POST', body: { ...credentials, email: 'ALICE@EXAMPLE.TEST' } })).status, 409);
  assert.equal((await visitor.request('/auth/register', { method: 'POST', body: { ...credentials, email: 'bad-address' } })).status, 400);
  assert.equal((await visitor.request('/auth/register', { method: 'POST', body: { ...credentials, password: 'short' } })).status, 400);
});
test('correct login issues an HttpOnly SameSite session; incorrect login fails', async () => {
  const agent = createAgent(fixture.origin);
  assert.equal((await agent.request('/auth/login', { method: 'POST', body: { ...credentials, password: 'incorrect' } })).status, 401);
  assert.equal((await agent.request('/auth/login', { method: 'POST', body: { email: 'missing@example.test', password: credentials.password } })).status, 401);
  const response = await agent.request('/auth/login', { method: 'POST', body: credentials });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await agent.request('/auth/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await agent.request('/auth/me')).data.user, null);
});
test('creates a reservation and calculates its price on the server', async () => {
  const response = await alice.request('/bookings', { method: 'POST', body: payload({ total_paise: 1 }) });
  assert.equal(response.status, 201);
  booking = response.data.booking;
  assert.equal(booking.total_paise, rooms[0].hourly_rate);
  assert.equal(booking.status, 'confirmed');
  assert.match(booking.reference, /^RM-[A-F0-9]{12}$/);
  assert.equal(booking.starts_at, `${date}T03:30:00.000Z`);
});
test('overlapping reservations return 409 and availability updates', async () => {
  const response = await bob.request('/bookings', { method: 'POST', body: payload({ start: '09:30', end: '10:30' }) });
  assert.equal(response.status, 409);
  assert.match(response.data.error, /just booked/);
  const search = await visitor.request(`/rooms?date=${date}&start=09:00&end=10:00`);
  assert.equal(search.data.rooms.find(r => r.id === rooms[0].id).available, false);
});
test('adjacent bookings, different rooms, and half-hour prices are supported', async () => {
  assert.equal((await bob.request('/bookings', { method: 'POST', body: payload({ start: '10:00', end: '11:00' }) })).status, 201);
  const response = await alice.request('/bookings', { method: 'POST', body: payload({ roomId: rooms[1].id, end: '09:30' }) });
  assert.equal(response.status, 201);
  assert.equal(response.data.booking.total_paise, rooms[1].hourly_rate / 2);
});
test('ownership checks hide other users’ bookings and prevent cancellation', async () => {
  const bobBookings = await bob.request('/bookings');
  assert.ok(!bobBookings.data.bookings.some(b => b.id === booking.id));
  assert.equal((await bob.request(`/bookings/${booking.id}/cancel`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await alice.request('/bookings/not-an-id/cancel', { method: 'POST', body: {} })).status, 400);
});
test('cancellation releases availability, retains history, and cannot be repeated', async () => {
  assert.equal((await alice.request(`/bookings/${booking.id}/cancel`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await alice.request(`/bookings/${booking.id}/cancel`, { method: 'POST', body: {} })).status, 404);
  const search = await visitor.request(`/rooms?date=${date}&start=09:00&end=10:00`);
  assert.equal(search.data.rooms.find(r => r.id === rooms[0].id).available, true);
  const history = await alice.request('/bookings');
  assert.equal(history.data.bookings.find(b => b.id === booking.id).status, 'cancelled');
});
test('12 concurrent requests for the same room/time create exactly one booking', async () => {
  const requests = Array.from({ length: 12 }, () => alice.request('/bookings', { method: 'POST', body: payload({ roomId: rooms[2].id, start: '13:00', end: '14:00' }) }));
  const responses = await Promise.all(requests);
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 11);
  const result = await fixture.pool.query('SELECT count(*)::int AS n FROM bookings WHERE room_id=$1 AND starts_at=$2 AND status=$3', [rooms[2].id, `${date}T13:00:00+05:30`, 'confirmed']);
  assert.equal(result.rows[0].n, 1);
});
test('PostgreSQL itself rejects overlaps even when bypassing the HTTP API', async () => {
  const userId = (await alice.request('/auth/me')).data.user.id;
  await assert.rejects(fixture.pool.query(`INSERT INTO bookings(id,reference,user_id,room_id,starts_at,ends_at,guests,total_paise) VALUES($1,$2,$3,$4,$5,$6,1,10000)`, [randomUUID(), 'TEST-DIRECT', userId, rooms[2].id, `${date}T13:00:00+05:30`, `${date}T14:00:00+05:30`]), { code: '23P01' });
});
test('booking validation rejects past dates, oversize groups, invalid rooms and long sessions', async () => {
  for (const overrides of [{ date: indiaDate(-1) }, { guests: 101 }, { guests: rooms[0].capacity + 1 }, { roomId: -1 }, { start: '08:00', end: '17:00' }, { start: '09:01' }, { date: indiaDate(92) }]) {
    assert.equal((await alice.request('/bookings', { method: 'POST', body: payload(overrides) })).status, 400, JSON.stringify(overrides));
  }
  assert.equal((await alice.request('/bookings', { method: 'POST', body: payload({ roomId: 9999999 }) })).status, 404);
});
test('past reservations cannot be cancelled', async () => {
  const userId = (await alice.request('/auth/me')).data.user.id;
  const id = randomUUID();
  await fixture.pool.query(`INSERT INTO bookings(id,reference,user_id,room_id,starts_at,ends_at,guests,total_paise) VALUES($1,$2,$3,$4,now()-interval '2 hours',now()-interval '1 hour',1,10000)`, [id, 'TEST-PAST', userId, rooms[0].id]);
  assert.equal((await alice.request(`/bookings/${id}/cancel`, { method: 'POST', body: {} })).status, 404);
});
test('cross-origin writes, invalid JSON and unsupported content types are rejected', async () => {
  assert.equal((await alice.request('/auth/logout', { method: 'POST', body: {}, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await alice.request('/auth/logout', { method: 'POST', body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await alice.request('/auth/login', { method: 'POST', body: '{invalid' })).status, 400);
  assert.equal((await alice.request('/auth/login', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
});
test('frontend files are served while source and secrets stay private', async () => {
  const response = await fetch(fixture.origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.match(await response.text(), /A little room for/);
  for (const file of ['style.css', 'script.js']) assert.equal((await fetch(`${fixture.origin}/${file}`)).status, 200);
  for (const file of ['.env', 'backend/server.js', 'backend/database.sql', 'backend/setup.js']) assert.equal((await fetch(`${fixture.origin}/${file}`)).status, 404);
  assert.equal((await visitor.request('/unknown')).status, 404);
});
test('auth rate limiting blocks excessive attempts', async () => {
  const limited = await createFixture({ disableRateLimit: false });
  try {
    const agent = createAgent(limited.origin);
    let response;
    for (let i = 0; i < 31; i++) response = await agent.request('/auth/login', { method: 'POST', body: { email: 'not-valid', password: 'x' } });
    assert.equal(response.status, 429);
    assert.match(response.data.error, /Too many sign-in/);
  } finally { await limited.close(); }
});
