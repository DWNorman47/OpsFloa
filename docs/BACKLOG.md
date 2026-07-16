# OpsFloa — Backlog & Leftovers

A single parking lot for everything that isn't being worked on right now, so it's
easy to scan and pick what to address next. Claude keeps this current: as items
come up they get filed under the matching section; when you decide to tackle one,
point at it (or the whole section).

Conventions: each item is a one-line summary + optional detail, with the date it
was filed (YYYY-MM-DD). "→ memory: name" points at a related saved memory note
that holds the exhaustive detail.

---

## 🐞 Bugs — can't be addressed until they recur
*Not raised again unless they actually reappear.*

- **Stale project list (sitework takeoff).** The local project list briefly showed
  5 already-deleted projects instead of the current set, then corrected itself on
  reload; not reproducible from the code. Watch for a recurrence on a single,
  freshly-loaded tab, and capture what's on screen. (2026-07-10)

## 🔧 Bugs — set aside for later

- **Email bounce suppression is orphaned by the Resend migration — and it can
  never let anyone back in.** Found 2026-07-16 while re-surveying the app; not
  yet triaged, so the impact estimate below is reasoning, not observation.
  - `email.js:97` calls `isBounced(to)` before every send and **silently skips**
    the recipient if `users.email_bounced_at` is set.
  - The **only writer** of that column is `routes/sendgridEvents.js:56` — a
    **SendGrid**-shaped webhook. Email moved to **Resend**, and there is no
    Resend bounce webhook anywhere in `server/`. So the column takes no new data.
  - **Nothing clears `email_bounced_at`.** No route, no admin action, no cron —
    grep finds exactly three references repo-wide (the read, the write, the
    migration). **So anyone whose address bounced once during the SendGrid era is
    permanently suppressed and silently receives no OpsFloa email ever again**,
    including a worker who has since fixed their mailbox. They get no invite, no
    reset, no notification, and nothing surfaces it to an admin.
  - Two failures, opposite directions: **stale suppressions never lift** (real
    users go dark), and **new bounces never register** (we keep mailing dead
    addresses, which is what damages sender reputation).
  - Fix is roughly: a Resend bounce webhook to feed the column, plus a way to
    clear it (admin action, or auto-clear on a successful send / email change).
    Worth checking first whether any prod rows are actually set — if the table is
    empty this is theoretical and only the missing webhook matters.
- **Stale CSP hash blocks the inline auth-guard script on stage**
  (`client/public/tool-apps/sitework/index.html:9`). The Content-Security-Policy
  is set by the frontend host (Vercel), not the Express server, and it isn't
  blocking sharing. Fix = update/replace the `script-src` hash (or use a nonce)
  in the host config. (2026-07-10)
- **Stage QA — open-findings batch** (2026-06-29/30 pass; full detail in
  `docs/stage-qa-findings.md` → "Open Findings"). Re-verify which remain open —
  some may already be fixed on dev. Themes:
  - Tabbed pages ignore hash-only navigation until reload (Time Clock subtabs,
    Financial Reports P&L/WIP) + missing old→new hash aliases.
  - Demo Operations data stale/bloated (old "still clocked in" alerts, ~3050 hrs,
    105 pending approvals, overdue equipment) → demo refresh should prune, not
    just insert.
  - Guide/help search misses common phrasing ("time off", "PTO", "inventory count").
  - Empty demo states: Booking setup (types/users) and Field Work > Media.
  - Slow initial loads (Time Clock / Inventory / Team) that look stuck.
  - A11y: tab/shell controls lack accessible names; invalid public links mix
    "Not Found / Unauthorized" wording. (filed 2026-07-11)
