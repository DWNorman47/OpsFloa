-- Store the raw invoice share token (mirrors estimates), so POST /invoices/:id/link
-- can hand back the SAME link instead of rotating it. Now that POST /:id/send
-- emails the client the /i/<token> link, rotating the token on a later "copy link"
-- would silently break the link already in the client's inbox. The public lookup
-- still keys on response_token_hash; this column is admin-retrieval only.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS response_token VARCHAR(64);
