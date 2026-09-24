// db.js: server-side query timeouts on the app pool. Sent as pg startup
// parameters on a direct connection only — PgBouncer (Neon `-pooler`) rejects
// unknown startup parameters, so there migration 0204 sets role defaults.
// pool.queryLong() overrides the timeout with SET LOCAL in its own transaction.
jest.mock('pg', () => {
  const clients = [];
  class Pool {
    constructor(opts) { this.options = opts; this.on = jest.fn(); }
    async connect() {
      const c = { calls: [], release: jest.fn() };
      c.query = jest.fn(async (text) => {
        c.calls.push(text);
        if (/boom/.test(text)) throw new Error('boom');
        return { rows: [{ ok: 1 }], rowCount: 1 };
      });
      clients.push(c);
      return c;
    }
  }
  return { Pool, __clients: clients };
});

function loadDb(url, extraEnv = {}) {
  let pool, pg;
  const saved = { ...process.env };
  Object.assign(process.env, { DATABASE_URL: url, PG_POOLED: '' }, extraEnv);
  jest.isolateModules(() => { pool = require('../db'); pg = require('pg'); });
  process.env = saved;
  pool.__clients = pg.__clients;
  return pool;
}

describe('db pool timeouts', () => {
  test('direct connection gets statement + idle-in-transaction timeouts', () => {
    const pool = loadDb('postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/db');
    expect(pool.options.statement_timeout).toBe(30000);
    expect(pool.options.idle_in_transaction_session_timeout).toBe(60000);
  });

  test('Neon pooler host: no startup parameters (PgBouncer would reject them)', () => {
    const pool = loadDb('postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db?sslmode=require');
    expect(pool.options.statement_timeout).toBeUndefined();
    expect(pool.options.idle_in_transaction_session_timeout).toBeUndefined();
  });

  test('env overrides; 0 disables', () => {
    const pool = loadDb('postgres://u:p@localhost/db', { PG_STATEMENT_TIMEOUT_MS: '0', PG_IDLE_IN_TX_TIMEOUT_MS: '5000' });
    expect(pool.options.statement_timeout).toBeUndefined();
    expect(pool.options.idle_in_transaction_session_timeout).toBe(5000);
  });

  test('queryLong wraps the statement with SET LOCAL in its own transaction', async () => {
    const pool = loadDb('postgres://u:p@localhost/db');
    const { __clients } = pool;
    const r = await pool.queryLong('SELECT * FROM audit_log WHERE company_id = $1', [1], 120000);
    expect(r.rows).toEqual([{ ok: 1 }]);
    const c = __clients[__clients.length - 1];
    expect(c.calls).toEqual(['BEGIN', 'SET LOCAL statement_timeout = 120000', 'SELECT * FROM audit_log WHERE company_id = $1', 'COMMIT']);
    expect(c.release).toHaveBeenCalled();
  });

  test('queryLong rolls back and releases on error', async () => {
    const pool = loadDb('postgres://u:p@localhost/db');
    const { __clients } = pool;
    await expect(pool.queryLong('SELECT boom')).rejects.toThrow('boom');
    const c = __clients[__clients.length - 1];
    expect(c.calls[c.calls.length - 1]).toBe('ROLLBACK');
    expect(c.release).toHaveBeenCalled();
  });
});