- **Tool-apps still print `$` regardless of the company currency**
  (`client/public/tool-apps/shared/engine-ui.js:18` `money()`, and the sitework
  tool's own copy). Everything else — app, PDFs, public client pages, report
  emails — was fixed in the 2026-07-16 currency sweep, but the static tool-apps
  are sandboxed: they're plain HTML served from `public/`, outside React, with no
  access to `SettingsContext` or `GET /api/settings`. The Plan Room bid tables
  consume the shared `money()`, so Plan Room + sitework both show dollars to an
  HNL company. Fix needs a delivery mechanism — most likely piggyback the
  existing `tc_addons` localStorage bridge that `AuthContext` already writes for
  add-on gating, and have `engine-ui.money()` read the code from there. Note
  Intl reads the symbol off the LOCALE, not the currency code, so it needs the
  locale map too (`server/currency.js` / `client/src/utils.js`). **Sitework is
  off-limits** — do Plan Room + the shared engine only, or the sitework copy
  diverges. (2026-07-16)
- **Newer takeoff kinds skip the `NEEDS_SCALE` guard** (`planroom/app.js:239`).
  `NEEDS_SCALE` blocks a tool on an uncalibrated sheet and sends you to 📏.
  Roofing/earthwork/drywall kinds are registered, but the flooring and framing
  packs never added theirs: `froom`, `ftrans`, `fwall`, `fsheath` all produce
  LF/SF, so on an uncalibrated sheet they trace happily and silently return 0 —
  a wrong bid rather than an error. (ESC's `escline`/`escarea` are registered
  correctly.) One-line fix, but verify no flow depends on tracing pre-scale.
  (2026-07-16)
- **`fopening` missing from `POINT_KINDS`** (`planroom/app.js:1945`). It's a
  count kind drawn as dots, but `POINT_KINDS` drives rubber-band suppression,
  the draft label, and the minimum-point count — so unlike its twin `dopening`
  it wrongly rubber-bands and needs 2 clicks instead of 1. (2026-07-16)
- **Closeout is broken for companies without QuickBooks, in both directions.**
  `project_invoices` is a **QBO mirror** — only `server/routes/qbo.js` ever
  writes it — so a company without QBO connected has **zero rows**. Both
  invoice-backed auto-status items in `computeAutoStatus()`
  (`server/routes/closeout.js:181-201`) then misread that emptiness:
  - `final_invoice` counts *paid* invoices → 0 → stays `in_progress` forever.
    Since `final_complete` requires every required item done
    (`closeout.js:370-383`), **those projects can never be closed out.**
  - `retainage_release` sums `balance` → `SUM` over zero rows is **0** → `0 === 0`
    → reports **`done`**. It cheerfully certifies retainage released on a project
    with no invoices at all. A false negative blocks; a false positive lies.
  Fix needs the architectural call first: does owner-side billing get a native
  invoice concept, or is QBO a hard dependency? Both items should at minimum
  distinguish "no invoices exist" from "invoices exist and are settled". See
  `docs/plans/gc-tools.md` → Decision 2. (2026-07-16)
- **Closeout transition gate reads stored status, not computed** — and its
  comment says otherwise. `server/routes/closeout.js:361` reads *"Evaluate items
  with auto-source via the same compute path"*, but the loop below tests
  `item.status` (the stored column) rather than calling `computeAutoStatus()`.
  So a punchlist that is genuinely clear can still block
  `substantially_complete` when the stored row is stale. Also `const byCat` on
  the line above is assigned and never read — dead. (2026-07-16)

## 🧭 Design flaws — raised, set aside for later

- ~~**Company-share conflict model is fork-only.**~~ **RESOLVED 2026-07-14.** The
  conflict dialog is now 3-way (Keep both / Overwrite theirs / Cancel), and a
  **manual, admin-releasable lock** (migration 0138) lets a user reserve a shared
  takeoff so teammates can't save over it (reads/copy still work). Holder or any
  admin unlocks. See shipped log.
- **No dedupe when copying a shared takeoff twice.** "Copy to my projects" makes a
  fresh local project each time, so copying the same cloud takeoff twice yields two
  local projects both linked to it. Minor; could reuse the already-linked local
  project instead. (2026-07-11)

## ❓ Open questions / decisions for you
*Blocked on your call before anyone builds.*

- **Presigned R2 upload** — pull the trigger now, or stay on the 64 MB base64
  bandaid until plans actually exceed the ceiling? (see Improvements) (2026-07-10)
- **Wall Dig button** — hidden "for now" in the takeoff tool; bring it back, remove
  it, or leave it hidden? (2026-07-10)

- **Native invoices, or QuickBooks forever?** ⚠️ **The biggest one on this list.**
  `project_invoices` is a QBO *mirror* — only `routes/qbo.js` ever writes it, so a
  company without QBO connected has **zero rows**. This blocks sub pay-apps
  entirely, and it is **already breaking closeout today** (see the two closeout
  bugs above). Either invent a native invoice/AR concept, or make QBO a hard
  dependency of project billing and say so out loud. Nothing in the money category
  should be built before this is decided. See `docs/plans/gc-tools.md`.
  (2026-07-16)
- **Do you want GC customers at all?** Everything OpsFloa does today assumes a
  contractor who **self-performs**. A GC coordinates *other people* — different
  buyer, different anxiety, the one who pays Procore ($10k+/yr). Worth entering
  only *deliberately*: a half-built GC story is worse than none. The alternative —
  keep deepening the trade product that now has **11 takeoff trades** — is a
  legitimate and cheaper answer. Two of the six GC standouts shipped 2026-07-16
  (COI tracker, OAC minutes) because both were nearly free on existing pipelines;
  the rest are real builds. See `docs/plans/gc-tools.md`. (2026-07-16)
- **Is $60/mo still right for Takeoff?** It was priced when Takeoff did **3
  trades**. It now does **11** (roofing, dirt, drywall/paint, flooring, framing,
  ESC, striping, siding, demo, fencing, landscape). Dedicated takeoff software
  runs $1,500–4,000/seat/yr and usually covers *one* trade. Left alone on purpose
  — land-grab pricing is defensible, and raising later beats lowering — but it
  should be a decision rather than an oversight. (2026-07-16)
- **Should an expired COI block, or just warn?** It currently **warns**: the
  tracker alerts at 30 days and again on expiry, but nothing stops a PO being
  issued to a sub whose insurance has lapsed. Blocking is arguably the whole value
  ("he can't be on site"), but it's a hard gate on a flow that already works, so
  it wasn't added unasked. (2026-07-16)
- **Is the closeout deliverable a PDF or a ZIP?** ZIP is cheaper and arguably more
  useful (as-builts are big CAD files); `archiver` is already a server dep. Note
  this is downstream of a prerequisite: `project_closeout_items` has **no document
  columns**, so there is currently nothing to assemble. (2026-07-16)

## ✨ Ideas — improvements


- ~~**Takeoff ↔ job hard link (cross-device haul reconciliation).**~~ **DROPPED
  2026-07-14 — solved by the simpler path.** The $ Bid modal now has an estimate
  dropdown (link + "Send pricing to estimate"), so the priced lines (incl. the
  export-haul-off qty) land on the estimate; the haul-log reconciliation reads
  those lines server-side, which is already company-wide/cross-device. Nothing
  per-browser is in the loop, so no server-side takeoff↔job link is needed. The
  only remaining (natural) dependency: the bid must be converted into a job for
  the job's haul tickets to find their estimate.
- **Haul log: print layout + a specific-takeoff picker.** A print-friendly haul
  ticket report (CSV already ships); optionally let a job point at a specific
  takeoff for reconciliation instead of "most recent converted estimate."
  Deferred M3 items in `docs/plans/production-log.md`. (2026-07-13)
- **Presigned direct-to-R2 upload for shared-takeoff PDFs.** Replaces the current
  64 MB base64-through-the-API approach; removes the ~48 MB ceiling and cuts server
  memory. Caveats: needs R2 bucket CORS + orphaned-object cleanup.
  → memory: project_takeoff_pdf_storage. (2026-07-10) **Note:** scheduled as M4
  of the Plan Room plan (`docs/plans/plan-viewer-markup.md`) — full-size plan
  sets (50–200 MB) need it for library share and go-live, so building that tool
  delivers this improvement along the way.

## 🚀 Ideas — new features or tools

- **Plan Room: Wall Dig takeoff (sitework pack Q4, deferred).** Retaining-wall /
  footing excavation — a trench swept along a traced line, net export vs. reused
  backfill after concrete + aggregate fill the hole; the ▚ Wall variant reads
  depth off contours (constant / to-subgrade / proposed−embedment). Deferred
  because the *dig* overlaps the Line trench takeoff and its concrete/agg are
  usually the concrete sub's scope, not the excavator's. **Full rebuildable spec
  (cross-section + wallComputeCore formulas + form fields + bid lines) lives in
  `docs/plans/planroom-sitework-pack.md` → "Q4 Wall dig — full spec"**, so it
  survives even if the standalone sitework tool is deleted first. (2026-07-12)
- **Tools-module roadmap (large idea backlog).** Full categorized list in memory.
  Headline categories: **takeoff siblings** (📐 same measure→bid engine — Roofing,
  Drywall/Paint, Flooring/Tile, Framing, Siding/Gutters, Erosion control,
  Demolition, Fencing, Striping, Landscape), **quick field calculators** (🧮
  concrete/rebar/asphalt/slope/converter…), **trade-engineering calcs**
  (electrical/plumbing/HVAC/structural), **money & bidding** (proposal generator,
  change-order builder, cost book, AIA pay apps), **AI doc/writing** (scope-of-work,
  RFI/submittal, red-flag scanner, translator), **AI-from-media** (voice-memo→tasks,
  photo→estimate, receipt OCR), **field/jobsite ops**, **GC tools** (bid leveling,
  COI tracker, OAC minutes, pay-app+lien-waiver, selection tracker, closeout
  assembler), and **"expensive-software replacements"** (Bluebeam-style plan
  viewer/markup, multi-trade takeoff, proposal/e-sign, roof measurement).
  **Called-out standouts:** Talk-to-Bid (voice walkthrough → priced bid), Contract
  Red-Flag Scanner, Instant Branded Proposal, Bilingual Crew Cards, Snap-a-Receipt
  job costing, Roofing takeoff, Bluebeam-style plan viewer.
  → memory: project_tool_roadmap. (filed 2026-07-11)
- **Service-call business model gaps (base app, not add-ons).** To serve
  HVAC/plumbing/electrical/service-call businesses, ranked by need:
  1. Work-order completion flow (line items, photos, signature, parts/labor) —
     everything hangs off this; SignatureModal/PhotoCapture already exist.
  2. In-app customer payments (card / deposit / pay-link).
  3. Flat-rate price book (good/better/best by task).
  4. Customer-site asset registry + service history.
  5. Recurring agreements / memberships / PM plans.
  6. Dispatch board for work orders (techs→jobs with arrival windows).
  7. Customer SMS + "on my way".
  8. Invoice from a work order.
  Critical money-loop path: 1 → 3 → 8 → 2. → memory: project_service_call_gaps.
  (filed 2026-07-11)
- **Storm/Utility takeoff deep module** (deferred paid add-on). Quick-win presets
  already shipped (pipe-size line presets + storm-structure count presets). The
  deep version adds: (1) pipe schedule (size/material → auto trench width + LF by
  diameter), (2) invert-driven per-segment trench depth from rim/invert + slope,
  (3) structure depth (a 12-ft manhole ≠ a 4-ft catch basin), (4) spoil-vs-import
  backfill netting. → memory: project_storm_utility_module. (2026-07-09)

## 📌 Planned / ready-to-build
*Scoped with a plan; just not started.*

- **Plan Room platform (MASTER PLAN)** — `docs/plans/plan-viewer-markup.md`
  (2026-07-11, two tiers, **money-first sequencing**). **Base add-on ~$40/mo**
  (`addon_planroom`): viewer + markup + measure + company library +
  flatten/export, **visible-but-locked** in ToolsPage; on sale at M6.
  **Takeoff layer ~$60/mo** (reuses `addon_takeoff`, requires base, stacked
  billing): all trade packs + price library + bid engine — **roofing pack
  first at M7**. Live sessions (generic layer, local-first host "goes live",
  survives drops) follow at M8, off the revenue path. **Sitework port is
  unscheduled** ("when consolidation earns it") behind the user-confirmation
  gate; the standalone tool serves as the interim sitework pack. User actions:
  Stripe Plan Room prices; takeoff price decision at M7; R2 CORS at M4; the
  cutover confirmation.
- **Roofing trade pack** — `docs/plans/roofing-takeoff.md` (2026-07-11,
  restructured: no own SKU/app — ships inside Plan Room **M7**, ahead of the
  sitework port). Pitch → squares, roof lines/counts, materials math,
  aerial-image input for re-roofs, bid defaults. Auto-measure from address
  stays M-later.
- **Drywall & Paint trade pack** — **SHIPPED** (`docs/plans/drywall-paint-pack.md`).
  D1+D2+D3 built inside the Plan Room takeoff layer: wall runs (LF × height ×
  sides), ceilings, opening deducts, trim, board/mud/tape/paint math; **plus
  D3** — texture ($/SF), batt/sound insulation (single-face wall area), and
  ACT/drop-ceiling grid takeoff (tiles/tees/wall-angle/hangers, installed $/SF);
  **D4** — interior-elevation heights (↕ tool measures a named wall height off an
  elevation sheet → reusable library, applied as default or per run). **Pack is
  feature-complete.** No own SKU — included in the $60 takeoff layer.
- *(further trade packs to scope when wanted: see the tools roadmap —
  flooring/tile, framing, siding, fencing, striping, landscape…)*

## ✅ Things I need to do (David)

**Migrations:** *no manual step* — they auto-apply on every deploy (`migrate.js`
runs on server start, tracked in `schema_migrations`) and ride along to
stage/prod on those PRs. All shipped migrations through **0138** are already
applied on dev (verified 2026-07-14). *(Corrects earlier "run migrations X" notes.)*

**Bid workflow + Haul log (shipped to `dev`):**
- **Test both loops end-to-end:** (1) estimate → set due date → attach PDF →
  Take off in Plan Room → price in $ Bid → Send pricing → confirm lines + total
  land on the estimate; (2) log haul tickets on a job → totals/subtotals →
  (with the takeoff add-on, on a job that came from a converted bid) the
  estimate-vs-actual reconciliation card.
- **Reconciliation caveat:** the estimate-vs-actual card keys off the estimate's
  `converted_project_id`, so it only lights up once you **convert the winning bid
  into a job**. A haul job created directly (not from a converted estimate) shows
  "convert the winning bid to this job to compare." A hard takeoff↔job link
  (cross-device) is deferred — flag if you want it built.

**Plan Room — before the base tier can actually sell (M6 shipped):**
- ~~**Stripe (Plan Room $40)**~~ — **DONE** (2026-07-15). `STRIPE_PRICE_PLANROOM`
  (+`_ANNUAL`) set in Render → `addon_planroom`; billing card + checkout verified.
  `.env.example` documents the full add-on price set.
- ~~**R2 bucket CORS**~~ — **DONE** (2026-07-15). CORS policy applied to the
  plan-tools bucket (PUT + `content-type` from the app origins) so the ☁
  share-upload path works. Reads/copy-down never needed it (server-proxied).

**Plan Room — optional / later:**
- ~~**Orphan sweep**~~ — **DONE** (2026-07-15). `R2_ORPHAN_SWEEP=1` set in
  Render on the env whose DB owns the bucket. Cleans up abandoned presigned
  uploads nightly.
- **Smoke-test Plan Room end-to-end** on dev: open a plan set (PDF + an aerial
  image), mark up, calibrate + measure against a known dimension, share to the
  company + copy it down on another browser profile, export the flattened PDF,
  and confirm the locked card shows for a company without the add-on.

**Takeoff layer (M7 shipped — roofing pack):**
- ~~**Stripe (Takeoff $60)**~~ — **DONE** (2026-07-15). `STRIPE_PRICE_TAKEOFF`
  (+`_ANNUAL`) set to the new $60 price → `addon_takeoff`. Legacy takeoff price
  moved to `STRIPE_PRICE_SITEWORK` (inert — safe to delete; no legacy subs).
- **Verify the roofing math** against a hand calc (a plane's squares, a
  hip/valley pitch-corrected LF) before selling it.
- **Storm/Utility add-on — verify + flip to sell.** The whole module is built
  (`addon_storm`, `STRIPE_PRICE_STORM` wired, priced $20/mo as a light upsell) but **the purchase is hidden**
  (`STORM_SELLABLE=false` in `BillingPanel.jsx`). Hand-check the utility math —
  pipe-volume displacement, average-end-area CY on a sloped segment, native-vs-
  import net export — then set `STORM_SELLABLE=true` to open sales. Superadmin
  toggle turns it on for your own testing now. (`docs/plans/storm-utility-pack.md`)
- **Parity test (the S4 cutover gate):** dirt takeoff is now built in Plan Room
  (contours/spots/pads, two-sheet ⌖ alignment + ghost, cut/fill + heat overlay,
  bid lines). Run the SAME job in Plan Room and the standalone Sitework tool and
  compare cut/fill/export CY — only after you confirm they match does the
  standalone tool redirect (`docs/plans/planroom-sitework-pack.md` S4).

## 📖 Done / shipped log
*Landed on `dev`, newest first. (What happens past dev is handled outside this doc.)*

- **2026-07-14 — Plan Room $ Bid: estimate dropdown + send pricing.** A "🔗
  Estimate" dropdown in the $ Bid modal (from your draft estimates) links the
  takeoff and reveals the existing "Send pricing to estimate" button — no need
  to launch from the estimate anymore. Makes the "takeoff↔job hard link" idea
  unnecessary (see Improvements): pricing lands on the estimate, and
  reconciliation reads it server-side.

- **2026-07-14 — Plan Room share-conflict: 3-way dialog + manual lock.** Company
  library sharing: a stale save now offers **Keep both / Overwrite theirs /
  Cancel** (`askChoice` modal; overwrite sends `overwrite:true`, server bypasses
  the version check). Plus a **manual, admin-releasable lock** (migration
  **0138**: `locked_by`/`_name`/`_at` on `takeoff_projects`) — 🔒 reserve a
  takeoff so teammates' in-place saves are refused (423); reads + "Copy to my
  projects" always work. Holder **or any admin** unlocks (`POST /:id/lock`,
  `/:id/unlock`) — no heartbeat/TTL needed. Library shows a "🔒 by <name>" badge.
  A lock beats overwrite. Sitework tool unaffected (never locks). **Needs
  migration 0138 run.**
