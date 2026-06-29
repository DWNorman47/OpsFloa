-- Optional public-facing company profile pages.
--
-- These rows are intentionally separate from internal company, customer,
-- project, payroll, and field records. Public endpoints should only expose
-- fields saved here and explicitly marked public.

CREATE TABLE IF NOT EXISTS company_public_profiles (
  company_id             UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  display_name           VARCHAR(255),
  short_description      TEXT,
  services_offered       JSONB NOT NULL DEFAULT '[]'::jsonb,
  service_areas          JSONB NOT NULL DEFAULT '[]'::jsonb,
  license_info           TEXT,
  equipment_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_types          JSONB NOT NULL DEFAULT '[]'::jsonb,
  quote_instructions     TEXT,
  contact_info           JSONB NOT NULL DEFAULT '{}'::jsonb,
  faq_items              JSONB NOT NULL DEFAULT '[]'::jsonb,
  photos                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_public              BOOLEAN NOT NULL DEFAULT false,
  published_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_public_profiles_public
  ON company_public_profiles(company_id)
  WHERE is_public = true;
