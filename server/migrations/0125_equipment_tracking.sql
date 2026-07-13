-- Equipment tracking: extend the asset registry with custody (check-out/return),
-- rentals, and maintenance-service logs. Builds on equipment_items/equipment_hours
-- from 0008 (registry + usage-hours). Custody and service logs are new and
-- orthogonal to the engine-hours usage log. Idempotent (IF NOT EXISTS / DROP+ADD).

-- ── Extend the registry (equipment_items exists from 0008; updated_at from 0073) ──
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS status                  VARCHAR(20)  NOT NULL DEFAULT 'available';
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS kind                    VARCHAR(30);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS serial_number           VARCHAR(120);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS purchase_date           DATE;
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS purchase_cost           DECIMAL(12,2);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS photo_url               TEXT;
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS is_rental               BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS rental_vendor           VARCHAR(255);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS rental_rate             DECIMAL(12,2);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS rental_rate_unit        VARCHAR(10);
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS rental_return_due        DATE;
ALTER TABLE equipment_items ADD COLUMN IF NOT EXISTS rental_reminder_sent_at TIMESTAMP;

ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS chk_equipment_items_status;
ALTER TABLE equipment_items ADD  CONSTRAINT chk_equipment_items_status
  CHECK (status IN ('available','checked_out','maintenance','retired'));
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS chk_equipment_items_kind;
ALTER TABLE equipment_items ADD  CONSTRAINT chk_equipment_items_kind
  CHECK (kind IS NULL OR kind IN ('heavy','vehicle','trailer','power_tool','hand_tool','safety','other'));
ALTER TABLE equipment_items DROP CONSTRAINT IF EXISTS chk_equipment_items_rate_unit;
ALTER TABLE equipment_items ADD  CONSTRAINT chk_equipment_items_rate_unit
  CHECK (rental_rate_unit IS NULL OR rental_rate_unit IN ('day','week','month'));

-- ── Custody: who has an asset out. At most one OPEN row per asset. ──
CREATE TABLE IF NOT EXISTS equipment_checkouts (
  id                      SERIAL PRIMARY KEY,
  asset_id                INTEGER   NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
  company_id              UUID      NOT NULL,  -- no FK: companies.id may be INTEGER on some environments
  user_id                 INTEGER   REFERENCES users(id) ON DELETE SET NULL,     -- current holder
  project_id              INTEGER   REFERENCES projects(id) ON DELETE SET NULL,
  checked_out_by          INTEGER   REFERENCES users(id) ON DELETE SET NULL,     -- who recorded it
  checked_out_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  due_at                  DATE,
  returned_at             TIMESTAMP,
  return_reminder_sent_at TIMESTAMP,
  checkout_photo_url      TEXT,
  return_photo_url        TEXT,
  notes                   TEXT,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_equipment_checkouts_asset   ON equipment_checkouts (asset_id);
CREATE INDEX IF NOT EXISTS idx_equipment_checkouts_company ON equipment_checkouts (company_id);
-- Integrity guard: a single open custody row per asset (blocks double-checkout races).
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_checkout_open
  ON equipment_checkouts (asset_id) WHERE returned_at IS NULL;

-- ── Discrete service/repair/inspection records (distinct from the usage-hours log). ──
CREATE TABLE IF NOT EXISTS equipment_maintenance_logs (
  id           SERIAL PRIMARY KEY,
  asset_id     INTEGER      NOT NULL REFERENCES equipment_items(id) ON DELETE CASCADE,
  company_id   UUID         NOT NULL,  -- no FK: same reason
  log_date     DATE         NOT NULL,
  kind         VARCHAR(20)  NOT NULL DEFAULT 'service'
                 CHECK (kind IN ('service','repair','inspection','other')),
  notes        TEXT,
  cost         DECIMAL(12,2),
  performed_by VARCHAR(255),
  created_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_asset   ON equipment_maintenance_logs (asset_id);
CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_company ON equipment_maintenance_logs (company_id);
