-- The work-item terminology is now fixed to "Work" (the module has explicit
-- Projects + Work Orders tabs), so label_work is no longer a customizable
-- company setting. Drop any stored values. Idempotent (a no-op if none exist).

DELETE FROM settings WHERE key = 'label_work';
