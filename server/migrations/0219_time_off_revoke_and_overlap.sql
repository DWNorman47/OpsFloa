-- Time off: admin "revoke approval" + overlap lookups (routes/timeOff.js).
--
-- 1. time_off_requests.status gains 'revoked': an admin can undo an APPROVED request
--    (PATCH /time-off/:id/revoke) with a reason. Revoked rows stay for the record but
--    are no longer paid (the pay loaders only read status = 'approved') and don't
--    block new requests on the same days. Allowed set: server/constants/timeOffEnums.js
--    + docs/db-enums.md.
-- 2. Who/when/why of a revoke.
-- 3. Partial index for the overlap check run on every submit / approve (a worker's
--    pending + approved requests by date).

ALTER TABLE time_off_requests DROP CONSTRAINT IF EXISTS chk_time_off_status;
ALTER TABLE time_off_requests
  ADD CONSTRAINT chk_time_off_status
  CHECK (status IN ('pending', 'approved', 'denied', 'revoked'));

ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS revoked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS revoked_at    TIMESTAMPTZ;
ALTER TABLE time_off_requests ADD COLUMN IF NOT EXISTS revoke_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_time_off_active_dates
  ON time_off_requests (company_id, user_id, start_date, end_date)
  WHERE status IN ('pending', 'approved');