- **2026-07-14 — Plan Room earthwork editing polish (batch).** Vertex editing on
  every polyline/polygon (drag points, Alt-click add/remove, Shift+Alt-click to
  cut/split a line — never orphaning a point); a sitework-style **contour list**
  in the ⛰ Dirt panel (edit elev / delete / select+jump / clear); the
  Existing↔Proposed **click-toggle** navigates + focuses one surface and hides
  the other's contours; general markups hide in earthwork mode; the **boundary
  shows on both sheets**; the trade panel auto-opens (gated on a loaded doc);
  clicking a contour drops into edit mode; panning keeps the selection; and an
  **editable on-canvas scale bar** (drag ends to recalibrate, drag middle to
  move, Alt-click to clear).

- **2026-07-13 — Removed the dynamic work/project label; "Project" is now
  hardcoded** (`e16d6cf`). Excised `workLabel` / `settings.label_work` /
  `labelSg(..,'work'|'project')` across ~50 client files and replaced with the
  literal Project/project/Projects/projects (the entity is just a Project now —
  explicit Projects + Work Orders tabs exist). Fixes the earlier "+ New Team
  Member" mislabel at its root (the missing `project` default that fell through
  to the worker label). Worker/client/field labels stay dynamic. Verified:
  production build (53 modules), vitest smoke + i18n parity (84 tests), eslint
  clean, sitework untouched. Closes the deferred "workLabel should no longer be
  a thing" item.

