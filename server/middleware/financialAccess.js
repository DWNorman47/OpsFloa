const { hasPerm } = require('../permissions');

async function hasAnyPerm(req, keys) {
  for (const key of keys) {
    if (await hasPerm(req, key)) return true;
  }
  return false;
}

function requireAdminWithAnyPermission(keys, logMessage) {
  return async (req, res, next) => {
    try {
      if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'permission_denied',
          required_role: 'admin',
        });
      }
      if (!(await hasAnyPerm(req, keys))) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'permission_denied',
          required_any: keys,
        });
      }
      next();
    } catch (err) {
      req.log?.error({ err }, logMessage);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

const requireProjectFinancialAccess = requireAdminWithAnyPermission(
  ['view_projects', 'manage_projects', 'manage_project_visibility'],
  'project financial permission check failed'
);

const requireFinancialReportsAccess = requireAdminWithAnyPermission(
  ['view_analytics', 'manage_settings'],
  'financial reports permission check failed'
);

module.exports = {
  requireProjectFinancialAccess,
  requireFinancialReportsAccess,
};
