/**
 * Fixed-value vocabulary for the internal messaging system.
 *
 * worker_messaging_scope (settings.value) governs who a WORKER may direct-message:
 *   off         — workers can't start messages at all
 *   admins_only — workers can message admins/managers only (default)
 *   everyone     — workers can message admins AND any other active team member
 * Admins can always message any active same-company user; the scope only
 * restricts workers. See server/utils/messaging.js + docs/db-enums.md.
 */

const WORKER_MESSAGING_SCOPES = Object.freeze(['off', 'admins_only', 'everyone']);
const WORKER_MESSAGING_SCOPE_DEFAULT = 'admins_only';

module.exports = { WORKER_MESSAGING_SCOPES, WORKER_MESSAGING_SCOPE_DEFAULT };
