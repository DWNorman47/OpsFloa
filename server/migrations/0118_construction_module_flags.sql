-- Sales, Subs, and Financial Reports became first-class modules with their own
-- admin visibility toggles (module_sales / module_subs / module_financial_reports).
-- Until now they had no feature flag and showed in the app switcher purely on
-- permissions, so they appeared even after an admin deselected related modules.
--
-- New companies default these OFF (see settingsDefaults.js). Existing companies
-- have been seeing these surfaces, so INSERT explicit '1' rows for any company
-- that doesn't already have one — making the in-code default change a no-op for
-- current customers. ON CONFLICT DO NOTHING preserves any explicit choice.

INSERT INTO settings (company_id, key, value)
SELECT c.id, m.key, '1'
FROM companies c
CROSS JOIN (VALUES
  ('module_sales'),
  ('module_subs'),
  ('module_financial_reports')
) AS m(key)
ON CONFLICT (company_id, key) DO NOTHING;
