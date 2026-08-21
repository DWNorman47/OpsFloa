# OpsFloa Password Tool — design

A browser extension + OpsFloa add-on that generates strong passwords, optionally
saves them to a **zero-knowledge** vault, categorizes them, and optionally shares
one (one-time link, or an offline-decryptable encrypted email). Started 2026-08-20.

## Decisions locked with David (2026-08-20)
- **Vault = zero-knowledge**, with a stored plaintext **master-password hint** field.
  The server (and we) only ever see ciphertext. Trade-off David accepted: forget the
  master password → entries are unrecoverable (the hint is the only aid).
- **Sharing = two optional paths:**
  - **One-time secret link** (auth-gated, view-once, then burns).
  - **Encrypted email payload** that decrypts **offline with only the encryption
    password** — no app, no server, no DB call. Email carries the ciphertext + plain
    instructions + a self-contained offline decryptor (a static HTML file / page that
    is pure crypto, fetches nothing). "As long as the encryption password is known,
    the info is easy to get."
- **No hand-rolled crypto.** WebCrypto only: PBKDF2-SHA256 (≥600k iters) → AES-256-GCM.
  (Argon2id would be stronger but needs a wasm dep; revisit if we want it.)

## Threat model note (why zero-knowledge is non-negotiable)
Storing users' *external site logins* in a multi-tenant SaaS DB means one breach spills
many companies' outside credentials. Zero-knowledge keeps the DB full of gibberish, so a
breach — or our own admin/DB access — exposes nothing readable. Everything below assumes
the master password and derived key **never leave the device**.

## The "simple password" (master key) semantics — NEEDS CONFIRMATION
David: "a simple encryption based on a simple password, set anytime, used until changed
or turned off." Proposed interpretation (confirm before Phase 2):
- The simple password IS the single master secret: it derives the vault key AND encrypts
  the email payload.
- The vault is **always** encrypted with it (zero-knowledge) — there is no plaintext
  storage mode. "Turned off" therefore means *not currently saving to the vault / not
  emitting an encrypted email* (fall back to the one-time link), **not** "store the site
  password in the clear."
- "Set anytime / change" → changing it re-derives the key and **re-encrypts every entry
  client-side** (unlock with old, re-wrap with new). Push for a strong passphrase; warn
  visibly on a weak one, since the whole vault's strength collapses to it.

## Crypto design
- Derive: `key = PBKDF2(masterPassword, salt, iters, SHA-256) → AES-256-GCM key`.
  Per-vault random `salt` (stored). Per-entry random 12-byte `iv`.
