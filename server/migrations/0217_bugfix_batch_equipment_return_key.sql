-- Equipment return idempotency (routes/equipment.js POST /:id/return).
-- A return now names the checkout it closes (checkout_id) and records the service worker's
-- Idempotency-Key here, so an offline replay of a return that already went through gets the
-- same row back (200) instead of a 409 "Already returned", and can never close a LATER
-- checkout of the same asset. Partial unique index so legacy NULL rows never collide.
-- Free-text key → not a db-enums column.
ALTER TABLE equipment_checkouts ADD COLUMN IF NOT EXISTS return_request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_checkouts_return_request
  ON equipment_checkouts (company_id, return_request_id) WHERE return_request_id IS NOT NULL;
