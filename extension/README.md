# OpsFloa Passwords — browser extension

Full design: [`docs/plans/password-tool.md`](../docs/plans/password-tool.md).

## Status: Phase 1 — real MV3 extension (Chrome/Edge)
The extension generates strong passwords, encrypts/decrypts them, saves to a local
(browser) vault, shares by encrypted email, and **fills the password into the page**.
No server/database yet (that's Phase 2).

### Files
- `manifest.json` — MV3 manifest (`activeTab` + `scripting` permissions only).
- `popup.html` — the popup UI (inline `<style>`; loads `popup.js` externally — MV3 forbids
  inline scripts).
- `popup.js` — all popup logic (generator, encryption, vault, share, modals) + the
  extension glue: on open it prefills **Site** from the active tab's hostname and pulls the
  **entered username/email** off the page. **Clicking Generate fills the page's password
  field** with the plaintext password; the **Fill** button re-fills it via `chrome.scripting`.
  (The sealed `OPSFLOA1:` value is never put in a login field — it's for the vault/share only.)
- `content.js` — injects a small 🔑 icon beside a focused password field. Clicking it tries
  to open the popup (via the service worker); **if the browser blocks that, it falls back to
  generating a strong password and filling the field in-page** (and copying it).
- `background.js` — service worker; calls `chrome.action.openPopup()` and reports whether it
  worked so the content script can fall back. **Caveat:** browsers don't reliably let an
  extension open its toolbar popup from a page event — the toolbar icon always works.
- `icons/` + `generate-icons.js` — the padlock icon (16/48/128), generated with no deps
  (`node generate-icons.js` to regenerate).
- `decryptor.html` — standalone **offline** decryptor for an `OPSFLOA1:` payload (the
  recipient's tool for the encrypted-email path). Works with just the password, no app.
- `popup-prototype.html` — the self-contained design prototype (opens standalone; the
  **single source of truth** for the UI/logic).
- `build.js` — regenerates `popup.html` + `popup.js` from the prototype. **Edit the
  prototype, then run `node build.js`** — don't edit `popup.html`/`popup.js` by hand (they're
  generated and will be overwritten).

### Load it (Chrome or Edge)
1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. **Load unpacked** → select this `extension/` folder.
4. Pin **OpsFloa Passwords** and click it on any page. On a login/signup page, press
   **Generate** then **Fill** to drop the password into the field.

### Not done yet
- **Firefox** — needs a small manifest variant (`browser_specific_settings`, and
  `scripting`/`activeTab` behave the same, but packaging differs).
- **Phase 2** — the zero-knowledge **database** vault (Save to Database) + a Passwords
  page in the app. Save to Browser (localStorage) works today.

## Prototype behavior (carried into the extension)
- Generator + strength meter; growable categories (Other… → add, persists).
- Encryption: PBKDF2-SHA256 → AES-256-GCM; sealed `OPSFLOA1:` value; hint embedded in the
  value and remembered in the browser; on-state auto-enables on Generate; optional (risky)
  save of the encryption password.
- Decryption section + standalone `decryptor.html`.
- Save to Browser vault with an encrypt-first prompt and same-site+username overwrite
  guard; all warnings use a custom in-popup modal.
- Share: encrypted email (opens the mail app with the sealed payload); one-time link is
  Phase 3. Last-used email(s) remembered.