- **2026-07-13 — Production & Haul Log (main app), M1–M3.** Plan:
  `docs/plans/production-log.md`. The sitework tool's production log, rebuilt
  server-backed + per-job + multi-user in the **Field module → "Haul log" tab**.
  **Decisions (locked with David):** lives as a Field tab; **field crews can
  self-log** (`manage_haul_tickets`, a worker-default perm). **M1** (`a7e3e84`):
  migration **0137** (`haul_tickets` + seeds the perm into built-in roles) +
  `haulEnums`/db-enums; audited route (worker/admin narrowing, enum + project-
  ownership validation); add form, job + date filters, net-export totals by unit,
  delete, CSV. **M2** (`38df6e5`): `GET /haul-tickets/reconcile` (takeoff add-on,
  `usePlan().hasTakeoff`) — actuals vs the estimate converted to the job
  (`converted_project_id`; haul-off qty from `/haul|export|spoil/` lines);
  estimate-vs-actual card, variance over/under. **M3 polish** (`148a28e`): edit a
  ticket (row ✎ → reused form → PATCH); collapsible by-hauler/by-material
  subtotals. Daily-production half already existed (`daily_reports`), so only
  haul tickets + reconciliation were new. **Deferred:** takeoff↔job hard link
  (cross-device reconciliation — needs a data-model decision), a print layout,
  retiring the sitework local log.
