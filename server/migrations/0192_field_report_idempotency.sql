-- Idempotency key for field reports so an OFFLINE-queued POST that gets replayed on reconnect
-- (its original response was lost) doesn't create a second report + re-upload the same photos +
-- double-count storage. The client sends a stable client_request_id per submission; the server
-- dedups on it. Partial unique index so legacy NULL rows never collide.
ALTER TABLE field_reports ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_field_reports_client_request
  ON field_reports (company_id, client_request_id) WHERE client_request_id IS NOT NULL;
