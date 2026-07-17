-- Make subcontractor document expiry actually do something.
--
-- `subcontractor_documents.expires_on` has existed since 0107 and is WRITE-ONLY:
-- it's collected on upload, rendered once on the Subs page, and queried by
-- nothing. No index, no cron, no alert. So a sub's COI lapses silently and the
-- GC finds out when something goes wrong — which is the entire reason to track
-- the date at all.
--
-- Two stamps rather than one because the two alerts are different events: a
-- heads-up before it lapses is a scheduling problem; one that has already lapsed
-- is a "that sub should not be on site" problem, and it must fire even if the
-- warning already went out.
--
-- No re-arm logic is needed: documents have no PATCH route (you delete and
-- re-upload), so a replacement is a new row with NULL stamps.

ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS expiring_alert_at TIMESTAMPTZ;
ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS expired_alert_at  TIMESTAMPTZ;

-- The job scans by date across all of a company's subs; partial because most
-- rows (w9s, contracts) never carry an expiry.
CREATE INDEX IF NOT EXISTS idx_subdocs_expires
  ON subcontractor_documents (expires_on)
  WHERE expires_on IS NOT NULL;
