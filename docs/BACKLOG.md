# OpsFloa — Backlog & Leftovers

A single parking lot for everything that isn't being worked on right now, so it's
easy to scan and pick what to address next. Claude keeps this current: as items
come up they get filed under the matching section; when you decide to tackle one,
point at it.

Conventions: each item is a one-line summary + optional detail, with the date it
was filed (YYYY-MM-DD). "→ memory: name" points at a related saved memory note.

---

## 🐞 Bugs — can't be addressed until they recur
*Not raised again unless they actually reappear.*

- **Stale project list (sitework takeoff).** The local project list briefly showed
  5 already-deleted projects instead of the current set, then corrected itself on
  reload; not reproducible from the code. Watch for a recurrence on a single,
  freshly-loaded tab, and capture what's on screen. (2026-07-10)

## 🔧 Bugs — set aside for later

- **Stale CSP hash blocks the inline auth-guard script on stage**
  (`client/public/tool-apps/sitework/index.html:9`). The Content-Security-Policy
  is set by the frontend host (Vercel), not the Express server, and it isn't
  blocking sharing. Fix = update/replace the `script-src` hash (or use a nonce)
  in the host config. (2026-07-10)

## 🧭 Design flaws — raised, set aside for later

- **Company-share conflict model is fork-only.** When two people edit the same
  shared takeoff, the second saver can only fork to a new separate copy or back
  off — there's no "overwrite theirs" option and no merge. Possible fix: an
  explicit "overwrite theirs" choice and/or a "checked out by X" lock indicator.
  (2026-07-11)

## ✨ Ideas — improvements

- **Presigned direct-to-R2 upload for shared-takeoff PDFs.** Replaces the current
  64 MB base64-through-the-API approach; removes the ~48 MB ceiling and cuts
  server memory. Caveats: needs R2 bucket CORS + orphaned-object cleanup.
  → memory: project_takeoff_pdf_storage. (2026-07-10)

## 🚀 Ideas — new features or tools

- **Equipment tracking → Inventory consolidation** — *scoped, has a full M1–M4
  plan* (`~/.claude/plans/mossy-launching-mist.md`): move the Field equipment log
  into an Inventory "Equipment" group and add check-out/return, rentals + reminder
  cron, and maintenance logs. Not started.
- **Storm/Utility takeoff deep module** — invert-driven storm-drain takeoff as a
  paid add-on; quick-win presets already shipped, deep version deferred.
  → memory: project_storm_utility_module.
- **Service-call business model gaps** — work-order completion flow, in-app
  payments, price book, customer-site assets, memberships, dispatch board, SMS,
  invoice-from-work-order. → memory: project_service_call_gaps.
- **Tools-module roadmap** — full backlog of suggested tools.
  → memory: project_tool_roadmap.

## ✅ Things I need to do (David)

- *(nothing filed yet — add as they come up)*
