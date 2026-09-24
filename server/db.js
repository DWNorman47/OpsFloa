const { Pool } = require('pg');
require('dotenv').config();
const logger = require('./logger');

// Strip sslmode= from the connection string. Hosts like Neon and Render
// include `?sslmode=require` in the URL they hand out; pg-connection-string
// 2.x prints a deprecation warning whenever it sees one of the legacy modes
// (prefer / require / verify-ca) because it will treat them as verify-full
// in v3. We pass `ssl` explicitly below, so the URL hint is redundant.
const { stripSslMode } = require('./utils/dbConnString');

// Default SSL on — Neon and Render-hosted Postgres both require it, and
// the URL we used to receive carried `?sslmode=require` to express that.
// Stripping sslmode (above) means the SSL signal has to come from this
// option instead. Local Postgres without TLS can opt out via DATABASE_SSL=false.
const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };

function envInt(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Non-negative int env var; `0` is a real value here (disables a timeout).
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Server-side guards so one runaway query or a leaked open transaction can't
// pin a pooled connection (and its locks) forever:
//   statement_timeout                    — cancel any statement running > 30s
//   idle_in_transaction_session_timeout — kill a session idle inside BEGIN > 60s
// Code that legitimately needs longer uses pool.queryLong() below (SET LOCAL
// inside its own transaction).
const STATEMENT_TIMEOUT_MS = envMs('PG_STATEMENT_TIMEOUT_MS', 30000);
const IDLE_IN_TX_TIMEOUT_MS = envMs('PG_IDLE_IN_TX_TIMEOUT_MS', 60000);

// node-postgres sends these as *startup parameters*. PgBouncer (Neon's
// `-pooler` endpoint) rejects unknown startup parameters with
// "unsupported startup parameter", which would fail every connection — so on a
// pooled host they are NOT sent; migration 0204 sets the same values as
// role-level defaults instead (the Neon-documented way for pooled sessions).
// PG_POOLED=true|false overrides the host-name sniff.
function isPooledConnString(url) {
  if (process.env.PG_POOLED === 'true') return true;
  if (process.env.PG_POOLED === 'false') return false;
  try { return /-pooler\./i.test(new URL(url).hostname); } catch { return false; }
}
const connectionString = stripSslMode(process.env.DATABASE_URL);
const pooled = isPooledConnString(connectionString);

const pool = new Pool({
  connectionString,
  ssl,
  max: envInt('PG_POOL_MAX', 10),
  idleTimeoutMillis: envInt('PG_IDLE_TIMEOUT_MS', 30000),
  connectionTimeoutMillis: envInt('PG_CONNECTION_TIMEOUT_MS', 10000),
  ...(pooled ? {} : {
    ...(STATEMENT_TIMEOUT_MS ? { statement_timeout: STATEMENT_TIMEOUT_MS } : {}),
    ...(IDLE_IN_TX_TIMEOUT_MS ? { idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS } : {}),
  }),
});

pool.on('error', err => {
  logger.warn({ err }, 'postgres idle client error');
});

/**
 * Run one read/write statement that may legitimately exceed the 30s default
 * (big exports, backfills). Wraps it in its own transaction with
 * `SET LOCAL statement_timeout`, which is pooler-safe (a session-level SET is
 * not: under transaction pooling the next statement may land on another
 * backend). Same result shape as pool.query.
 */
pool.queryLong = async function queryLong(text, params, timeoutMs = 300000) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(0, parseInt(timeoutMs, 10) || 0)}`);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = pool;
module.exports.isPooledConnString = isPooledConnString;
