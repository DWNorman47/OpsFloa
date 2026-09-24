-- Server-side read markers for admins on worker company_chat threads.
--
-- Admin unread used to be "thread last_at > a client-clock localStorage timestamp": an admin's
-- own reply (or another admin's) marked the thread unread, clock skew broke it, and it never
-- synced across devices. Now each admin has, per worker thread, the highest company_chat.id
-- they've seen (ids, not clocks). Unread = messages SENT BY THE WORKER with id > last_read_id.
-- See server/routes/chat.js (GET /api/chat list → `unread`, thread fetch / admin reply → marker).
CREATE TABLE IF NOT EXISTS company_chat_reads (
  company_id   UUID        NOT NULL,
  admin_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id INTEGER     NOT NULL DEFAULT 0,
  read_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_company_chat_reads_company ON company_chat_reads (company_id);

-- Thread fetches now read the NEWEST page (ORDER BY id DESC LIMIT n) per worker.
CREATE INDEX IF NOT EXISTS idx_company_chat_company_worker_id ON company_chat (company_id, worker_id, id);