- **2026-07-13 — Bid workflow: Estimate ⇄ Plan Room, M1–M4.** Plan:
  `docs/plans/bid-workflow-estimate-planroom.md`. Makes the **estimate the hub of
  a bid** — the win-the-bid loop David's wife runs (handed a PDF + a deadline →
  price it → send before the clock). **M1** (`f49f373`/`524ac95`): `bid_due_at` +
  `bid_reminder_sent_at` (migration **0135**); estimate form field, list "due
  soon/overdue" chip, hourly reminder cron (push + inbox, claim-then-send,
  re-armed on due-date change). **M2** (`019e849`): attach a plan PDF (migration
  **0136** `plan_pdf_url`/`_name`); `POST/DELETE /estimates/:id/plan-pdf` base64
  **through the server** to R2 — **no R2-CORS needed**; Plans card. **M3**
  (`c13d7db`): `GET /estimates/:id/plan-pdf` base64 proxy; **"📐 Take off in Plan
  Room"** button (gated on plan-attached + `addon_planroom`); Plan Room
  `?estimate=` find-or-create → `bootEstimate()`, `estimateId` round-trips through
  all load paths. **M4** (`4040252`): **"➤ Send pricing to estimate"** in $ Bid →
  `PUT /estimates/:id/lines` via `apiEstimate()`; keyword category heuristic; O&P
  rides as one `overhead` line so totals match; replace-with-confirm. Base tier =
  deadline + PDF; takeoff add-on = launch + pricing-back. **Caveats:** Plan Room
  projects are per-browser (link is per-device); O&P can double-count if the
  estimate also carries a margin %.
