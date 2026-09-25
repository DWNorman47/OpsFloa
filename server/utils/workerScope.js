// Partial-admin worker scoping (users.worker_access_ids), shared by the routes
// outside admin.js. Same contract as admin.js `workerInScope`: no restriction set
// (null / empty) → full access; otherwise the target worker must be in the list.

function workerAccessIds(req) {
  const ids = req && req.user && req.user.worker_access_ids;
  return Array.isArray(ids) && ids.length ? ids.map(Number).filter(n => Number.isFinite(n)) : null;
}

function workerInScope(req, targetId) {
  const ids = workerAccessIds(req);
  return !ids || ids.includes(Number(targetId));
}

const DENY_WORKER = { error: 'Not authorized for this worker', code: 'worker_not_in_scope' };

module.exports = { workerAccessIds, workerInScope, DENY_WORKER };
