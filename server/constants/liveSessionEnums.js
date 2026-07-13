/**
 * Fixed-value enums for the `live_sessions` table (plan-tools live collab).
 * See `docs/db-enums.md` for the full registry.
 *
 * `tool` = which plan tool hosts the session (the generic session layer syncs
 * opaque JSON, so Plan Room ships first and the takeoffs can flip on later).
 * `status` = active until the host ends it or the idle sweeper closes it.
 */

const LIVE_SESSION_TOOLS = Object.freeze(['planroom', 'sitework', 'roofing']);
const LIVE_SESSION_TOOL_DEFAULT = 'planroom';

const LIVE_SESSION_STATUSES = Object.freeze(['active', 'ended']);
const LIVE_SESSION_STATUS_DEFAULT = 'active';

module.exports = {
  LIVE_SESSION_TOOLS,
  LIVE_SESSION_TOOL_DEFAULT,
  LIVE_SESSION_STATUSES,
  LIVE_SESSION_STATUS_DEFAULT,
};
