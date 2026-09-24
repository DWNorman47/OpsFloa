/**
 * Effective-dated rate history API (migration 0209) — mounted at /api/admin.
 *
 *   GET    /workers/:id/rate-history                  list (+ current cache, today)
 *   POST   /workers/:id/rate-history                  add { rate, rate_type?, effective_date?, note?, confirm_locked? }
 *   DELETE /workers/:id/rate-history/:rowId           delete (never the last row)
 *   … the same under /projects/:id/prevailing-rate-history and
 *   /company/default-rate-history and /company/prevailing-rate-history (0210).
 *
 * Editing a row = delete + add (an add on an existing date replaces that row).
 * Permissions match editing that rate today: manage_workers (+ the admin's worker
 * scope, + view_worker_wages to read a worker's rates), manage_projects,
 * manage_settings. Every change is audit-logged.
 *
 * Backdating is allowed (any past date, any future date). A change / delete whose
 * span reaches a LOCKED pay period returns 409 { code: 'locked_periods',
 * locked_periods } unless the body carries confirm_locked: true — the UI shows
 * the periods and asks for an explicit confirm.
 */
const router = require('express').Router();
const pool = require('../db');
const { requireAdmin, requirePerm, hasPerm } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const store = require('../utils/rateHistoryStore');

function workerInScope(req, targetId) {
  const ids = req.user.worker_access_ids;
  return !ids || !ids.length || ids.map(Number).includes(Number(targetId));
}

const truthy = v => v === true || v === 'true' || v === '1' || v === 1;
const confirmFlag = req => truthy(req.body && req.body.confirm_locked) || truthy(req.query && req.query.confirm_locked);

// Owner resolution per kind: { ownerId, name } or an HTTP error.
async function resolveOwner(kind, req) {
  const companyId = req.user.company_id;
  if (kind === 'company') return { ownerId: companyId, name: 'Company default rate' };
  if (kind === 'company_prevailing') return { ownerId: companyId, name: 'Company prevailing wage rate' };
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, error: 'Invalid id' };
  if (kind === 'worker') {
    if (!workerInScope(req, id)) return { status: 403, error: 'Not authorized for this worker' };
    const r = await pool.query('SELECT id, full_name FROM users WHERE id = $1 AND company_id = $2', [id, companyId]);
    if (!r.rows || !r.rows.length) return { status: 404, error: 'Worker not found' };
    return { ownerId: id, name: r.rows[0].full_name };
  }
  const r = await pool.query('SELECT id, name FROM projects WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!r.rows || !r.rows.length) return { status: 404, error: 'Project not found' };
  return { ownerId: id, name: r.rows[0].name };
}

function mount(kind, path, perm, { readPerm = null } = {}) {
  const k = store.KINDS[kind];
  const gate = [requireAdmin, requirePerm(perm)];

  router.get(path, ...gate, async (req, res) => {
    try {
      if (readPerm && !(await hasPerm(req, readPerm))) return res.status(403).json({ error: 'Insufficient permissions', code: 'permission_denied', required: readPerm });
      const o = await resolveOwner(kind, req);
      if (o.error) return res.status(o.status).json({ error: o.error });
      const companyId = req.user.company_id;
      const [history, current, today] = await Promise.all([
        store.listHistory(kind, companyId, o.ownerId),
        store.readCache(kind, companyId, o.ownerId),
        store.companyToday(companyId),
      ]);
      res.json({ history, current, today });
    } catch (err) {
      req.log?.error({ err }, 'rate history list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post(path, ...gate, async (req, res) => {
    try {
      const o = await resolveOwner(kind, req);
      if (o.error) return res.status(o.status).json({ error: o.error });
      const companyId = req.user.company_id;
      const today = await store.companyToday(companyId);
      const v = store.validateChange(kind, req.body, today);
      if (v.error) return res.status(400).json({ error: v.error });
      const out = await store.addChange(kind, { companyId, ownerId: o.ownerId, change: v.value, confirmLocked: confirmFlag(req), createdBy: req.user.id, today });
      if (out.conflict) return res.status(409).json(out.conflict);
      await logAudit(companyId, req.user.id, req.user.full_name, `${k.auditAction}.added`, k.entityType, store.isCompanyKind(kind) ? null : o.ownerId, o.name, {
        rate: v.value.rate, ...(kind === 'worker' ? { rate_type: out.rows.find(r => r.effective_date === v.value.effectiveDate)?.rate_type } : {}),
        effective_date: v.value.effectiveDate, note: v.value.note, previous: out.previous,
        backdated: v.value.effectiveDate < today, locked_periods_affected: out.lockedPeriods.length,
      });
      res.status(201).json({ history: out.rows, current: out.cache, today, locked_periods: out.lockedPeriods });
    } catch (err) {
      req.log?.error({ err }, 'rate history add error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.delete(`${path}/:rowId`, ...gate, async (req, res) => {
    try {
      const o = await resolveOwner(kind, req);
      if (o.error) return res.status(o.status).json({ error: o.error });
      const companyId = req.user.company_id;
      const rowId = parseInt(req.params.rowId, 10);
      if (!Number.isInteger(rowId)) return res.status(400).json({ error: 'Invalid row id' });
      const today = await store.companyToday(companyId);
      const out = await store.deleteChange(kind, { companyId, ownerId: o.ownerId, rowId, confirmLocked: confirmFlag(req), today });
      if (out.notFound) return res.status(404).json({ error: 'Rate history row not found' });
      if (out.lastRow) return res.status(409).json({ error: 'Cannot delete the only rate on record — add a new rate instead.', code: 'last_rate_row' });
      if (out.conflict) return res.status(409).json(out.conflict);
      await logAudit(companyId, req.user.id, req.user.full_name, `${k.auditAction}.deleted`, k.entityType, store.isCompanyKind(kind) ? null : o.ownerId, o.name, {
        deleted: { rate: out.deleted.rate, rate_type: out.deleted.rate_type, effective_date: out.deleted.effective_date, note: out.deleted.note },
        locked_periods_affected: out.lockedPeriods.length,
      });
      res.json({ history: out.rows, current: out.cache, today, locked_periods: out.lockedPeriods });
    } catch (err) {
      req.log?.error({ err }, 'rate history delete error');
      res.status(500).json({ error: 'Server error' });
    }
  });
}

mount('worker', '/workers/:id/rate-history', 'manage_workers', { readPerm: 'view_worker_wages' });
mount('project', '/projects/:id/prevailing-rate-history', 'manage_projects');
mount('company', '/company/default-rate-history', 'manage_settings');
mount('company_prevailing', '/company/prevailing-rate-history', 'manage_settings');

module.exports = router;
