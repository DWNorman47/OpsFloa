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
      const { rows } = await pool.query(
        'SELECT token_version, active FROM users WHERE id = $1',
        [payload.id]
      );
      if (rows.length === 0) return res.status(401).json({ error: 'Invalid token' });
      // Deactivated (fired / offboarded) users must lose access immediately,
      // not at token expiry. Their JWT is otherwise still valid for up to a
      // day, so without this check a removed employee keeps full access.
      if (rows[0].active === false) {
        return res.status(401).json({ error: 'Account deactivated' });
      }
      if (rows[0].token_version !== payload.tv) {
        return res.status(401).json({ error: 'Session invalidated, please log in again' });
      }
    } catch (err) {
      // DB hiccup — fail closed for safety.
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

// Gate a route to a minimum plan.
// Trial companies always pass — they get full access until the trial ends.
// Canceled companies are always blocked.
function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const r = await pool.query(
        'SELECT plan, subscription_status, addon_qbo, trial_ends_at FROM companies WHERE id = $1',
        [req.user.company_id]
      );
      const company = r.rows[0];
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
        req.company = company;
        return next();
      }

      const currentLevel = PLAN_LEVEL[company.plan || 'free'] ?? 0;
      const requiredLevel = PLAN_LEVEL[minPlan] ?? 0;

      if (currentLevel < requiredLevel) {
        return res.status(403).json({ error: 'Plan upgrade required', code: 'plan_required', required_plan: minPlan });
      }

      req.company = company;
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
    const r = await pool.query(
      'SELECT plan, subscription_status, addon_qbo, trial_ends_at FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    const company = r.rows[0];
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
      req.company = company;
      return next();
    }

    return res.status(403).json({ error: 'QBO add-on required', code: 'qbo_required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

// Gate a route to the Certified Payroll add-on. Same trial/exempt bypass as
// requireProAddon; otherwise requires companies.addon_certified_payroll.
async function requireCertifiedPayrollAddon(req, res, next) {
  try {
    const r = await pool.query(
      'SELECT plan, subscription_status, addon_certified_payroll, trial_ends_at FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    const company = r.rows[0];
    if (!company) return res.status(403).json({ error: 'Company not found' });

    if (company.subscription_status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date()) {
      await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['trial_expired', req.user.company_id]);
      return res.status(403).json({ error: 'Trial expired', code: 'subscription_required' });
    }

    if (company.subscription_status === 'canceled' || company.subscription_status === 'trial_expired') {
      return res.status(403).json({ error: 'Subscription required', code: 'subscription_required' });
    }

    if (company.subscription_status === 'exempt' || company.subscription_status === 'trial' || company.addon_certified_payroll) {
      req.company = company;
      return next();
    }

    return res.status(403).json({ error: 'Certified Payroll add-on required', code: 'certified_payroll_required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}

async function requireTakeoffAddon(req, res, next) {
  try {
    const r = await pool.query(
      'SELECT plan, subscription_status, addon_takeoff, trial_ends_at FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    const company = r.rows[0];
    if (!company) return res.status(403).json({ error: 'Company not found' });

    if (company.subscription_status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date()) {
      await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['trial_expired', req.user.company_id]);
      return res.status(403).json({ error: 'Trial expired', code: 'subscription_required' });
    }

    if (company.subscription_status === 'canceled' || company.subscription_status === 'trial_expired') {
      return res.status(403).json({ error: 'Subscription required', code: 'subscription_required' });
    }

    if (company.subscription_status === 'exempt' || company.subscription_status === 'trial' || company.addon_takeoff) {
      req.company = company;
      return next();
    }

    return res.status(403).json({ error: 'Takeoff add-on required', code: 'takeoff_required' });
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
  requireAuth, requireAdmin, requireSuperAdmin, requirePlan, requireProAddon, requireCertifiedPayrollAddon, requireTakeoffAddon,
  hasAdminPermission, requirePermission,
  hasPerm, requirePerm,
};
