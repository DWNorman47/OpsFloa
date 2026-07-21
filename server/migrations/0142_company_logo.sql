-- Company logo, shown at the top-left of report / invoice / estimate PDFs.
--
-- One optional image per company, uploaded to R2 (folder `company-logos`); the
-- public URL is stored here and flows into the `companyInfo` prop every report
-- PDF already receives. Nullable free text (a URL) — not a fixed-value column, so
-- no docs/db-enums.md entry.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
