-- Add DB-level CHECK constraints to two fixed-value columns that were app-validated only
-- (bypassable by raw SQL / webhooks / future endpoints — see the CLAUDE.md fixed-value rule).
-- Added NOT VALID so a stray legacy value can't fail server boot; the constraint still
-- enforces every new/updated row. Allowed sets mirror the app's own validators.
--
-- client_documents.doc_type   — app set in server/routes/admin.js (CLIENT_DOCUMENT_TYPES)
-- inventory_locations.type     — app set in server/constants/inventoryEnums.js (INVENTORY_LOCATION_TYPES)

ALTER TABLE client_documents
  ADD CONSTRAINT client_documents_doc_type_check
  CHECK (doc_type IS NULL OR doc_type IN ('w9','w2','coi','contract','license','other')) NOT VALID;

ALTER TABLE inventory_locations
  ADD CONSTRAINT inventory_locations_type_check
  CHECK (type IS NULL OR type IN ('warehouse','job_site','truck','other')) NOT VALID;
