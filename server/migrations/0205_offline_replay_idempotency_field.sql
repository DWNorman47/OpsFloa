-- Offline-replay idempotency keys for the remaining service-worker-queued create endpoints
-- (same pattern as 0201 for punchlist/incidents). The SW stamps every queueable POST under
-- /api/safety-talks, /api/equipment, /api/rfis, /api/sub-reports and /api/inspections with an
-- Idempotency-Key header before the first attempt; if the server saved the row but the response
-- was lost, the queued replay carries the SAME key and the route returns the existing row
-- instead of inserting a duplicate.
-- Not keyed (naturally idempotent or not a create): safety-talk sign-off (unique on
-- talk_id+worker_id), equipment return (UPDATE of the open checkout).
-- Partial unique indexes so legacy NULL rows never collide. Free-text key → not a db-enums column.
ALTER TABLE safety_talks ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_safety_talks_client_request
  ON safety_talks (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_items_client_request
  ON equipment_items (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE equipment_hours ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_hours_client_request
  ON equipment_hours (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE equipment_checkouts ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_checkouts_client_request
  ON equipment_checkouts (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE equipment_maintenance_logs ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_maintenance_logs_client_request
  ON equipment_maintenance_logs (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE rfis ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rfis_client_request
  ON rfis (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE sub_reports ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_reports_client_request
  ON sub_reports (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE inspections ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inspections_client_request
  ON inspections (company_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE inspection_templates ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inspection_templates_client_request
  ON inspection_templates (company_id, client_request_id) WHERE client_request_id IS NOT NULL;
