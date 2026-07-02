-- Tools is a first-class app switcher module. Existing companies receive it
-- enabled so deploys do not hide a newly-added utility unexpectedly.

INSERT INTO settings (company_id, key, value)
SELECT id, 'module_tools', '1'
FROM companies
ON CONFLICT (company_id, key) DO NOTHING;
