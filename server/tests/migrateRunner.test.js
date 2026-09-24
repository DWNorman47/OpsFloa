// migrate.js: each file + its schema_migrations row commit atomically under an
// advisory lock with a lock_timeout; files Postgres can't run in a transaction
// block opt out with a first-line `-- migrate:no-transaction` marker.
const fs = require('fs');
const path = require('path');
const {
  isNoTransaction, migrationConnString, applyInTransaction, applyWithoutTransaction, MIGRATION_LOCK_KEY,
} = require('../migrate');

function fakeClient({ applied = false, failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (text, params) => {
      calls.push(params ? [text, params] : text);
      if (failOn && String(text).includes(failOn)) throw new Error('boom');
      if (String(text).startsWith('SELECT 1 FROM schema_migrations')) return { rows: applied ? [{}] : [] };
      return { rows: [] };
    }),
  };
}

describe('isNoTransaction', () => {
  test('honors the first-line marker only', () => {
    expect(isNoTransaction('-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY x ON t (a);')).toBe(true);
    expect(isNoTransaction('﻿--   migrate:no-transaction (why)\r\nSELECT 1;')).toBe(true);
    expect(isNoTransaction('-- comment\n-- migrate:no-transaction\nSELECT 1;')).toBe(false);
    expect(isNoTransaction('ALTER TABLE t ADD COLUMN a INT;')).toBe(false);
  });
});

describe('migrationConnString', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  test('rewrites a Neon pooler host to the direct endpoint', () => {
    delete process.env.MIGRATE_DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db?sslmode=require';
    const out = new URL(migrationConnString());
    expect(out.hostname).toBe('ep-cool-123.us-east-2.aws.neon.tech');
    expect(out.searchParams.get('sslmode')).toBeNull();
  });

  test('leaves a non-pooler URL alone and prefers MIGRATE_DATABASE_URL', () => {
    delete process.env.MIGRATE_DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    expect(new URL(migrationConnString()).hostname).toBe('localhost');
    process.env.MIGRATE_DATABASE_URL = 'postgres://u:p@direct.example.com/db';
    expect(new URL(migrationConnString()).hostname).toBe('direct.example.com');
  });
});

describe('applyInTransaction', () => {
  test('runs lock, timeouts, SQL and the tracking INSERT inside one transaction', async () => {
    const c = fakeClient();
    await expect(applyInTransaction(c, '0999_x.sql', 'ALTER TABLE t ADD COLUMN a INT;')).resolves.toBe(true);
    const texts = c.calls.map(x => (Array.isArray(x) ? x[0] : x));
    expect(texts[0]).toBe('BEGIN');
    expect(c.calls[1]).toEqual(['SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]]);
    expect(texts).toContain("SET LOCAL lock_timeout = '10s'");
    expect(texts).toContain('SET LOCAL statement_timeout = 0');
    const sqlAt = texts.indexOf('ALTER TABLE t ADD COLUMN a INT;');
    const insAt = texts.indexOf('INSERT INTO schema_migrations (filename) VALUES ($1)');
    expect(sqlAt).toBeGreaterThan(0);
    expect(insAt).toBeGreaterThan(sqlAt);
    expect(texts[texts.length - 1]).toBe('COMMIT');
  });

  test('rolls back (no tracking row) when the SQL fails', async () => {
    const c = fakeClient({ failOn: 'ALTER TABLE' });
    await expect(applyInTransaction(c, '0999_x.sql', 'ALTER TABLE t ADD COLUMN a INT;')).rejects.toThrow('boom');
    const texts = c.calls.map(x => (Array.isArray(x) ? x[0] : x));
    expect(texts).not.toContain('INSERT INTO schema_migrations (filename) VALUES ($1)');
    expect(texts[texts.length - 1]).toBe('ROLLBACK');
  });

  test('skips a file another runner applied while we waited for the lock', async () => {
    const c = fakeClient({ applied: true });
    await expect(applyInTransaction(c, '0999_x.sql', 'SELECT 1;')).resolves.toBe(false);
    const texts = c.calls.map(x => (Array.isArray(x) ? x[0] : x));
    expect(texts).not.toContain('SELECT 1;');
    expect(texts[texts.length - 1]).toBe('ROLLBACK');
  });
});

describe('applyWithoutTransaction', () => {
  test('runs the SQL bare, then records it', async () => {
    const c = fakeClient();
    await applyWithoutTransaction(c, '0999_idx.sql', 'CREATE INDEX CONCURRENTLY i ON t (a);');
    const texts = c.calls.map(x => (Array.isArray(x) ? x[0] : x));
    expect(texts).not.toContain('BEGIN');
    expect(texts.indexOf('CREATE INDEX CONCURRENTLY i ON t (a);'))
      .toBeLessThan(texts.findIndex(t => t.startsWith('INSERT INTO schema_migrations')));
  });
});

describe('migration files', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  // Statements Postgres rejects inside a transaction block, or explicit
  // transaction control that would end migrate.js's own transaction early.
  const NEEDS_NO_TX = /^\s*(BEGIN|COMMIT|START\s+TRANSACTION|ROLLBACK)\s*;|\bCONCURRENTLY\b|^\s*VACUUM\b|\bALTER\s+SYSTEM\b|\bCREATE\s+DATABASE\b/im;
  const stripComments = sql => sql.replace(/--.*$/gm, '');

  test.each(fs.readdirSync(dir).filter(f => f.endsWith('.sql')))('%s carries the no-transaction marker if it needs one', (file) => {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    if (NEEDS_NO_TX.test(stripComments(sql))) expect(isNoTransaction(sql)).toBe(true);
  });
});
