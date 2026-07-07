-- Video transcription: recordings can now be video files (mp4, mov, mkv,
-- avi, 3gp, webm). AssemblyAI extracts the audio track itself, so video is
-- only *staged* in R2 — once the transcript completes, the poller deletes
-- the file and refunds the company's storage. Audio files are kept for
-- in-transcript playback as before.
--
-- media_kind       — 'audio' | 'video', derived from the upload content type
--                    at claim time. Drives the delete-after-transcription
--                    behaviour and the client's player rendering.
-- media_deleted_at — set exactly once when the staged file has been removed
--                    from R2 and its bytes refunded; guards against double
--                    refunds (poller vs DELETE route).

ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS media_kind VARCHAR(10) NOT NULL DEFAULT 'audio',
  ADD COLUMN IF NOT EXISTS media_deleted_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recordings_media_kind_check'
  ) THEN
    ALTER TABLE recordings
      ADD CONSTRAINT recordings_media_kind_check
      CHECK (media_kind IN ('audio', 'video'));
  END IF;
END $$;
