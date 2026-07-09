-- Office AI tools (Tools module): a per-company monthly usage counter for the
-- Claude-backed tools (Summarizer, Document Q&A, Email drafter).
--
-- office_ai_usage — one row per company per calendar month. The office routes
-- increment `count` on each AI call and reject once it passes
-- OFFICE_AI_MONTHLY_LIMIT, so a flat-priced pack can't be run up by heavy use.
-- Only a tally is stored — no request content.

CREATE TABLE IF NOT EXISTS office_ai_usage (
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period      TEXT        NOT NULL,            -- calendar month, 'YYYY-MM'
  count       INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, period)
);
