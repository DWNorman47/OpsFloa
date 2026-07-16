-- Meeting minutes for a recording.
--
-- Stored on `recordings` rather than in a table of its own because it's strictly
-- 1:1 — one recording, one set of minutes — and regenerating replaces rather
-- than appends. A child table would buy nothing but a join.
--
-- Note this is the first AI output OpsFloa persists. The office tools
-- (summarize / ask / draft / scan) are deliberately paste-in-read-out and store
-- nothing. Minutes are different in kind: a recap you can't find next week isn't
-- minutes, it's a summary. And the recording already stores its transcript, so
-- the content is retained here either way.

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS minutes_md TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS minutes_at TIMESTAMPTZ;
