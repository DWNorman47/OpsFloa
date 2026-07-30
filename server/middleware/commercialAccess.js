const { hasPerm } = require('../permissions');

// Sales and subcontractor procurement are nested under Projects in the client.
// Keep the server gate aligned with the existing UI contract until dedicated
// commercial permissions are introduced.
async function requireCommercialAccess(req, res, next) {
  try {
    if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'permission_denied',
        required_role: 'admin',
      });
    }
    const allowed =
      await hasPerm(req, 'manage_projects') ||
      await hasPerm(req, 'manage_settings');
    if (!allowed) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'permission_denied',
        required_any: ['manage_projects', 'manage_settings'],
      });
    }
    next();
  } catch (err) {
    req.log?.error({ err }, 'commercial permission check failed');
    res.status(500).json({ error: 'Permission check failed' });
  }
}

module.exports = { requireCommercialAccess };
