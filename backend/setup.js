// Setup only: start a private local PostgreSQL instance and run database.sql.
// The booking logic is in backend/server.js; you can explain it without this file.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, '.local');
const data = path.join(local, 'postgres');
const metadata = path.join(local, 'postgres.json');
const envFile = path.join(root, '.env');

async function findPostgres() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = path.join(process.env.ProgramFiles || 'C:/Program Files', 'PostgreSQL');
  if (process.platform === 'win32' && existsSync(base)) {
    const versions = (await readdir(base)).sort((a, b) => Number(b) - Number(a));
    for (const version of versions) {
      const bin = path.join(base, version, 'bin');
      if (existsSync(path.join(bin, 'initdb.exe'))) return bin;
    }
  }
  const probe = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) return probe.stdout.trim();
  throw new Error('Install PostgreSQL, or set DATABASE_URL in .env to your own project database.');
}
function postgres(bin, command, args, check = true) {
  const executable = path.join(bin, `${command}${process.platform === 'win32' ? '.exe' : ''}`);
  // Background servers must not inherit the parent's output pipes on Windows.
  const starting = command === 'pg_ctl' && args.includes('start');
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...(starting ? { stdio: 'ignore' } : {}) });
  if (result.error) throw result.error;
  if (check && result.status !== 0) throw new Error(`${command} failed. ${(result.stderr || result.stdout || '').trim()} See .local/postgres.log.`);
  return result.status;
}

let client;
try {
  let saved = existsSync(metadata) ? JSON.parse(await readFile(metadata, 'utf8')) : null;
  if (process.argv[2] === 'stop') {
    if (saved && postgres(saved.bin, 'pg_ctl', ['-D', data, 'status'], false) === 0) {
      postgres(saved.bin, 'pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    }
    console.log('Project database is stopped. Data is preserved.');
  } else {
    let url = process.env.DATABASE_URL;
    if (saved || !url) {
      const bin = saved?.bin || await findPostgres();
      if (!saved) {
        if (existsSync(envFile)) throw new Error('Add DATABASE_URL to the existing .env, or rename it before setup.');
        await mkdir(local, { recursive: true });
        const passwordFile = path.join(local, 'password.tmp');
        const password = randomBytes(24).toString('hex');
        await writeFile(passwordFile, password, { mode: 0o600 });
        try { postgres(bin, 'initdb', ['-D', data, '-U', 'roomly', '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256', `--pwfile=${passwordFile}`]); }
        finally { await unlink(passwordFile).catch(() => {}); }
        saved = { bin, port: Number(process.env.LOCAL_PG_PORT || 55432) };
        url = `postgresql://roomly:${password}@127.0.0.1:${saved.port}/roomly`;
        await writeFile(envFile, `DATABASE_URL=${url}\nPORT=3000\nAPP_ORIGIN=http://localhost:3000\nNODE_ENV=development\n`, { mode: 0o600 });
        await writeFile(metadata, JSON.stringify(saved, null, 2));
      }
      if (postgres(bin, 'pg_ctl', ['-D', data, 'status'], false) !== 0) {
        postgres(bin, 'pg_ctl', ['-D', data, '-l', path.join(local, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${saved.port}`, '-w', 'start']);
      }
      url = (await readFile(envFile, 'utf8')).match(/^DATABASE_URL=(.+)$/m)?.[1].trim();
      const adminUrl = new URL(url);
      adminUrl.pathname = '/postgres';
      client = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
      await client.connect();
      if (!(await client.query("SELECT 1 FROM pg_database WHERE datname = 'roomly'")).rowCount) await client.query('CREATE DATABASE roomly');
      await client.end();
    }
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query('BEGIN');
    await client.query(await readFile(path.join(root, 'backend', 'database.sql'), 'utf8'));
    await client.query('COMMIT');
    console.log('Setup complete. Run npm start, then open http://localhost:3000.');
  }
} catch (error) {
  console.error(`Setup failed: ${error.code || error.message}`);
  process.exitCode = 1;
} finally { if (client) await client.end().catch(() => {}); }