- **2026-07-13 — Plan Room: manage sheets (reorder / remove).** 🗂 Manage sheets
  (from 📁 Projects when a set has >1 sheet): reorder ▲▼ or remove ✕ sheets;
  Apply rebuilds the combined PDF (pdf-lib) and remaps every page reference —
  markups, per-sheet scales, earthwork existing/proposed assignments — so
  nothing lands on the wrong sheet; removing a sheet drops its markups.
- **2026-07-12 — Plan Room: combined-document projects (multi-PDF, page
  selection).** Opening plans moved into the 📁 Projects modal: pick a
  file → a thumbnail page-picker (check/uncheck sheets) → only the chosen
  sheets load. "Add more sheets" appends from other PDFs/images into one
  combined PDF (pdf-lib merges; images become pages; existing page numbers
  stay stable so markups/earthwork refs survive). Removed the topbar
  "Open Plans" + "Load"; progressive disclosure hides the whole toolbar
  except 📁 Project until a document is loaded; Projects modal is now the
  genesis hub (open/add plans, load saved file, ☁ company / join live). This
  resolves the multi-PDF-projects and doc-replacement-warning items (append,
  never silent-replace).

- **2026-07-11 — Plan Room product built end-to-end (M0–M8).** The two-tier
  plan-tools line: a shared engine copied out of the sitework monolith
  (`tool-apps/shared/`, sitework untouched); the **$40 base tier** — viewer
  (PDF + aerial image, density-aware render + zoom sharpening), 9 markup kinds +
  select/undo + list, measure (per-sheet scale → length/area/count), company
  library with presigned R2 upload, flatten-PDF + CSV export, and **live
  sessions** (SSE rooms + REST ops, presence, DB snapshots, idle sweep); the
  **$60 takeoff layer** — roofing pack (planes→squares, pitch-corrected edges,
  items, materials + priced bid), gated on the takeoff add-on with an upsell
  teaser; platform wiring (`addon_planroom` migration/Stripe/superadmin/billing,
  visible-but-locked ToolsPage). Migrations 0133–0134. **Unscheduled:** the
  sitework consolidation (still its own standalone tool, untouched).

