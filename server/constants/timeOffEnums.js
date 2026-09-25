// Fixed-value columns of time_off_requests — see docs/db-enums.md.
// DB enforcement: chk_time_off_status (0219), chk_time_off_type (0071).

// pending → approved | denied (admin review); approved → revoked (admin revoke,
// with a reason). A worker can delete their own request only while pending.
const TIME_OFF_STATUSES = Object.freeze(['pending', 'approved', 'denied', 'revoked']);
const TIME_OFF_TYPES = Object.freeze(['vacation', 'sick', 'personal', 'other']);

module.exports = { TIME_OFF_STATUSES, TIME_OFF_TYPES };
