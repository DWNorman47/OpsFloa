const jwt = require('jsonwebtoken');
const pool = require('../db');
const { markRequestCompany } = require('../demoMode');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Short-lived special-purpose tokens (setup, MFA challenge, superadmin
  // impersonation) don't carry a tv claim — they've got their own narrow
  // scope and aren't affected by password changes. Normal auth tokens must
  // match the user's current token_version; mismatch means the user's
  // password was changed since this token was issued, so we reject it.
  if (payload.tv != null) {
    try {
      // One round trip does double duty: the live revocation check (token_version +
      // active) AND the acting company's plan/add-on row, so a plan-gated route
      // doesn't pay a second DB hop in requirePlan/requireXAddon (they read
      // req.company). The revocation checks below stay live per request — nothing is
      // cached — so a deactivated user or a changed password still loses access at once.
      const { rows } = await pool.query(
        `SELECT u.token_version, u.active,
                c.id AS _company_id, c.plan, c.subscription_status, c.trial_ends_at,
                c.addon_qbo, c.addon_certified_payroll, c.addon_advanced_payroll,
                c.addon_takeoff, c.addon_planroom, c.addon_roof
           FROM users u
           LEFT JOIN companies c ON c.id = $2
          WHERE u.id = $1`,
        [payload.id, payload.company_id ?? null]
      );
      if (rows.length === 0) return res.status(401).json({ error: 'Invalid token' });
      const u = rows[0];
      // Deactivated (fired / offboarded) users must lose access immediately,
      // not at token expiry. Their JWT is otherwise still valid for up to a
      // day, so without this check a removed employee keeps full access.
      if (u.active === false) {
        return res.status(401).json({ error: 'Account deactivated' });
      }
      if (u.token_version !== payload.tv) {
        return res.status(401).json({ error: 'Session invalidated, please log in again' });
      }
      req.company = u._company_id != null ? {
        plan: u.plan, subscription_status: u.subscription_status, trial_ends_at: u.trial_ends_at,
        addon_qbo: u.addon_qbo, addon_certified_payroll: u.addon_certified_payroll,
        addon_advanced_payroll: u.addon_advanced_payroll, addon_takeoff: u.addon_takeoff,
        addon_planroom: u.addon_planroom, addon_roof: u.addon_roof,
      } : null;
    } catch (err) {
      // DB hiccup — fail closed for safety.
      return res.status(503).json({ error: 'Auth service temporarily unavailable' });
    }
  } else if (payload.imp) {
    // Impersonation ("Login as") tokens carry no tv, so the block above skips
    // them — but over the token's 4h life either party can change:
    //   - the impersonated user could be deactivated (offboarded), and must
    //     lose access immediately, not at token expiry;
    //   - the super-admin who started the session could be deactivated or
    //     demoted, and their live impersonation must end at once.
    try {
      const { rows } = await pool.query(
        `SELECT
           (SELECT active FROM users WHERE id = $1)      AS target_active,
           (SELECT active FROM users WHERE id = $2)      AS imp_active,
           (SELECT role   FROM users WHERE id = $2)      AS imp_role`,
        [payload.id, payload.imp_by ?? null]
      );
      const row = rows[0] || {};
      if (row.target_active === false) {
        return res.status(401).json({ error: 'Account deactivated' });
      }
      // imp_by is absent on tokens minted before this claim existed; only
      // enforce the impersonator check when the token carries it.
      if (payload.imp_by != null && (row.imp_active !== true || row.imp_role !== 'super_admin')) {
        return res.status(401).json({ error: 'Impersonation session ended' });
      }
    } catch (err) {
      return res.status(503).json({ error: 'Auth service temporarily unavailable' });
    }
  }

  req.user = payload;
  // Mark the acting company on the request-scoped demo context so email
  // sends during this request are suppressed for demo tenants.
  markRequestCompany(payload.company_id);
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });
}

function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });
}

// Plan hierarchy: free < starter < business
const PLAN_LEVEL = { free: 0, starter: 1, business: 2 };

// The company columns every plan/add-on gate needs. requireAuth already fetched these
// alongside the token check for normal tokens (→ req.company); resolveCompany only issues
// a lookup on the paths that skip that (impersonation, super-admin, pre-auth stubs). Using
// `!== undefined` so a resolved-null (deleted company) isn't re-queried.
const COMPANY_AUTH_COLS =
  'plan, subscription_status, trial_ends_at, addon_qbo, addon_certified_payroll, addon_advanced_payroll, addon_takeoff, addon_planroom, addon_roof';
async function resolveCompany(req) {
  if (req.company !== undefined) return req.company;
  if (!req.user || req.user.company_id == null) { req.company = null; return null; }
  const r = await pool.query(`SELECT ${COMPANY_AUTH_COLS} FROM companies WHERE id = $1`, [req.user.company_id]);
  req.company = r.rows[0] || null;
  return req.company;
}

// Gate a route to a minimum plan.
// Trial companies always pass — they get full access until the trial ends.
// Canceled companies are always blocked.
function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const company = await resolveCompany(req);
      if (!company) return res.status(403).json({ error: 'Company not found' });

      // Real-time trial expiry check — don't wait for the cron job
      if (company.subscription_status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date()) {
        await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['trial_expired', req.user.company_id]);
        return res.status(403).json({ error: 'Trial expired', code: 'subscription_required' });
      }

      if (company.subscription_status === 'canceled' || company.subscription_status === 'trial_expired') {
        return res.status(403).json({ error: 'Subscription required', code: 'subscription_required' });
      }

      // Exempt and trial companies get full access to all features
      if (company.subscription_status === 'exempt' || company.subscription_status === 'trial') {
        return next();
      }

      const currentLevel = PLAN_LEVEL[company.plan || 'free'] ?? 0;
      const requiredLevel = PLAN_LEVEL[minPlan] ?? 0;

      if (currentLevel < requiredLevel) {
        return res.status(403).json({ error: 'Plan upgrade required', code: 'plan_required', required_plan: minPlan });
      }

      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  };
}

