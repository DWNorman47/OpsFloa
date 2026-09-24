-- POST/PATCH /admin/shifts used to store any project_id without checking it belonged to
-- the admin's company, so a shift could point at ANOTHER tenant's project (and the
-- project_name join then leaked that tenant's project name via /admin and /mine). The
-- routes now validate project_id (projectBelongsToCompany) and every join is scoped to
-- the shift's company; this clears any cross-tenant reference already written.
-- Idempotent: a re-run matches nothing.
UPDATE shifts s
   SET project_id = NULL
 WHERE s.project_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.company_id = s.company_id
   );
