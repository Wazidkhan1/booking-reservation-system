// All backend code lives here. Read sections 1 through 7 in order.
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 1. Database connection and small validation helpers.
export function createPool() {
  if (!process.env.DATABASE_URL) throw new Error('Run npm run setup first. DATABASE_URL is missing.');
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 16, connectionTimeoutMillis: 5000 });
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function text(value, name, min = 1, max = 120) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${name} must be ${min}-${max} characters.`);
  return value.trim();
}
function integer(value, name, max = 100) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(number) || number < 1 || number > max) fail(400, `${name} must be a whole number between 1 and ${max}.`);
  return number;
}
function emailAddress(value) {
  const email = text(value, 'Email', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  return email;
}
function passwordValue(value, minimum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > 128) fail(400, `Password must be ${minimum}-128 characters.`);
  return value;
}
function bookingWindow(date, start, end, future = false) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'Choose a valid date.');
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) fail(400, 'Choose a valid date.');
  const validTime = time => typeof time === 'string' && /^(?:(?:0[89]|1\d|2[01]):(?:00|30)|22:00)$/.test(time);
  if (!validTime(start) || !validTime(end)) fail(400, 'Use half-hour intervals between 08:00 and 22:00 IST.');
  const startsAt = new Date(`${date}T${start}:00+05:30`);
  const endsAt = new Date(`${date}T${end}:00+05:30`);
  const hours = (endsAt - startsAt) / 3600000;
  if (hours < 0.5 || hours > 8) fail(400, 'Choose a duration between 30 minutes and 8 hours.');
  if (future && startsAt <= new Date()) fail(400, 'Choose a start time in the future.');
  if (startsAt.getTime() > Date.now() + 90 * 86400000) fail(400, 'Bookings open up to 90 days ahead.');
  return { startsAt, endsAt, hours };
}

// 2. Passwords are salted and hashed. Login cookies contain a random session token.
const deriveKey = promisify(scrypt);
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' };
async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await deriveKey(password, salt, 64)).toString('hex')}`;
}
async function checkPassword(password, hash) {
  const [salt, key] = hash.split(':');
  const actual = await deriveKey(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
function getToken(req) {
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('roomly_session='));
  const token = cookie?.split('=')[1];
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
async function signIn(pool, req, res, user) {
  const previous = getToken(req);
  if (previous) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(previous)]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  const token = randomBytes(32).toString('hex');
  const week = 7 * 86400000;
  await pool.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), user.id, new Date(Date.now() + week)]);
  res.cookie('roomly_session', token, { ...cookieOptions, maxAge: week });
}
function requireLogin(req, _res, next) {
  if (!req.user) fail(401, 'Please sign in first.');
  next();
}