- Store per entry: `{ ciphertext, iv, salt, kdf:{iters,hash}, v, hint }`. The **hint rides
  in the envelope in plaintext** (by design — it's a clue), so it is always saved with the
  encrypted value: the vault entry and any shared copy both carry it. The current hint is
  also cached in the browser and prefilled next time.
- Plaintext fields (safe to store): site/origin, category, created_at, hint.
  → username: David wanted it in the DB + email. Decide if username is plaintext
  (searchable) or inside the encrypted blob (private). Default: **inside the blob** with
  site/category plaintext for search; revisit.
- Email payload: same AES-GCM blob, base64, self-describing header (salt/iv/iters) so the
  offline decryptor needs only the password.

## UI spec (popup)
A single compact popup (~380px), laid out top→bottom in the order you configure then act:
1. **Header** — lock mark + "OpsFloa Passwords" + a small "↻ New" reset (the only way out
   of the locked state; not one of the greyable "options").
2. **Site** — text input, auto-filled from the active tab's origin in the real extension,
   editable.
3. **Username** — text input.
4. **Category** — growable select: Personal / Work + any the user has added, then "Other…"
   which reveals a textbox; adding a value saves it as a permanent option for next time
   (localStorage in the prototype; per-user rows in the DB later). Not a fixed CHECK enum
   since users extend it — validate as free text scoped to the user's own category list.
5. **Generate** — its own **collapsible section** (open by default): length slider (12–32,
   default 20) + toggles (uppercase, numbers, symbols, exclude-ambiguous) + **Generate
   strong password** button.
6. **Password** — monospace display + strength meter (revealed; the user asked for it).
7. **Encryption** — a **collapsible section** (collapsed by default, "Off/On" chip) sitting
   **after** the result. Inside: the enable toggle → password + hint + an explicit
   **Encrypt** button. It **stays live after generate** (it is NOT greyed with the rest —
   encryption is a deliberate post-generate step). On Encrypt: the sealed value appears in
   the result area and the section collapses. The **hint is remembered in the browser**
   (prefilled next time) and is **embedded in every encrypted value** (plaintext envelope
   field), so it always travels with the value — into the vault entry and into a shared
   email. Change the password/hint and re-encrypt → the new value carries the new hint.
   The **hint is always remembered in the browser** (even when encryption is off/closed).
   The **encryption on-state is remembered too**, but rather than starting on at open, it
   **auto-enables (on + expanded, hint prefilled) once you press Generate** — until you turn
   it off/change it. A small **save button sits inside the password field**: clicking it
   **warns it's less safe** (anyone on the device could read it) and, if accepted, saves it
   and **auto-fills the password on future generates**. When saved the icon turns green; click
   again to remove.
8. **Save to vault** — **opens after generate** (not by default). Reveals **Save to Database**
    (disabled; Phase 2) and **Save to Browser** (works now: appends the entry to a
    `localStorage` vault — the **sealed value + embedded hint if encrypted**, else the
    plaintext). If you press Save to Browser while the entry is **unencrypted**, it **offers to
    encrypt first** via a **custom in-popup modal** (Encrypt first = jump into the encryption
    flow; Save unencrypted, with a **"Don't ask again" checkbox**). Saving when an entry with the
    **same site + username** already exists prompts **Overwrite / Cancel** (overwrite keeps the
    existing id). All warnings use this modal, not native `alert/confirm`. Stays live after generate.
9. **Share** — a **collapsible section** that **opens after generate**. Mode (Encrypted email /
    One-time link) + email(s) (**last-used remembered** and prefilled) + a **Share** button.
    Encrypted email is **functional**: it opens the mail app with the sealed payload + decrypt
    instructions (requires encrypting first). One-time link is server-side (Phase 3).
10. **Decryption** — a **collapsible section** (collapsed by default, a live utility) sitting
    **directly under Share**: paste an `OPSFLOA1:` payload (the embedded hint shows on paste),
    enter the password, **Decrypt** → reveals site/username/password/category with per-field
    copy. Same engine as the standalone `decryptor.html`, in-popup for convenience.
11. **Copy** — per-field copy lives **inline in each field** (a small copy icon inside the
    Site and Username inputs; the password has its copy on the result readout). The bottom row
    is just a full-width **Copy all** (site + username + password **+ category** — category
    included so exported/saved/emailed entries sort easily). Inline copies stay clickable even
    when their field is frozen after generate. When encryption is on, "Copy all" copies the
    sealed blob, which also carries the category. Emails (Phase 3) carry category the same way.

**Post-generate lock:** the instant a password is generated, the **Generate** section
collapses and **every option greys out (disabled, dimmed) EXCEPT the copy buttons and the
Encryption section** — the config is frozen and the result copyable, but encryption stays
live so it can be applied as a deliberate next step. "↻ New" reopens Generate and starts
over.

## Phasing
**Phase 0 — UI prototype (no backend).** Self-contained popup mockup: working generator,
strength meter, all options visible, working copy buttons, growable categories, and the
post-generate grey-out. → `extension/popup-prototype.html`.
- **Encryption is real here** (not stubbed): WebCrypto PBKDF2-SHA256 (600k) → AES-256-GCM.
  With encryption on + a password set, "Copy all" copies a self-describing `OPSFLOA1:` blob.
- `extension/decryptor.html` is the matching **offline** decryptor — paste the blob + the
  password, it reveals site/username/password/category; fetches nothing (the email path's
  recipient tool). Round-trip verified; wrong password is rejected by the GCM auth tag.
- Save-to-vault and share/email toggles are still inert (Phases 2–3). **← this step.**

**Phase 1 — Generator + extension core (safe, no server). ← IN PROGRESS (started 2026-08-21).**
Real MV3 extension built from the prototype: `manifest.json` (`activeTab`+`scripting`),
`popup.html` (inline style, external `popup.js` — MV3 bans inline scripts), `popup.js`
(prototype logic + glue: **Site prefilled from the active tab**, **Fill** injects the
password into the page's password field via `chrome.scripting.executeScript`). Loads via
chrome://extensions → Load unpacked. On open it also **pulls the entered username/email**
off the page. A `content.js` injects a 🔑 icon beside a focused password field that asks a
`background.js` service worker to `chrome.action.openPopup()` — **best-effort**, since
browsers don't reliably allow opening the toolbar popup from a page event (toolbar icon is
the guaranteed path). Pure `crypto.getRandomValues`. Remaining: icons (none bundled — Chrome
default), Firefox manifest variant, refining fill/username target selection. **Generate fills
the page's password field** with the plaintext (the sealed value never goes in a login field).
The 🔑 in-field icon
**falls back to an in-page generate+fill** when `openPopup()` is blocked. Padlock icons are
bundled (`generate-icons.js`, no deps). Cross-browser (Chrome/Edge share MV3; Firefox needs a
manifest variant).

**Phase 2 — Zero-knowledge vault.**
- DB migration: `password_vault_entries` (company_id, user_id, origin, username_enc?,
  category, ciphertext, iv, created_at) + `password_vault_meta` (user_id, salt, kdf params,
  hint, master_set_at). Category is a fixed-value column → `docs/db-enums.md` + constant +
  CHECK (values e.g. personal/work/other, TBD).
- API (authenticated, server never decrypts): create/list/delete ciphertext, scoped to
  company_id + user_id.
- App UI: a Passwords page — unlock (derive key client-side), decrypt-on-view, search by
  origin/category, delete, change-master (re-encrypt all). Extension talks to the same API.
- Extension ↔ OpsFloa auth: **open question** (session cookie on dev.opsfloa.com vs. a
  device-pairing API token). Likely a scoped token minted in the app, stored in the
  extension.

**Phase 3 — Sharing.** One-time secret link (server stores blob + single-use token + TTL,
reveals once then burns). Encrypted-email payload + the static offline decryptor + copy.
Email via existing Resend path. Heavy warnings on the email path.

**Phase 4 — Polish.** Category filters; **exact-origin autofill matching** (anti-phishing —
never fill a lookalike domain); optional audit trail; export.

## Open questions (before Phase 2+)
1. Confirm the "off" semantics above.
2. username & category: plaintext (searchable) or inside the encrypted blob (private)?
3. Extension ↔ app auth model (session vs. minted token).
4. Distribution: Chrome Web Store listing (review latency) + Edge + Firefox? Or unpacked/
   enterprise for now?
5. Add-on packaging: is this a paid tool add-on (per the add-on model) or bundled?
6. KDF: stay PBKDF2 (zero-dep) or pull in Argon2id (wasm) for a stronger vault?

## Difficulty
Phase 1: ~days, low risk. Phase 2 (done right): ~1–2 weeks. Phase 3: moderate. The hard
part throughout is the security model, not the code volume.