- **2026-07-11 — Recategorized `manage_equipment` to the Inventory module.** Moved
  it Field → Inventory in the permission catalog (label "Equipment log" →
  "Equipment") and added it to `MODULE_PERMISSIONS.inventory` so a role holding only
  it can reach the Equipment group; kept in `field` too (no regression).

- **2026-07-10/11 — Company takeoff sharing fixed end-to-end.** The 500 that broke
  it entirely (`users.full_name`), the 413 on large plan PDFs (64 MB body limit +
  the error surfaced in the modal), and the bug where opening a shared takeoff
  overwrote a local project — now a "Copy to my projects" prompt (new vs overwrite,
  with an editable name).
- **2026-07-09/11 — Sitework takeoff topbar overhaul.** Six-section layout,
  responsive collapse to icons then wrapping, action-row packing fix, Bid/Log moved
  next to Calculate, help-modal close-X, Wall Dig hidden.
- **Earlier (prior session) — Equipment tracking → Inventory consolidation.** The
  full M1–M4 plan (`~/.claude/plans/mossy-launching-mist.md`) shipped: migration
  `0125_equipment_tracking.sql`, equipment enums, check-out/return + rentals +
  maintenance endpoints and cron, the Inventory **Equipment** group, and the Field
  `#equip` redirect. (verified 2026-07-11)