export function createApp(pool, options = {}) {
  const app = express();
  const origin = options.origin || process.env.APP_ORIGIN || 'http://localhost:3000';
  const production = process.env.NODE_ENV === 'production';

  // 3. Shared request checks run before the routes below.
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { 'script-src': ["'self'"], 'style-src': ["'self'"], 'upgrade-insecure-requests': production ? [] : null } } }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (!options.disableRateLimit) {
    app.use('/api', rateLimit({ windowMs: 60000, limit: 200, legacyHeaders: false, standardHeaders: 'draft-8', message: { error: 'Too many requests. Try again in a minute.' } }));
    app.use(['/api/auth/login', '/api/auth/register'], rateLimit({ windowMs: 15 * 60000, limit: 30, legacyHeaders: false, standardHeaders: 'draft-8', message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } }));
  }
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const allowed = [origin];
      if (!production) allowed.push(origin.replace('localhost', '127.0.0.1'));
      if ((req.headers.origin && !allowed.includes(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Use this website to submit requests.');
      if (!req.is('application/json')) fail(415, 'Requests must use application/json.');
    }
    next();
  });
  app.use(express.json({ limit: '12kb' }));
  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  });
  app.use('/api', async (req, _res, next) => {
    const token = getToken(req);
    req.user = null;
    if (token) {
      const result = await pool.query('SELECT u.id, u.name, u.email FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now()', [tokenHash(token)]);
      req.user = result.rows[0] || null;
    }
    next();
  });

  // 4. Register, log in, see the current user, and log out.
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/register', async (req, res) => {
    const name = text(req.body?.name, 'Name', 2, 80);
    const email = emailAddress(req.body?.email);
    const hash = await hashPassword(passwordValue(req.body?.password, 10));
    const result = await pool.query('INSERT INTO users(name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email', [name, email, hash]);
    await signIn(pool, req, res, result.rows[0]);
    res.status(201).json({ user: result.rows[0] });
  });
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  app.post('/api/auth/login', async (req, res) => {
    const email = emailAddress(req.body?.email);
    const password = passwordValue(req.body?.password, 1);
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    const matches = await checkPassword(password, user?.password_hash || await dummyHash);
    if (!user || !matches) fail(401, 'The email or password is incorrect.');
    await signIn(pool, req, res, user);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  });
  app.post('/api/auth/logout', async (req, res) => {
    const token = getToken(req);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
    res.clearCookie('roomly_session', cookieOptions);
    res.json({ ok: true });
  });

  // 5. Find rooms. NOT EXISTS means no confirmed booking overlaps this time.
  app.get('/api/rooms', async (req, res) => {
    const { date, start = '09:00', end = '10:00', kind = 'all', q = '', sort = 'recommended' } = req.query;
    const { startsAt, endsAt, hours } = bookingWindow(date, start, end);
    const capacity = integer(req.query.capacity ?? 1, 'Guests');
    if (!['all', 'meeting-room', 'private-office', 'creative-studio'].includes(kind)) fail(400, 'Unknown room type.');
    if (typeof q !== 'string' || q.length > 100) fail(400, 'Search must be under 100 characters.');
    const orders = { recommended: 'r.featured DESC, r.id', 'price-low': 'r.hourly_rate, r.id', capacity: 'r.capacity DESC, r.id' };
    if (!Object.hasOwn(orders, sort)) fail(400, 'Unknown sort order.');
    const order = orders[sort];
    const result = await pool.query(`
      SELECT r.*, NOT EXISTS (
        SELECT 1 FROM bookings b WHERE b.room_id = r.id AND b.status = 'confirmed'
        AND b.starts_at < $2 AND b.ends_at > $1
      ) AS available FROM rooms r
      WHERE r.capacity >= $3 AND ($4 = 'all' OR r.kind = $4)
        AND ($5 = '' OR r.name ILIKE '%' || $5 || '%' OR r.location ILIKE '%' || $5 || '%')
      ORDER BY ${order}`, [startsAt, endsAt, capacity, kind, q]);
    res.json({ rooms: result.rows, hours, timezone: 'Asia/Kolkata' });
  });

  // 6. Create, list, and cancel bookings. The SQL constraint is the final conflict check.
  app.get('/api/bookings', requireLogin, async (req, res) => {
    const result = await pool.query('SELECT b.*, r.name AS room_name, r.kind, r.location FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.user_id = $1 ORDER BY b.starts_at DESC', [req.user.id]);
    res.json({ bookings: result.rows });
  });
  app.post('/api/bookings', requireLogin, async (req, res) => {
    const roomId = integer(req.body?.roomId, 'Room', 2147483647);
    const guests = integer(req.body?.guests, 'Guests');
    const purpose = req.body?.purpose ? text(req.body.purpose, 'Purpose', 1, 160) : '';
    const { startsAt, endsAt, hours } = bookingWindow(req.body?.date, req.body?.start, req.body?.end, true);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const room = (await client.query('SELECT * FROM rooms WHERE id = $1 FOR SHARE', [roomId])).rows[0];
      if (!room) fail(404, 'Room not found.');
      if (guests > room.capacity) fail(400, `This room holds up to ${room.capacity} guests.`);
      const result = await client.query(`
        INSERT INTO bookings(id, reference, user_id, room_id, starts_at, ends_at, guests, purpose, total_paise)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(), `RM-${randomBytes(6).toString('hex').toUpperCase()}`, req.user.id, roomId, startsAt, endsAt, guests, purpose, Math.round(room.hourly_rate * hours)]);
      await client.query('COMMIT');
      res.status(201).json({ booking: { ...result.rows[0], room_name: room.name } });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
  app.post('/api/bookings/:id/cancel', requireLogin, async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) fail(400, 'Invalid booking ID.');
    const result = await pool.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND user_id = $2 AND status = 'confirmed' AND starts_at > now() RETURNING *", [req.params.id, req.user.id]);
    if (!result.rows[0]) fail(404, 'You can only cancel your own upcoming reservations.');
    res.json({ booking: result.rows[0] });
  });

  // 7. Serve only the three frontend files, handle errors, and start the server.
  app.use('/api', () => fail(404, 'API endpoint not found.'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const [route, file] of [['/', 'index.html'], ['/style.css', 'style.css'], ['/script.js', 'script.js']]) {
    app.get(route, (_req, res) => res.sendFile(path.join(root, file)));
  }
  app.use(() => fail(404, 'Page not found.'));
  app.use((error, _req, res, _next) => {
    let status = error.status || 500;
    let message = status < 500 ? error.message : 'Something went wrong. Please try again.';
    if (error.code === '23P01') { status = 409; message = 'This room was just booked for that time. Choose a different room or time.'; }
    if (error.code === '23505') { status = 409; message = 'This email is already registered. Please sign in.'; }
    if (error.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON request.'; }
    if (['ECONNREFUSED', '57P01', '57P03'].includes(error.code)) { status = 503; message = 'Database unavailable. Please try again shortly.'; }
    if (status >= 500) console.error('Request failed:', error.code || error.name);
    res.status(status).json({ error: message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try {
    await pool.query('SELECT 1 FROM rooms LIMIT 1');
    const port = Number(process.env.PORT || 3000);
    const server = createApp(pool).listen(port, '127.0.0.1', () => console.log(`Open http://localhost:${port}`));
    server.on('error', async error => { console.error(error.code); await pool.end(); process.exit(1); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.close(async () => { await pool.end(); process.exit(0); });
      setTimeout(() => process.exit(1), 5000).unref();
    });
  } catch { console.error('Run npm run setup first to prepare the database.'); await pool.end(); process.exit(1); }
}