// Gate a route to the Pro add-on.
async function requireProAddon(req, res, next) {
  try {
    const company = await resolveCompany(req);
    if (!company) return res.status(403).json({ error: 'Company not found' });

    // Real-time trial expiry check
    if (company.subscription_status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date()) {
      await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['trial_expired', req.user.company_id]);
      return res.status(403).json({ error: 'Trial expired', code: 'subscription_required' });
    }

    if (company.subscription_status === 'canceled' || company.subscription_status === 'trial_expired') {
      return res.status(403).json({ error: 'Subscription required', code: 'subscription_required' });
    }

    // Exempt and trial users get full access
    if (company.subscription_status === 'exempt' || company.subscription_status === 'trial' || company.addon_qbo) {
      return next();
    }

    return res.status(403).json({ error: 'QBO add-on required', code: 'qbo_required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// Gate WH-347 / certified-payroll routes to the ADVANCED PAYROLL add-on. Certified
// payroll was folded into Advanced Payroll (see migration 0155), so this OR-gates on
// the new flag and the legacy certified one. Same trial/exempt bypass as
// requireProAddon. The export name stays `requireCertifiedPayrollAddon` so the many
// route references + test mocks don't churn; `requireAdvancedPayrollAddon` is an
// alias for new call sites.
async function requireCertifiedPayrollAddon(req, res, next) {
  try {
    const company = await resolveCompany(req);
    if (!company) return res.status(403).json({ error: 'Company not found' });

    if (company.subscription_status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date()) {
      await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['trial_expired', req.user.company_id]);
      return res.status(403).json({ error: 'Trial expired', code: 'subscription_required' });
    }

    if (company.subscription_status === 'canceled' || company.subscription_status === 'trial_expired') {
      return res.status(403).json({ error: 'Subscription required', code: 'subscription_required' });
    }

    if (company.subscription_status === 'exempt' || company.subscription_status === 'trial' || company.addon_advanced_payroll || company.addon_certified_payroll) {
      return next();
    }

    return res.status(403).json({ error: 'Advanced Payroll add-on required', code: 'advanced_payroll_required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}
const requireAdvancedPayrollAddon = requireCertifiedPayrollAddon; // alias — same gate

async function requireTakeoffAddon(req, res, next) {
  try {
    const company = await resolveCompany(req);
    if (!company) return res.status(403).json({ error: 'Company not found' });

    if (company.subscription_status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date()) {
      await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['trial_expired', req.user.company_id]);
      return res.status(403).json({ error: 'Trial expired', code: 'subscription_required' });
    }

    if (company.subscription_status === 'canceled' || company.subscription_status === 'trial_expired') {
      return res.status(403).json({ error: 'Subscription required', code: 'subscription_required' });
    }

    if (company.subscription_status === 'exempt' || company.subscription_status === 'trial' || company.addon_takeoff) {
      return next();
    }

    return res.status(403).json({ error: 'Takeoff add-on required', code: 'takeoff_required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// Any plan-tools add-on unlocks the shared library routes (/api/takeoffs
// serves the Plan Room takeoff library, list-filtered by the data.app
// marker). M6 of docs/plans/plan-viewer-markup.md adds the
// addon_planroom column + flag to this check when that SKU lands.
async function requirePlanToolsAddon(req, res, next) {
  try {
    const company = await resolveCompany(req);
    if (!company) return res.status(403).json({ error: 'Company not found' });

    if (company.subscription_status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date()) {
      await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['trial_expired', req.user.company_id]);
      return res.status(403).json({ error: 'Trial expired', code: 'subscription_required' });
    }
    if (company.subscription_status === 'canceled' || company.subscription_status === 'trial_expired') {
      return res.status(403).json({ error: 'Subscription required', code: 'subscription_required' });
    }
    if (company.subscription_status === 'exempt' || company.subscription_status === 'trial' || company.addon_takeoff || company.addon_planroom || company.addon_roof) {
      return next();
    }
    return res.status(403).json({ error: 'Plan-tools add-on required', code: 'takeoff_required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// Returns true if the user has a given admin permission.
// null admin_permissions = full access (existing admins + company founder).
function hasAdminPermission(user, key) {
  if (user.role === 'super_admin') return true;
  if (!user.admin_permissions) return true;
  return user.admin_permissions[key] === true;
}

// Middleware factory — gate a route to a specific admin permission.
function requirePermission(key) {
  return (req, res, next) => {
    if (!hasAdminPermission(req.user, key)) {
      return res.status(403).json({ error: 'Insufficient permissions', code: 'permission_denied', required: key });
    }
    next();
  };
}

// Re-export the Phase A permission framework so callers can pull both old
// and new checks from one import site. When Phase C lands and every route
// uses requirePerm, the legacy requirePermission/hasAdminPermission exports
// will be removed.
const { hasPerm, requirePerm } = require('../permissions');

module.exports = {
  requireAuth, requireAdmin, requireSuperAdmin, requirePlan, requireProAddon, requireCertifiedPayrollAddon, requireAdvancedPayrollAddon, requireTakeoffAddon, requirePlanToolsAddon,
  hasAdminPermission, requirePermission,
  hasPerm, requirePerm,
};
