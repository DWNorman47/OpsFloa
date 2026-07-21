-- Store the raw estimate share/accept token, not just its hash.
--
-- /send generated a random token, stored only its sha256 (response_token_hash),
-- and returned the raw token exactly once. That made the client-facing link
-- (/e/<token>) unrecoverable: reload the page and there was no way to get it
-- again. Keep the hash for the public-route lookups; add the raw token so an
-- admin can retrieve the same link later (POST /estimates/:id/link). Nullable —
-- estimates sent before this column mint a fresh token on first retrieval.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS response_token TEXT;
