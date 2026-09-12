-- Super-admin Mail page (/mail): user-defined tabs that route mail by
-- sender. A tab belongs to one opsfloa account view and holds a list of
-- sender addresses/domains; the message list shows a tab's senders in
-- that tab INSTEAD of the inbox (the inbox query excludes every tab's
-- senders, a tab query includes only its own). Pure view config — no
-- message state lives here, so deleting a tab just returns its mail to
-- the inbox view. senders is a JSONB array of lowercased strings,
-- validated app-side (no fixed value set — not a db-enums.md column).

CREATE TABLE IF NOT EXISTS mailbox_tabs (
  id          SERIAL       PRIMARY KEY,
  account     TEXT         NOT NULL,
  name        VARCHAR(40)  NOT NULL,
  senders     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  position    INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mailbox_tabs_account
  ON mailbox_tabs(account, position, id);
