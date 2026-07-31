-- Add 'unpaid' to the users.worker_type CHECK. An 'unpaid' team member is tracked
-- (time clock, scheduling, reports) but excluded from every pay surface — see
-- server/constants/userEnums.js and the buildPayStatement guard. Drop + re-add the
-- constraint from 0071 (idempotent; existing rows already hold valid values).
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_worker_type;
ALTER TABLE users
  ADD CONSTRAINT chk_users_worker_type
  CHECK (worker_type IN ('employee', 'contractor', 'subcontractor', 'owner', 'unpaid'));
