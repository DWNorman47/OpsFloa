-- An explicit contract (sell) value per project, so a hand-created project
-- (no estimate) has real revenue to measure margin against. Without it,
-- contractValueCents falls back to the budget sum, making projected/bid margin
-- always ~0 or negative on manual jobs. Nullable: estimate-converted projects
-- keep reading their accepted-estimate total unless this is set. Idempotent.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS contract_value_cents BIGINT
    CHECK (contract_value_cents IS NULL OR contract_value_cents >= 0);
