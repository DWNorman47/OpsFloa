/**
 * The company-data registry (utils/companyData.js) is the ONE list the company
 * hard-delete and the company export both walk. This test keeps it complete:
 * it scans schema.sql + every migration for tables that carry a company_id
 * column and fails for any that is neither registered nor explicitly excluded.
 *
 * Why: the purge + export lists were hand-maintained and drifted — haul_tickets
 * (NO-ACTION FK on created_by) was never purged, so deleting a company that used
 * haul tickets 500'd; payroll runs, rate history, work orders, invoice payments,
 * direct messages, recordings … were never exported.
 */

const fs = require('fs');
const path = require('path');
const {
  COMPANY_TABLES, EXPORT_TABLES, EXCLUDED_COMPANY_TABLES, MEDIA_URL_QUERIES,
  purgeCompanyRows, scrubRow,
} = require('../utils/companyData');

const SERVER = path.join(__dirname, '..');

// Walk schema.sql then migrations in order, tracking which tables exist (and
// whether they have a company_id column) statement by statement, so a table
// dropped and re-created (0003 company_chat, 0085 worker_documents) ends up right.
function scanCompanyTables() {
  const files = [
    path.join(SERVER, 'schema.sql'),
    ...fs.readdirSync(path.join(SERVER, 'migrations'))
      .filter(f => f.endsWith('.sql')).sort()
      .map(f => path.join(SERVER, 'migrations', f)),
  ];
  const tables = new Map(); // name -> hasCompanyId
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
    const events = [];
    let m;
    const reCreate = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(/gi;
    while ((m = reCreate.exec(sql))) {
      let depth = 1; let i = reCreate.lastIndex;
      while (i < sql.length && depth > 0) { if (sql[i] === '(') depth++; else if (sql[i] === ')') depth--; i++; }
      const body = sql.slice(reCreate.lastIndex, i - 1);
      events.push({ at: m.index, kind: 'create', name: m[1].toLowerCase(), company: /(^|[,(\s])company_id\s/i.test(body) });
    }
    const reAlter = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+([^;]*);/gi;
    while ((m = reAlter.exec(sql))) events.push({ at: m.index, kind: 'alter', name: m[1].toLowerCase(), body: m[2] });
    const reDrop = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w\s,."]+?)(?:\s+CASCADE)?\s*;/gi;
    while ((m = reDrop.exec(sql))) {
      for (const n of m[1].split(',')) events.push({ at: m.index, kind: 'drop', name: n.trim().replace(/"/g, '').replace(/^public\./, '').toLowerCase() });
    }
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === 'drop') { tables.delete(e.name); continue; }
      if (e.kind === 'create') { tables.set(e.name, (tables.get(e.name) || false) || e.company); continue; }
      const rename = /RENAME\s+TO\s+"?(\w+)"?/i.exec(e.body);
      if (rename) { const had = tables.get(e.name); tables.delete(e.name); tables.set(rename[1].toLowerCase(), !!had); continue; }
      if (/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?company_id\b/i.test(e.body)) tables.set(e.name, true);
      if (/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?company_id\b/i.test(e.body)) tables.set(e.name, false);
    }
  }
  return [...tables].filter(([, has]) => has).map(([name]) => name).sort();
}

describe('company data registry', () => {
  const registered = new Set(COMPANY_TABLES.map(e => e.table));

  test('the scanner finds the known company tables (sanity)', () => {
    const found = scanCompanyTables();
    for (const t of ['users', 'projects', 'time_entries', 'haul_tickets', 'payroll_runs', 'worker_rate_history', 'company_chat', 'worker_documents']) {
      expect(found).toContain(t);
    }
  });

  test('every table with a company_id column is registered (purge + export) or explicitly excluded', () => {
    const missing = scanCompanyTables().filter(t => !registered.has(t) && !(t in EXCLUDED_COMPANY_TABLES));
    // If this fails: add the table to COMPANY_TABLES in server/utils/companyData.js
    // (in FK-safe purge order), plus any R2 url column to MEDIA_URL_QUERIES.
    expect(missing).toEqual([]);
  });

  test('exclusions carry a reason and are not also registered', () => {
    for (const [t, reason] of Object.entries(EXCLUDED_COMPANY_TABLES)) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(10);
      expect(registered.has(t)).toBe(false);
    }
  });

  test('no table is registered twice, and companies is purged last', () => {
    const names = COMPANY_TABLES.map(e => e.table);
    expect(new Set(names).size).toBe(names.length);
    expect(names[names.length - 1]).toBe('companies');
  });

  test('FK-safe ordering: known RESTRICT / NO ACTION references are purged before their target', () => {
    const idx = t => COMPANY_TABLES.findIndex(e => e.table === t);
    const before = [
      ['haul_tickets', 'users'],
      ['appointments', 'users'], ['appointments', 'appointment_types'],
      ['inventory_transactions', 'inventory_items'], ['inventory_cycle_counts', 'inventory_items'],
      ['purchase_order_lines', 'inventory_item_uoms'], ['inventory_stock', 'inventory_item_uoms'],
      ['subcontract_pos', 'subcontractors'], ['subcontract_pos', 'projects'],
      ['lien_waivers', 'projects'], ['change_orders', 'projects'], ['submittals', 'projects'],
      ['project_closeouts', 'projects'], ['project_expenses', 'projects'], ['project_budget_categories', 'projects'],
      ['invoice_payments', 'invoices'], ['payroll_run_checks', 'payroll_runs'],
      ['time_off_requests', 'users'], ['daily_reports', 'users'], ['field_reports', 'users'],
      ['impersonation_log', 'users'], ['users', 'roles'], ['role_permissions', 'roles'],
    ];
    for (const [a, b] of before) {
      expect({ a, b, ok: idx(a) > -1 && idx(b) > -1 && idx(a) < idx(b) }).toEqual({ a, b, ok: true });
    }
  });

  test('export covers the tables that were previously missing, and skips platform-only ones', () => {
    const exported = new Set(EXPORT_TABLES.map(e => e.table));
    for (const t of ['invoice_payments', 'work_orders', 'haul_tickets', 'payroll_runs', 'payroll_run_checks',
      'worker_rate_history', 'project_prevailing_rate_history', 'company_default_rate_history',
      'direct_messages', 'recordings', 'daily_checklists', 'invoice_lines', 'estimate_lines', 'change_order_lines']) {
      expect(exported.has(t)).toBe(true);
    }
    expect(exported.has('impersonation_log')).toBe(false);
    expect(exported.has('companies')).toBe(false);
  });

  test('R2 media queries include the previously missed url columns', () => {
    const all = MEDIA_URL_QUERIES.join('\n');
    for (const col of ['audio_url', 'pdf_url', 'logo_url', 'plan_pdf_url', 'photo_url']) expect(all).toContain(col);
    for (const q of MEDIA_URL_QUERIES) expect(q).toMatch(/\$1/);
  });
});

describe('scrubRow', () => {
  test('drops password / token / secret / nonce / push-key columns', () => {
    const row = {
      id: 1, username: 'a', email: 'a@x.com',
      password_hash: 'h', reset_token: 't', invite_token: 't', email_confirm_token: 't',
      mfa_secret: 's', mfa_secret_pending: 's', mfa_enabled: true,
      qbo_access_token: 'x', qbo_refresh_token: 'y', qbo_oauth_nonce: 'n',
      response_token: 'r', p256dh: 'k', auth: 'k', endpoint: 'https://push',
    };
    expect(scrubRow(row)).toEqual({ id: 1, username: 'a', email: 'a@x.com', mfa_enabled: true, endpoint: 'https://push' });
  });
});

describe('purgeCompanyRows', () => {
  function fkError() { const e = new Error('violates foreign key'); e.code = '23503'; return e; }

  test('deletes every registered table under savepoints, companies last', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    await purgeCompanyRows(client, 'co-1');
    const deletes = client.query.mock.calls.map(c => c[0]).filter(s => s.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(COMPANY_TABLES.length);
    expect(deletes[deletes.length - 1]).toBe('DELETE FROM companies WHERE id = $1');
    for (const c of client.query.mock.calls.filter(c => c[0].startsWith('DELETE FROM'))) expect(c[1]).toEqual(['co-1']);
  });

  test('an FK-blocked step is rolled back to its savepoint and retried after the rest', async () => {
    let usersAttempts = 0;
    const client = {
      query: jest.fn(async (sql) => {
        if (/^DELETE FROM users\b/.test(sql) && usersAttempts++ === 0) throw fkError();
        return { rows: [], rowCount: 0 };
      }),
    };
    await purgeCompanyRows(client, 'co-1');
    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT sp_purge');
    expect(sqls.filter(s => /^DELETE FROM users\b/.test(s))).toHaveLength(2);
    // The retry happens after companies was attempted in pass 1.
    const lastUsers = sqls.map((s, i) => [s, i]).filter(([s]) => /^DELETE FROM users\b/.test(s)).pop()[1];
    expect(lastUsers).toBeGreaterThan(sqls.indexOf('DELETE FROM companies WHERE id = $1'));
  });

  test('a step that never unblocks throws the FK error (no infinite loop)', async () => {
    const client = {
      query: jest.fn(async (sql) => {
        if (/^DELETE FROM companies\b/.test(sql)) throw fkError();
        return { rows: [], rowCount: 0 };
      }),
    };
    await expect(purgeCompanyRows(client, 'co-1')).rejects.toMatchObject({ code: '23503' });
  });

  test('a missing table (42P01) is skipped; any other error aborts', async () => {
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const c1 = { query: jest.fn(async (sql) => { if (/^DELETE FROM live_sessions\b/.test(sql)) throw missing; return { rows: [] }; }) };
    await expect(purgeCompanyRows(c1, 'co-1')).resolves.toBeUndefined();

    const c2 = { query: jest.fn(async (sql) => { if (/^DELETE FROM time_entries\b/.test(sql)) throw new Error('boom'); return { rows: [] }; }) };
    await expect(purgeCompanyRows(c2, 'co-1')).rejects.toThrow('boom');
  });
});
