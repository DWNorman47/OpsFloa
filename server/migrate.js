require('dotenv').config();
const { Pool } = require('pg');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { stripSslMode } = require('./utils/dbConnString');

const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const ONE_TIME_DEMO_SEED_MARKER = 'one_time_demo_operations_seed_2026_05_07';

function createPool() {
  return new Pool({
    connectionString: stripSslMode(process.env.DATABASE_URL),
    ssl,
  });
}

function runDemoSeed() {
  const companyName = process.env.DEMO_COMPANY_NAME || 'Demo Operations';
  console.log(`[demo-seed] seeding "${companyName}"`);

  const result = spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'seed-demo-data.js')], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Demo seed failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function shouldRunOneTimeProductionDemoSeed() {
  // Explicit opt-in only. The previous `VERCEL_ENV === 'production' ||
  // VERCEL_GIT_COMMIT_REF === 'main'` fallback was a foot-gun: the
  // backend deploys to Render so those env vars are normally absent,
  // but any future Vercel preview build that inherited PROD_DATABASE_URL
  // would have silently seeded the demo company into prod. Forcing the
  // env flag makes the intent explicit and reviewable.
  return process.env.DEMO_SEED_PRODUCTION_ONCE === 'true';
}

// Advisory-lock key serializing migration runs (two instances booting at once,
// or a manual `node migrate.js` during a deploy). Arbitrary constant.
const MIGRATION_LOCK_KEY = 7216350419;
// An ALTER waiting on a lock held by live traffic must fail the deploy fast
// rather than queue — every query behind it would queue too and stall the app.
const MIGRATION_LOCK_TIMEOUT = process.env.MIGRATE_LOCK_TIMEOUT || '10s';
// First-line opt-out for statements Postgres refuses inside a transaction
// block (CREATE INDEX CONCURRENTLY, VACUUM, ...) or files that manage their own
// BEGIN/COMMIT. Such files run as-is, then get recorded separately.
const NO_TRANSACTION_MARKER = /^\s*--\s*migrate:no-transaction\b/i;

function isNoTransaction(sql) {
  const firstLine = sql.replace(/^﻿/, '').split(/\r?\n/, 1)[0];
  return NO_TRANSACTION_MARKER.test(firstLine);
}

// Migrations want a direct (non-pooled) connection: Neon's `-pooler` endpoint
// runs PgBouncer in transaction mode, where session-level advisory locks and
// SETs don't stick. MIGRATE_DATABASE_URL wins; otherwise a Neon pooler host is
// rewritten to its direct twin (same host minus `-pooler`).
function migrationConnString() {
  if (process.env.MIGRATE_DATABASE_URL) return stripSslMode(process.env.MIGRATE_DATABASE_URL);
  const url = stripSslMode(process.env.DATABASE_URL);
  try {
    const u = new URL(url);
    if (/-pooler\./i.test(u.hostname)) {
      u.hostname = u.hostname.replace(/-pooler\./i, '.');
      return u.toString();
    }
  } catch { /* fall through */ }
  return url;
}

async function connectForMigrations() {
  const direct = migrationConnString();
  const pooledUrl = stripSslMode(process.env.DATABASE_URL);
  const tryConnect = async (connectionString) => {
    const pool = new Pool({ connectionString, ssl, max: 1 });
    try {
      const client = await pool.connect();
      return { pool, client };
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
  };
  try {
    return { ...(await tryConnect(direct)), direct: true };
  } catch (err) {
    if (direct === pooledUrl) throw err;
    console.warn(`[migrate] direct connection failed (${err.message}); falling back to DATABASE_URL`);
    return { ...(await tryConnect(pooledUrl)), direct: false };
  }
}

async function isApplied(client, file) {
  const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
  return rows.length > 0;
}

// Apply one file + its schema_migrations row atomically. Everything here is
// transaction-scoped (xact advisory lock, SET LOCAL), so it is correct even if
// we ended up on a pooled connection. Returns false if another runner got there
// first.
async function applyInTransaction(client, file, sql) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT.replace(/'/g, '')}'`);
    // Override the role-level 30s default (migration 0204) — backfills can be slow.
    await client.query('SET LOCAL statement_timeout = 0');
    if (await isApplied(client, file)) { await client.query('ROLLBACK'); return false; }
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection gone */ }
    throw err;
  }
}

async function applyWithoutTransaction(client, file, sql) {
  // Session-level settings (reliable on the direct connection).
  await client.query(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT.replace(/'/g, '')}'`);
  await client.query('SET statement_timeout = 0');
  try {
    await client.query(sql);
  } finally {
    await client.query('RESET lock_timeout').catch(() => {});
  }
  await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [file]);
  return true;
}

async function migrate() {
  const { pool, client, direct } = await connectForMigrations();
  let sessionLocked = false;

  try {
    // Create tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Whole-run lock so concurrent runners don't interleave (and so a
    // no-transaction file isn't applied twice). Session-level advisory locks
    // are only meaningful on a direct connection; behind the pooler we rely on
    // the per-file xact lock + re-check in applyInTransaction.
    if (direct) {
      // Migrations may legitimately run long; lift the role-level 30s default
      // (migration 0204) for this session — also covers the lock wait below.
      await client.query('SET statement_timeout = 0');
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      sessionLocked = true;
    }

    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (await isApplied(client, file)) {
        console.log(`[migrate] skip    ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const noTx = isNoTransaction(sql);
      console.log(`[migrate] apply   ${file}${noTx ? ' (no-transaction)' : ''}`);
      const applied = noTx
        ? await applyWithoutTransaction(client, file, sql)
        : await applyInTransaction(client, file, sql);
      console.log(`[migrate] ${applied ? 'done   ' : 'skip   '} ${file}${applied ? '' : ' (applied concurrently)'}`);
    }

    console.log('[migrate] all migrations applied');
  } finally {
    if (sessionLocked) {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

async function seedDemoDataIfEnabled() {
  if (process.env.DEMO_SEED_AUTO !== 'true') return;

  console.log('[demo-seed] auto seed enabled');
  runDemoSeed();
}

async function seedDemoDataOnceForProduction() {
  if (!shouldRunOneTimeProductionDemoSeed()) return;

  const pool = createPool();
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [ONE_TIME_DEMO_SEED_MARKER]
    );
    if (rows.length > 0) {
      console.log('[demo-seed] one-time production seed already applied');
      return;
    }

    console.log('[demo-seed] one-time production seed pending');
    runDemoSeed();
    await pool.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [ONE_TIME_DEMO_SEED_MARKER]
    );
    console.log('[demo-seed] one-time production seed marked complete');
  } finally {
    await pool.end();
  }
}

async function main() {
  await migrate();
  await seedDemoDataOnceForProduction();
  await seedDemoDataIfEnabled();
}

if (require.main === module) {
  main().catch(err => {
    console.error('[migrate] FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = { migrate, isNoTransaction, migrationConnString, applyInTransaction, applyWithoutTransaction, MIGRATION_LOCK_KEY };
