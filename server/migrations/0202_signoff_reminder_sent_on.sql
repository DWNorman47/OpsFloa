-- Friday sign-off reminder: persist the per-company "already sent today" guard.
-- It used to be an in-memory Map, and startCron() runs the job on boot, so every
-- deploy/restart on a Friday re-pushed every worker. cron.js now claims the day
-- atomically (UPDATE ... WHERE signoff_reminder_sent_on IS DISTINCT FROM <local
-- date> RETURNING) before sending. Company-local calendar date; NULL = never.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS signoff_reminder_sent_on DATE;
