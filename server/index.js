require('dotenv').config();

// RESEND_API_KEY / EMAIL_FROM are intentionally NOT required: email.js no-ops
// (with a warning) when the key is absent, so a partially-configured environment
// still boots. Set them for email to actually send.
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`ERROR: Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// Sentry must be initialised before any other import that you want instrumented.
// Absent DSN = Sentry is a no-op; safe to leave in prod with empty env.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || undefined,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
  });
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const crypto = require('crypto');
const v8 = require('v8');
const { requireAuth, requirePlan, requireProAddon, requirePlanToolsAddon } = require('./middleware/auth');
const pool = require('./db');
const logger = require('./logger');

const app = express();
app.set('trust proxy', 1); // trust first proxy (Render) so req.ip is the real client IP
app.use(helmet());

// Request logging: one line per request with a reqId that's attached to
// req.log so handlers can log more context that correlates to the request.
// Health checks are logged at debug only to keep prod logs clean.
app.use(pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = existing || crypto.randomBytes(8).toString('hex');
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (req.url === '/api/health' || req.url === '/api/health/live') return 'debug';
    return 'info';
  },
  serializers: {
    // Redact tokens embedded in public path segments before they hit the
    // log stream. Any `/api/public/<scope>/<verb>/<token>` URL becomes
    // `/api/public/<scope>/<verb>/[redacted]`. Without this, anyone with
    // log access could take over by re-using the URL — for booking
    // manage, estimate accept, change-order accept, lien-waiver sign.
    req: req => ({
      method: req.method,
      url: redactTokenInUrl(req.url),
      ip: req.ip,
    }),
    res: res => ({ statusCode: res.statusCode }),
  },
}));

// Path patterns that end in a tokenized last segment. The redaction is
// conservative — only the patterns we know carry tokens get scrubbed,
// so e.g. `/admin/workers/42` keeps the id.
const TOKENIZED_URL_PATTERNS = [
  /^(\/api)?\/public\/book\/manage\/([^/?]+)/,
  /^(\/api)?\/public\/estimates\/(view|accept|decline)\/([^/?]+)/,
  /^(\/api)?\/public\/change-orders\/(view|accept|decline)\/([^/?]+)/,
  /^(\/api)?\/public\/lien-waivers\/sign\/([^/?]+)/,
  /^\/e\/([^/?]+)/,
  /^\/co\/([^/?]+)/,
  /^\/lien-waiver-sign\/([^/?]+)/,
  /^\/book\/manage\/([^/?]+)/,
];
function redactTokenInUrl(url) {
  if (!url) return url;
  for (const re of TOKENIZED_URL_PATTERNS) {
    const m = url.match(re);
    if (m) {
      // Replace the last capture group (the token) with [redacted].
      const tokenIndex = m.length - 1;
      return url.replace(m[tokenIndex], '[redacted]');
    }
  }
  return url;
}

const ALLOWED_ORIGINS = [
  'https://opsfloa.com',
  'https://www.opsfloa.com',
  'https://dev.opsfloa.com',
  'https://stage.opsfloa.com',
  // Local development
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman, mobile apps, same-origin)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// Block TRACE method
app.use((req, res, next) => {
  if (req.method === 'TRACE') return res.status(405).end();
  next();
});

// Prevent caching of all API responses
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// Stripe webhook needs raw body before express.json parses it
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Unauthenticated endpoints never need large bodies — cap them tightly so
// they can't be abused for memory amplification. The first json parser to
// run wins (express.json no-ops once req.body is set), so these tight
// parsers on the public path prefixes take precedence over the 20 MB
// app-wide limit applied to authenticated routes below. Public gets 1 MB to
// allow a base64 drawn signature on the lien-waiver sign flow.
app.use('/api/auth', express.json({ limit: '256kb' }));
app.use('/api/client-errors', express.json({ limit: '256kb' }));
app.use('/api/sendgrid-events', express.json({ limit: '1mb' }));
app.use('/api/public', express.json({ limit: '1mb' }));
// Company-shared takeoffs embed the whole plan PDF as base64 (≈+33%), so they
// need a bigger body than the 20 MB app-wide cap. Runs first, so it wins.
app.use('/api/takeoffs', express.json({ limit: '64mb' }));
app.use('/api/estimates', express.json({ limit: '48mb' })); // plan-PDF attach via base64
app.use(express.json({ limit: '20mb' }));

// Health probes must be registered before any catch-all authenticated /api
// routers, otherwise hosting readiness checks receive a 401 before reaching
// these handlers.
app.get('/api/health/live', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/api/health', async (req, res) => {
  const checks = {};
  let healthy = true;

  try {
    const start = Date.now();
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db timeout')), 3000)),
    ]);
    checks.db = { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    checks.db = { ok: false, error: err.message };
    healthy = false;
  }

  const mem = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const heapPct = mem.heapUsed / heapLimit;
  checks.memory = {
    ok: heapPct < 0.9,
    heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    heap_limit_mb: Math.round(heapLimit / 1024 / 1024),
    rss_mb: Math.round(mem.rss / 1024 / 1024),
  };
  if (!checks.memory.ok) healthy = false;

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    uptime_s: Math.round(process.uptime()),
    checks,
  });
});

// Establish the request-scoped demo context (suppresses email + surfaces
// the popup flag for demo tenants). Mounted before routers so it wraps
// every API request; requireAuth fills in the acting company.
const { demoContextMiddleware, refreshDemoCompanies } = require('./demoMode');
app.use('/api', demoContextMiddleware);
refreshDemoCompanies(); // prime the demo-company cache at startup

app.use('/api/auth', require('./routes/auth'));
const projectsRouter = require('./routes/projects');
app.use('/api/work', projectsRouter);        // renamed home for the core Work/Projects resource
app.use('/api/projects', projectsRouter);     // legacy alias (project sub-resources still live at /api/projects/:id/...)
app.use('/api/work-orders', requireAuth, require('./routes/workOrders'));
app.use('/api/takeoffs', requireAuth, requirePlanToolsAddon, require('./routes/takeoffs')); // company-shared plan-tools library (sitework takeoff + Plan Room)
// Live collaboration sessions. The SSE stream authenticates via a query token
// (EventSource can't send a Bearer header) so it's registered BEFORE the gated
// router — otherwise requireAuth would reject it for the missing header.
const liveSessions = require('./routes/liveSessions');
app.get('/api/live/:id/stream', liveSessions.streamHandler);
app.use('/api/live', requireAuth, requirePlanToolsAddon, liveSessions.router);
app.use('/api/time-entries', require('./routes/timeEntries'));
app.use('/api/admin', require('./routes/admin'));
// QBO OAuth callback must be public (Intuit redirects here without a JWT)
const qboRouter = require('./routes/qbo');
app.get('/api/qbo/callback', qboRouter.oauthCallback);
app.use('/api/qbo', requireAuth, requireProAddon, qboRouter);
app.use('/api/clock', require('./routes/clock'));
app.use('/api/superadmin', require('./routes/superadmin'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/push', require('./routes/push'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/field-reports', requireAuth, requirePlan('business'), require('./routes/fieldReports'));
app.use('/api/incidents', requireAuth, requirePlan('business'), require('./routes/incidents'));
app.use('/api/sub-reports', requireAuth, requirePlan('business'), require('./routes/subReports'));
app.use('/api/equipment', requireAuth, requirePlan('business'), require('./routes/equipment'));
app.use('/api/inventory', requireAuth, requirePlan('business'), require('./routes/inventory'));
app.use('/api/rfis', requireAuth, requirePlan('business'), require('./routes/rfis'));
app.use('/api/daily-reports', requireAuth, requirePlan('business'), require('./routes/dailyReports'));
app.use('/api/haul-tickets', requireAuth, requirePlan('business'), require('./routes/haulTickets'));
app.use('/api/punchlist', requireAuth, requirePlan('business'), require('./routes/punchlist'));
app.use('/api/inspections', requireAuth, requirePlan('business'), require('./routes/inspections'));
app.use('/api/safety-talks', requireAuth, requirePlan('business'), require('./routes/safetyTalks'));
app.use('/api/safety-checklists', requireAuth, requirePlan('business'), require('./routes/safetyChecklists'));
// Voice transcription tool (Tools module) — upload audio, diarized transcript
app.use('/api/recordings', requireAuth, requirePlan('business'), require('./routes/recordings'));
app.use('/api/office', requireAuth, requirePlan('business'), require('./routes/officeTools'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/time-off', requireAuth, require('./routes/timeOff'));
app.use('/api/reimbursements', requireAuth, require('./routes/reimbursements'));
app.use('/api/certified-payroll', require('./routes/certifiedPayroll'));
app.use('/api/team', require('./routes/team'));

// Client-submitted service requests — public intake unauthenticated,
// admin management behind /api/admin/service-requests.
const serviceRequestsRoutes = require('./routes/serviceRequests');
app.use('/api/public/service-requests', serviceRequestsRoutes.publicRouter);
app.use('/api/admin/service-requests', serviceRequestsRoutes);
const companyPublicProfileRoutes = require('./routes/companyPublicProfiles');
app.use('/api/public/company-profiles', companyPublicProfileRoutes.publicRouter);
app.use('/api/admin/company-profile', companyPublicProfileRoutes);

// Public booking must mount before any broad authenticated /api routers.
// Otherwise /api/public/book/:companySlug can be challenged by auth before
// the public router gets a chance to handle it.
const bookingRoutes = require('./routes/booking');
app.use('/api/public/book', bookingRoutes.publicRouter);

// Estimates — admin authenticated for management, token-keyed public
// for client view/accept/decline (same pattern as service requests).
const estimatesRoutes = require('./routes/estimates');
app.use('/api/public/estimates', estimatesRoutes.publicRouter);
app.use('/api/estimates', requireAuth, requirePlan('business'), estimatesRoutes);

// Public token-keyed routes and unauthenticated webhooks must mount before
// any broad authenticated /api routers.
const changeOrderRoutes = require('./routes/changeOrders');
app.use('/api/public/change-orders', changeOrderRoutes.publicRouter);
const lienWaiverRoutes = require('./routes/lienWaivers');
app.use('/api/public/lien-waivers', lienWaiverRoutes.publicRouter);
app.use('/api/client-errors', require('./routes/clientErrors'));
app.use('/api/sendgrid-events', require('./routes/sendgridEvents'));

// Per-project budget category CRUD — feeds the spend rollup + budget bar.
app.use('/api', requireAuth, requirePlan('business'), require('./routes/projectBudget'));

// Per-project spend rollup (Phase 3) + project_expenses CRUD.
app.use('/api', requireAuth, requirePlan('business'), require('./routes/projectSpend'));

// Subcontractors directory + sub POs + payments. Spend rollup picks
// the subs bucket up automatically once these tables exist.
app.use('/api', requireAuth, requirePlan('business'), require('./routes/subcontractors'));

// Material catalog (estimate-line picker) + reusable item search.
app.use('/api', requireAuth, requirePlan('business'), require('./routes/catalog'));

// P&L dashboard + WIP report — read-only aggregations on top of
// estimates / budgets / spend / invoices.
app.use('/api', requireAuth, requirePlan('business'), require('./routes/projectReports'));

// Change orders — mid-project scope adjustments that bump budget categories
// on accept. Public token-keyed view/accept/decline mirrors estimates.
app.use('/api', requireAuth, requirePlan('business'), changeOrderRoutes);

// Submittals — architect/owner approval workflow for materials and
// equipment specs before installation.
app.use('/api', requireAuth, requirePlan('business'), require('./routes/submittals'));

// Project closeout — checklist orchestrating punchlist + lien waivers
// + invoices into a single screen. Auto-status items read live from
// the source modules.
app.use('/api', requireAuth, requirePlan('business'), require('./routes/closeout'));

// Lien waivers — compliance tracking; conditional/unconditional waivers
// in either direction. Public token-keyed signing surface for the
// counterparty.
app.use('/api', requireAuth, requirePlan('business'), lienWaiverRoutes);

// Booking module — appointment scheduling. Admin config + admin book
// endpoint behind auth; public booking surface (token-keyed) at
// /api/public/book/:companySlug.
app.use('/api', requireAuth, requirePlan('business'), bookingRoutes);
app.use('/api/availability', requireAuth, require('./routes/availability'));

// Read-only company settings — available to all authenticated users
const { SETTINGS_DEFAULTS, applySettingsRows } = require('./settingsDefaults');
const { limitForPlan } = require('./storage');
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const [settingsResult, coResult] = await Promise.all([
      pool.query('SELECT key, value FROM settings WHERE company_id = $1', [req.user.company_id]),
      pool.query('SELECT plan, subscription_status, storage_bytes_used, is_demo FROM companies WHERE id = $1', [req.user.company_id]),
    ]);
    const settings = applySettingsRows(settingsResult.rows, SETTINGS_DEFAULTS);
    const { plan, subscription_status, storage_bytes_used, is_demo } = coResult.rows[0] || {};
    const resolvedPlan = plan || 'free';
    const resolvedStatus = subscription_status || 'trial';

    // Exempt companies get all plan-gated features enabled regardless of
    // stored settings. module_* flags are admin-controlled visibility toggles,
    // not plan-gated, so we don't override those — otherwise turning a module
    // off in admin settings has no effect for exempt companies.
    const featureOverrides = resolvedStatus === 'exempt'
      ? Object.fromEntries(
          Object.keys(settings)
            .filter(k => k.startsWith('feature_'))
            .map(k => [k, true])
        )
      : {};

    res.json({
      ...settings,
      ...featureOverrides,
      ...(resolvedStatus === 'exempt' ? { addon_qbo: true } : {}),
      plan: resolvedPlan,
      subscription_status: resolvedStatus,
      storage_bytes_used: parseInt(storage_bytes_used ?? 0),
      storage_limit_bytes: is_demo ? 200 * 1024 * 1024 : limitForPlan(resolvedPlan),
    });
  } catch (err) {
    req.log.error({ err }, 'GET /api/settings failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// Company contact info — available to all authenticated users (used in worker invoice)
app.get('/api/company-info', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT name, address, phone, contact_email FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    req.log.error({ err }, 'GET /api/company-info failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// Express error handler — bubble unhandled errors to Sentry and log them.
// Must come after all routes. Returning a generic 500 so we don't leak internals.
app.use((err, req, res, _next) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  (req.log || logger).error({ err }, 'unhandled route error');
  if (res.headersSent) return;
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message || 'Bad request' });
  }
  res.status(500).json({ error: 'Server error' });
});

// Last-chance error logging. Node's default is to crash on an uncaught
// exception — we log structured first so the cause is visible in logs,
// then let the process exit (Render restarts it).
process.on('uncaughtException', err => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  logger.fatal({ err }, 'uncaughtException');
  setTimeout(() => process.exit(1), 200); // give pino time to flush
});
process.on('unhandledRejection', reason => {
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
  logger.error({ reason }, 'unhandledRejection');
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info({ port: PORT }, 'server listening');
  const { startInactiveWorkerJob } = require('./jobs/inactiveWorkers');
  startInactiveWorkerJob();
  const { startExpireTrialsJob } = require('./jobs/expireTrials');
  startExpireTrialsJob();
  const { startEquipmentMaintenanceJob } = require('./jobs/equipmentMaintenance');
  startEquipmentMaintenanceJob();
  const { startRentalReturnRemindersJob } = require('./jobs/rentalReturnReminders');
  startRentalReturnRemindersJob();
  const { startSubDocExpiryJob } = require('./jobs/subDocExpiry'); // sub COI / license lapse alerts
  startSubDocExpiryJob();
  const { startBidDueReminderJob } = require('./jobs/bidDueReminders');
  startBidDueReminderJob();
  const { startMediaRetentionJob } = require('./jobs/mediaRetention');
  startMediaRetentionJob();
  const { startScheduledReportsJob } = require('./jobs/scheduledReports');
  startScheduledReportsJob();
  const { startTranscriptionPollerJob } = require('./jobs/transcriptionPoller'); // AssemblyAI result sweep
  startTranscriptionPollerJob();
  const { startTakeoffOrphanSweepJob } = require('./jobs/takeoffOrphanSweep'); // presigned-upload leak cleanup (opt-in via R2_ORPHAN_SWEEP=1)
  startTakeoffOrphanSweepJob();
  const { startLiveSessionSweepJob } = require('./jobs/liveSessionSweep'); // end abandoned live sessions
  startLiveSessionSweepJob();
  const { startCron } = require('./cron');
  startCron();
});
