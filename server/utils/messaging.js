/**
 * Direct-message permission rules — the single source of truth for "may sender
 * message recipient?", reused by the send route and the contacts list.
 *
 * Layers (all must pass):
 *   - same company, both active, not self
 *   - sender is not globally muted (users.messaging_blocked)
 *   - recipient is not on the sender's per-person block list
 *     (users.messaging_blocked_user_ids)
 *   - company toggles: admins may message anyone; a WORKER may DM individual
 *     admins only when `dmAdmins` (worker_dm_admins) is on, and other workers only
 *     when `dmWorkers` (worker_dm_workers) is on. (Both default off — a worker then
 *     has only the shared "Admins" company_chat thread, which these don't govern.)
 *
 * Pure function — callers load the two user rows + the two flags.
 */

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const isAdmin = (u) => ADMIN_ROLES.has(u?.role);

function canMessage(sender, recipient, { dmAdmins = false, dmWorkers = false } = {}) {
  if (!sender || !recipient) return { ok: false, reason: 'not_found' };
  if (!recipient.active) return { ok: false, reason: 'inactive' };
  if (String(sender.company_id) !== String(recipient.company_id)) return { ok: false, reason: 'cross_company' };
  if (sender.id === recipient.id) return { ok: false, reason: 'self' };

  // A globally-muted sender can't send to anyone.
  if (sender.messaging_blocked) return { ok: false, reason: 'muted' };

  // Per-person block (directional: recipient is on the sender's block list).
  const blocked = sender.messaging_blocked_user_ids;
  if (Array.isArray(blocked) && blocked.map(Number).includes(Number(recipient.id))) {
    return { ok: false, reason: 'blocked' };
  }

  // Admins may message any active same-company user; the toggles only gate workers.
  if (isAdmin(sender)) return { ok: true };

  if (isAdmin(recipient)) return dmAdmins ? { ok: true } : { ok: false, reason: 'dm_admins_off' };
  return dmWorkers ? { ok: true } : { ok: false, reason: 'dm_workers_off' };
}

module.exports = { canMessage, isAdmin };
