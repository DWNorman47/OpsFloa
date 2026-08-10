-- Direct (1:1) messages between two users, plus per-user messaging blocks.
--
-- company_chat (the shared worker↔admins thread) stays as-is for the "Admins"
-- recipient. direct_messages adds pairwise person-to-person conversations: a
-- conversation between A and B is every row where {sender_id, recipient_id} =
-- {A, B}. Who a WORKER may message is governed by the company setting
-- worker_messaging_scope (off | admins_only | everyone); admins may message any
-- active same-company user. See server/utils/messaging.js + routes/directMessages.js.

CREATE TABLE IF NOT EXISTS direct_messages (
  id           SERIAL PRIMARY KEY,
  company_id   UUID    NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT    NOT NULL,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversation + unread lookups (both directions of a pair).
CREATE INDEX IF NOT EXISTS idx_direct_messages_company_recipient_sender
  ON direct_messages (company_id, recipient_id, sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_direct_messages_company_sender_recipient
  ON direct_messages (company_id, sender_id, recipient_id, created_at);

-- Per-user messaging blocks.
--   messaging_blocked          = a global mute: this user may not send messages.
--   messaging_blocked_user_ids = specific people this user may not message
--                                (NULL/empty = no per-person blocks). Mirrors the
--                                NULL-means-unrestricted convention of
--                                users.worker_access_ids / projects.visible_to_user_ids.
ALTER TABLE users ADD COLUMN IF NOT EXISTS messaging_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS messaging_blocked_user_ids INTEGER[];

CREATE INDEX IF NOT EXISTS idx_users_messaging_blocked_user_ids
  ON users USING gin(messaging_blocked_user_ids);
