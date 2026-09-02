-- CHECK the fixed-value field_report_photos.media_type (was app-only, no CHECK, undocumented —
-- see the CLAUDE.md fixed-value-column rule). NOT VALID so a stray legacy value can't fail boot;
-- the constraint still enforces every new/updated row. Allowed set mirrors
-- server/constants/fieldReportEnums.js (FIELD_REPORT_MEDIA_TYPES).
-- Guarded so it's re-runnable and coexists with schema.sql declaring the same constraint
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_report_photos_media_type_check') THEN
    ALTER TABLE field_report_photos
      ADD CONSTRAINT field_report_photos_media_type_check
      CHECK (media_type IS NULL OR media_type IN ('photo','video')) NOT VALID;
  END IF;
END $$;
