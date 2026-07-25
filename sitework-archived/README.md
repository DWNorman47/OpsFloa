# Sitework Takeoff — removed, boxed here (2026-07-25)

This folder **is** the Sitework Takeoff tool, moved out of the project's live tree
into one place. It is the **only** copy — the files were `git mv`'d here, not
duplicated. Delete this folder (and commit) to remove sitework from the project;
drop it back to restore it. Paths inside mirror the repo, so restoring is a
straight copy-back.

## What it is

A self-contained, client-only takeoff tool (no server): load a PDF plan set in the
browser, take off earthwork cut/fill, paving, concrete, utilities, and site
quantities, and produce a priced, branded bid. All work saved to the browser's
IndexedDB (`'ebc'` v2) on that device — nothing hit the server. It had already been
**retired in the UI** (`ToolsPage.jsx` ships `SHOW_SITEWORK = false`), so no user
could reach it; this box removes the files too.

## What's in this box (= everything sitework)

Paths mirror where each file used to live, so restore = copy these back over the
repo root.

| In the box | Lived at | What it is |
|---|---|---|
| `client/public/tool-apps/sitework/` (5 files) | same | The whole tool — `app.js`, `index.html`, `styles.css`, bundled `pdf.min.js` + `pdf.worker.min.js` (pdf.js). ~1.7 MB. |
| `server/tests/siteworkToPlanRoom.test.js` | same | The one test that **reads `sitework/app.js`** (lifts the real `convertToPlanRoom` to verify the Plan Room port). It moved with the tool, so `npm run verify` stays green. |

## What stayed in the project — and does NOT depend on this

- **Plan Room** (`client/public/tool-apps/planroom/`) and the **shared engine**
  (`client/public/tool-apps/shared/`) are *independent copies* of sitework's logic,
  deliberately not wired to it (see `tool-apps/shared/PARITY.md`). They keep working.
- `client/src/components/__tests__/calculators.test.js` has a `describe('sitework')`
  block — that's the in-app **Calculators** tool, unrelated. Not affected.
- The `live_sessions.tool` CHECK enum lists `'sitework'` as a reserved value
  (`docs/db-enums.md`) — harmless.
- **`client/src/pages/ToolsPage.jsx`** still contains sitework references
  (`SITEWORK_TOOL_URL`, the `SHOW_SITEWORK` flag, the `#excavation → sitework`
  redirect, the tab entry, the render block). They are **inert** — all gated behind
  `SHOW_SITEWORK = false`, so nothing renders or links to the (now-gone) files, and
  the build/tests stay green. See "Optional cleanup" and "Restore" below.

## State now / to fully remove

The tool + test are **already out** of the live tree (moved here). To finish:

1. **Commit** the move (records sitework leaving `client/`/`server/`), then when
   you're ready to discard it for good, `git rm -r sitework-archived/` in a later
   commit — or just move this folder out of the repo to keep as an offline backup.
2. *(Optional cleanup)* strip the inert sitework code from
   `client/src/pages/ToolsPage.jsx` — it does nothing while `SHOW_SITEWORK = false`,
   but removing it drops the dangling `/tool-apps/sitework/index.html` link. Pieces:
   the `SITEWORK_TOOL_URL` const, the `SHOW_SITEWORK` flag, `hasTakeoff`/
   `showSitework`, the `#excavation → sitework` line in `resolveTab()`, the
   "land on hidden Sitework tab → Plan Room" effect, the `showSitework` tab entry,
   and the `{tab === 'sitework' && showSitework && (…)}` render block. If you strip
   these, keep a copy (or rely on git history) so you can restore the tab later.
3. *(Optional)* trim doc mentions for accuracy: the "Frozen: the sitework tool"
   section in `CLAUDE.md`, the `sitework/` line in `docs/MAP.md`.

> Do **not** touch `tool-apps/shared/` or `planroom/` — those are the live tools now.

## To RESTORE it later

1. Copy the two trees back over the repo root:
   ```
   cp -r sitework-archived/client  .
   cp -r sitework-archived/server  .
   ```
   (Lands the tool at `client/public/tool-apps/sitework/` and the test at
   `server/tests/siteworkToPlanRoom.test.js`.)
2. If you stripped the `ToolsPage.jsx` wiring, re-add it from git history
   (`git show <pre-removal-commit>:client/src/pages/ToolsPage.jsx`).
3. **To show the tab to users**, set `SHOW_SITEWORK = true` in `ToolsPage.jsx`
   (it's off by default; the tab then appears for companies that own the Takeoff
   add-on / are on trial/exempt).
4. `npm run verify` to confirm green.

## Why it's safe to keep here

This folder lives **outside `client/`**, so Vite never builds or deploys it, and
it's **outside `server/`**, so jest never runs the archived test. It's inert to all
tooling — purely a parking spot until you delete it or drop it back in.
