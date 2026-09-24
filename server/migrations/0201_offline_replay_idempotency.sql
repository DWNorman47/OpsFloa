-- Idempotency keys for the remaining offline-queued create endpoints (punchlist items and
-- incident reports). The service worker stamps every queueable POST with an Idempotency-Key
-- header BEFORE the first network attempt; if the server saved the row but the response was
-- lost (timeout / dropped connection), the request is queued and replayed later with the SAME
-- key, and the route returns the existing row instead of inserting a duplicate.
-- (time_entries already dedups on (user_id, client_id); field_reports on client_request_id — 0192.
-- daily_reports is a natural upsert on (company, project, date), so it needs no key.)
-- Partial unique indexes so legacy NULL rows never collide. Free-text key → not a db-enums column.
ALTER TABLE punchlist_items ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_punchlist_items_client_request
  ON punchlist_items (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_reports_client_request
  ON incident_reports (company_id, client_request_id) WHERE client_request_id IS NOT NULL;
