/**
 * Direct-message permission rules — the single source of truth for "may sender
 * message recipient?", reused by the send route and the contacts list.
 *
 * Layers (all must pass):
 *   - same company, both active, not self
 *   - sender is not globally muted (users.messaging_blocked)
 *   - recipient is not on the sender's per-person block list
 *     (users.messaging_blocked_user_ids)
 *   - company scope (worker_messaging_scope): admins may message anyone; a WORKER
 *     may message admins only unless scope is 'everyone', and not at all if 'off'.
 *
 * Pure function — callers load the two user rows + the scope string.
 */

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const isAdmin = (u) => ADMIN_ROLES.has(u?.role);

function canMessage(sender, recipient, { scope } = {}) {
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

  // Admins may message any active same-company user; scope only restricts workers.
  if (isAdmin(sender)) return { ok: true };

  const s = scope || 'admins_only';
  if (s === 'off') return { ok: false, reason: 'scope_off' };
  if (isAdmin(recipient)) return { ok: true }; // workers may always reach admins (admins_only + everyone)
  // recipient is a worker → only when the company opens messaging to everyone
  if (s === 'everyone') return { ok: true };
  return { ok: false, reason: 'scope_admins_only' };
}

module.exports = { canMessage, isAdmin };
