---
name: project_email_resend
description: "Email is sent via Resend (SendGrid dropped ~2026-07-02 when its trial ended); config + how it's wired"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
---

As of 2026-07-02 all outgoing email goes through **Resend**, not SendGrid.
SendGrid was dropped because its trial ended and the post-trial free tier no
longer sends (and upgrading required a 72h compliance review).

- Single transport lives in `server/email.js` (`sendEmail`), which uses the
  `resend` package. `@sendgrid/mail` is removed.
- `auth.js` / `admin.js` (register / verify / reset / invite) previously
  bypassed email.js with their own SendGrid sender; they now go through a thin
  adapter onto `sendEmail()` that re-throws on failure (preserves the
  registration rollback + invite `email_sent` flag).
- **To actually send**, set on Render: `RESEND_API_KEY`, `EMAIL_FROM`
  (its domain must be **verified in Resend via DNS**), and `NODE_ENV=production`
  (otherwise `EMAIL_MODE` defaults to `redirect` and all mail goes to
  `EMAIL_REDIRECT_TO`). Email no-ops with a warning if `RESEND_API_KEY` is unset
  — it is intentionally NOT in `index.js` REQUIRED_ENV, so the app still boots.
- **`RESEND_WEBHOOK_SECRET`** (added 2026-07-16) — the signing secret for
  `POST /api/resend-events`, the bounce feed. Create the webhook in Resend →
  Webhooks pointed at `https://<server>/api/resend-events`, subscribed to
  `email.bounced` + `email.complained`. **Without it the route 503s and no bounce
  is ever recorded.** ⚠️ As of 2026-07-16 this was still owed on Render.
- Bounce tracking: **fixed 2026-07-16** (`routes/resendEvents.js`,
  `services/emailSuppression.js`, commit `458d920`). Only a **Permanent** bounce
  suppresses — Transient means a full mailbox. Suppressions are now reversible
  two ways (edit the address, or an explicit retry) and visible as a red banner
  on the worker card. `routes/sendgridEvents.js` survives, deprecated; delete it
  once Render confirms nothing posts to it.

⚠️ **A lesson worth more than the fix.** The line above used to read *"Follow-up
not yet done: sendgridEvents.js is now inert; wire Resend webhooks to restore
bounce tracking."* **It was written 2026-07-02 and sat for 14 days**, while the
app kept mailing addresses it knew were dead. Nothing resurfaced it — a
follow-up recorded only in a memory has no owner and no date, so it isn't
tracked, it's just remembered. **Park follow-ups in `docs/BACKLOG.md`** where
David actually reads them ([[project_backlog_doc]]); a memory can note that
they exist, but it can't be the only place they live.

And the note only caught half of it. It knew the webhook was inert; it did not
know that **nothing ever cleared `email_bounced_at`**, so anyone flagged in the
SendGrid era was silently unreachable forever. The half that strands real people
was the half nobody wrote down.

See also [[project_infrastructure]].
