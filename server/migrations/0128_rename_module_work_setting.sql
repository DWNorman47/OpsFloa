-- Rename the Work module's on/off setting key: module_projects → module_work,
-- so existing companies keep their toggle after the code-side rename.
--
-- Idempotent: only renames rows still on the old key, and skips any company that
-- somehow already has module_work (guards the (company_id, key) primary key).
-- The trailing DELETE cleans up any stale old-key row left behind in that rare
-- both-exist case. Re-running is a no-op once no module_projects rows remain.

UPDATE settings
   SET key = 'module_work'
 WHERE key = 'module_projects'
   AND NOT EXISTS (
     SELECT 1 FROM settings s2
      WHERE s2.company_id = settings.company_id AND s2.key = 'module_work'
   );

DELETE FROM settings WHERE key = 'module_projects';
