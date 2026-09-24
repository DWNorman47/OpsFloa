-- migrate:no-transaction (manages its own BEGIN/COMMIT)
-- Time Clock / Workforce route rename: rewrite stored inbox.link URLs so
-- pre-rename notifications still deep-link to the right tab after the deploy.
--
-- Worker rows had /dashboard; admin rows had /timeclock or /admin. The new
-- model:
--   /timeclock = participating page (worker + admin self-time) — was /dashboard
--   /workforce = admin oversight page                          — was /timeclock or /admin
--
-- Order matters: rewrite the OLD admin /timeclock to /workforce FIRST, then
-- the worker /dashboard to /timeclock. If we did it the other way around,
-- the worker rows would land at /timeclock and then get rewritten again to
-- /workforce, sending workers to the admin page they can't see.
--
-- Wrap in a single transaction so a partial run can't leave the table in a
-- half-renamed state.

BEGIN;

UPDATE inbox SET link = REPLACE(link, '/timeclock', '/workforce')
WHERE link LIKE '/timeclock%';

UPDATE inbox SET link = REPLACE(link, '/admin#', '/workforce#')
WHERE link LIKE '/admin#%';

UPDATE inbox SET link = REPLACE(link, '/dashboard', '/timeclock')
WHERE link LIKE '/dashboard%';

COMMIT;
