/**
 * Migration linter — runs against a throwaway Postgres to catch broken or
 * misordered migrations before they hit staging.
 *
 * Checks performed:
 *   1. Static — every file matches NNNN_description.sql and numbers are unique.
 *   2. Fresh apply — loads schema.sql, then applies every migration in order
 *      against an empty DB. Any SQL error fails the lint.
 *   3. Idempotency (warn-only) — re-applies every migration. Migrations that
 *      error the second time are flagged but don't fail CI, since production
 *      never re-runs them (schema_migrations tracking prevents it) and many
 *      historical migrations were genuinely one-shot.
 *
 * Required env:
 *   DATABASE_URL   postgres://user:pass@host:port/db  (ideally a fresh DB)
 *   DATABASE_SSL   'false' to disable (default on for hosted; off for CI)
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { stripSslMode } = require('../utils/dbConnString');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const SCHEMA_PATH    = path.join(__dirname, '..', 'schema.sql');

function readFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

function staticCheck(files) {
  const errors = [];
  const prefixes = new Map();
  for (const f of files) {
    const m = f.match(/^(\d{4})_[a-z0-9_]+\.sql$/i);
    if (!m) {
      errors.push(`Bad filename: ${f} (expected NNNN_description.sql, lowercase + underscores)`);
      continue;
    }
    const n = m[1];
    if (prefixes.has(n)) {
      errors.push(`Duplicate migration number ${n}: ${prefixes.get(n)} and ${f}`);
    } else {
      prefixes.set(n, f);
    }
  }
  return errors;
}

async function lint() {
  const files = readFiles();
  console.log(`[migrations-lint] ${files.length} migration files found`);

  // 1. Static check
  const staticErrors = staticCheck(files);
  if (staticErrors.length) {
    console.error('[migrations-lint] static errors:');
    staticErrors.forEach(e => console.error('  ✗ ' + e));
    process.exit(1);
  }
  console.log('[migrations-lint] static checks passed');

  if (!process.env.DATABASE_URL) {
    console.log('[migrations-lint] DATABASE_URL not set — static checks only (OK)');
    return;
  }

  // Passes 1–2 re-run EVERY migration and commit each one — on a real database
  // that re-executes one-shot data migrations (0003 drops company_chat, 0068
  // truncates worker_availability, ...). dotenv above picks up server/.env, so a
  // plain `npm run lint:migrations` on a dev machine used to hit the Neon dev
  // branch (it did, 2026-09-24). Only a local/throwaway Postgres is allowed
  // (CI uses localhost); anything else needs an explicit opt-in.
  let dbHost = '';
  try { dbHost = new URL(process.env.DATABASE_URL).hostname; } catch (_) { /* unparseable → treated as remote */ }
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(dbHost);
  if (!isLocal && process.env.LINT_MIGRATIONS_ALLOW_REMOTE !== 'yes-this-db-is-disposable') {
    console.log(`[migrations-lint] DATABASE_URL host "${dbHost || '?'}" is not local — static checks only.`);
    console.log('  The apply passes run every migration against that DB. Point DATABASE_URL at a throwaway');
    console.log('  local Postgres, or set LINT_MIGRATIONS_ALLOW_REMOTE=yes-this-db-is-disposable.');
    return;
  }

  const pool = new Pool({
    connectionString: stripSslMode(process.env.DATABASE_URL),
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    // 2. Fresh apply — schema.sql first, then every migration in order.
    if (fs.existsSync(SCHEMA_PATH)) {
      const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
      try {
        await pool.query(schemaSql);
        console.log('[pass 1] ✓ schema.sql');
      } catch (err) {
        console.error(`[pass 1] ✗ schema.sql: ${err.message}`);
        process.exit(1);
      }
    }

    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').trim();
      if (!sql || /^--/.test(sql) && !sql.split('\n').some(l => l.trim() && !l.trim().startsWith('--'))) {
        // Comment-only marker files (like 0001_baseline.sql) — skip silently
        console.log(`[pass 1] ⊘ ${file} (empty/comment-only)`);
        continue;
      }
      try {
        await pool.query(sql);
        console.log(`[pass 1] ✓ ${file}`);
      } catch (err) {
        console.error(`[pass 1] ✗ ${file}: ${err.message}`);
        process.exit(1);
      }
    }

    // 3. Idempotency (warn only)
    const nonIdempotent = [];
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').trim();
      if (!sql) continue;
      try {
        await pool.query(sql);
      } catch (err) {
        nonIdempotent.push({ file, error: err.message.split('\n')[0] });
      }
    }
    if (nonIdempotent.length) {
      console.log(`\n[migrations-lint] ${nonIdempotent.length} non-idempotent migration(s) (informational):`);
      nonIdempotent.forEach(n => console.log(`  ⚠ ${n.file}: ${n.error}`));
      console.log('  (this is OK for historical migrations — production tracks applied state)');
    } else {
      console.log('\n[migrations-lint] all migrations are idempotent');
    }

    console.log('\n[migrations-lint] OK');
  } finally {
    await pool.end();
  }
}

lint().catch(err => {
  console.error('[migrations-lint] FAILED:', err.message);
  process.exit(1);
});
