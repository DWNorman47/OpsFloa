-- Voice transcription tool (Tools module): upload an audio recording,
-- transcribe it via AssemblyAI with speaker diarization, and view a
-- "who said what" transcript.
--
-- recordings — one row per uploaded audio file. The audio itself lives in
-- R2 (audio_url) and size_bytes counts against company storage like all
-- other media. provider_job_id is the AssemblyAI transcript id that the
-- polling job (server/jobs/transcriptionPoller.js) uses to fetch results.
--
-- recording_utterances — one row per diarized speech turn ("Speaker A,
-- 00:12–00:31, said ..."). speaker holds the provider's letter label
-- ('A', 'B', ...); human display names are a per-recording JSONB mapping
-- on recordings.speaker_names so renaming a speaker is a single-row
-- update instead of rewriting every utterance.

CREATE TABLE IF NOT EXISTS recordings (
  id                SERIAL       PRIMARY KEY,
  company_id        UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id           INTEGER      REFERENCES users(id)    ON DELETE SET NULL,
  project_id        INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  title             VARCHAR(300),
  audio_url         TEXT         NOT NULL,
  size_bytes        BIGINT       NOT NULL DEFAULT 0,
  duration_seconds  INTEGER,
  status            VARCHAR(20)  NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'processing', 'completed', 'failed')),
  provider_job_id   VARCHAR(100),
  error_message     TEXT,
  speaker_names     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  language_code     VARCHAR(10),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recording_utterances (
  id            SERIAL   PRIMARY KEY,
  recording_id  INTEGER  NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  speaker       VARCHAR(10) NOT NULL,
  start_ms      INTEGER  NOT NULL,
  end_ms        INTEGER  NOT NULL,
  text          TEXT     NOT NULL,
  confidence    REAL
);

CREATE INDEX IF NOT EXISTS idx_recordings_company_created
  ON recordings(company_id, created_at DESC);

-- Partial index for the poller's sweep — normally zero or a handful of rows.
CREATE INDEX IF NOT EXISTS idx_recordings_processing
  ON recordings(id) WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_recording_utterances_recording
  ON recording_utterances(recording_id, start_ms);

-- Short-lived reservations for direct browser -> R2 uploads. A recording can
-- only be created from an upload row owned by the same tenant/user, which keeps
-- leaked public R2 URLs from being claimed across companies.
CREATE TABLE IF NOT EXISTS recording_uploads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             INTEGER  REFERENCES users(id) ON DELETE SET NULL,
  object_key          TEXT     NOT NULL UNIQUE,
  public_url          TEXT     NOT NULL UNIQUE,
  expected_size_bytes BIGINT   NOT NULL DEFAULT 0,
  content_type        VARCHAR(100) NOT NULL,
  claimed_at          TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recording_uploads_company_pending
  ON recording_uploads(company_id, expires_at)
  WHERE claimed_at IS NULL;
