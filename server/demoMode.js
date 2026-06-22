// Request-scoped "demo company" context.
//
// Demo/test tenants (companies.is_demo = true) must not send real email —
// the public demo login would otherwise be an open SendGrid spam relay.
// Rather than thread a companyId through ~20 sendEmail() call sites, we run
// every request inside an AsyncLocalStorage store carrying the acting
// company's demo flag. email.js reads that store and suppresses sends; the
// response wrapper surfaces a `demoEmailSuppressed` flag so the client can
// show a "would have sent" popup.
//
// Scope is intentionally request-bound ("while signed in as that company").
// Emails sent outside a request (cron jobs) don't carry this context; the
// demo tenant has no scheduled-email features today, but if that changes,
// those paths would need an explicit companyId check.

const { AsyncLocalStorage } = require('async_hooks');
const pool = require('./db');
const logger = require('./logger');

const als = new AsyncLocalStorage();

// Cache of demo company ids, refreshed lazily so neither requests nor
// email sends hit the DB to answer "is this the demo tenant?".
let demoCompanyIds = new Set();
let lastRefresh = 0;
const REFRESH_MS = 60 * 1000;

async function refreshDemoCompanies() {
  try {
    const { rows } = await pool.query('SELECT id FROM companies WHERE is_demo = true');
    demoCompanyIds = new Set(rows.map(r => String(r.id)));
    lastRefresh = Date.now();
  } catch (err) {
    logger.error({ err }, 'demo-company cache refresh failed');
  }
}

function isDemoCompanyId(companyId) {
  return companyId != null && demoCompanyIds.has(String(companyId));
}

// Global middleware: open an ALS store for the request and wrap res.json so
// a suppressed-email flag can ride back to the client. Mount BEFORE routers.
function demoContextMiddleware(req, res, next) {
  if (Date.now() - lastRefresh > REFRESH_MS) refreshDemoCompanies(); // non-blocking
  const store = { companyId: null, isDemo: false, emailSuppressed: false };
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (store.emailSuppressed && body && typeof body === 'object' && !Array.isArray(body)) {
      body.demoEmailSuppressed = true;
    }
    return origJson(body);
  };
  als.run(store, () => next());
}

// Called from requireAuth once req.user is known, so suppression + the popup
// target the acting tenant.
function markRequestCompany(companyId) {
  const store = als.getStore();
  if (store) {
    store.companyId = companyId;
    store.isDemo = isDemoCompanyId(companyId);
  }
}

function getStore() {
  return als.getStore();
}

module.exports = {
  demoContextMiddleware, markRequestCompany, getStore,
  isDemoCompanyId, refreshDemoCompanies,
};
