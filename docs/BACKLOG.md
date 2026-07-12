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

## 🧭 Design flaws — raised, set aside for later

- **Company-share conflict model is fork-only.** When two people edit the same
  shared takeoff, the second saver can only fork to a new separate copy or back
  off — there's no "overwrite theirs" option and no merge. Possible fix: an
  explicit "overwrite theirs" choice and/or a "checked out by X" lock indicator.
  (2026-07-11)
- **No dedupe when copying a shared takeoff twice.** "Copy to my projects" makes a
  fresh local project each time, so copying the same cloud takeoff twice yields two
  local projects both linked to it. Minor; could reuse the already-linked local
  project instead. (2026-07-11)

## ❓ Open questions / decisions for you
*Blocked on your call before anyone builds.*

- **Share-conflict model** — leave it fork-only, or add an "overwrite theirs"
  choice and/or a "checked out by X" lock indicator? (see Design flaws) (2026-07-11)
- **Presigned R2 upload** — pull the trigger now, or stay on the 64 MB base64
  bandaid until plans actually exceed the ceiling? (see Improvements) (2026-07-10)
- **Wall Dig button** — hidden "for now" in the takeoff tool; bring it back, remove
  it, or leave it hidden? (2026-07-10)

## ✨ Ideas — improvements

- **Presigned direct-to-R2 upload for shared-takeoff PDFs.** Replaces the current
  64 MB base64-through-the-API approach; removes the ~48 MB ceiling and cuts server
  memory. Caveats: needs R2 bucket CORS + orphaned-object cleanup.
  → memory: project_takeoff_pdf_storage. (2026-07-10) **Note:** scheduled as M4
  of the Plan Room plan (`docs/plans/plan-viewer-markup.md`) — full-size plan
  sets (50–200 MB) need it for library share and go-live, so building that tool
  delivers this improvement along the way.

## 🚀 Ideas — new features or tools

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
- **Drywall & Paint trade pack** — `docs/plans/drywall-paint-pack.md`
  (2026-07-11). No own SKU/app; ships M-later after roofing proves the
  integrated takeoff UX. Height-per-wall-run is the core move (LF × height →
  SF, 1-or-2 sides), ceilings via room polygons, opening deducts, board/mud/
  tape/paint-gallon math into the shared bid engine.
- *(further trade packs to scope when wanted: see the tools roadmap —
  flooring/tile, framing, siding, fencing, striping, landscape…)*

## ✅ Things I need to do (David)

**Plan Room — before the base tier can actually sell (M6 shipped, needs these):**
- **Stripe:** create the Plan Room product with a monthly (~$40) and an annual
  price, then set `STRIPE_PRICE_PLANROOM` + `STRIPE_PRICE_PLANROOM_ANNUAL` in
  Render env. (The billing card hides itself until these exist. The **superadmin
  On/Off toggle already works without Stripe** — flip Plan Room on for your own
  company to use it now.)
- **R2 bucket CORS:** allow `PUT` + `content-type` from the app origins
  (opsfloa.com / www / dev / stage) on the plan-tools bucket — needed for the ☁
  share-upload path (M4). Reads/copy-down work without it.

**Plan Room — optional / later:**
- **Orphan sweep:** set `R2_ORPHAN_SWEEP=1` in Render — but ONLY on the
  environment whose DB exclusively owns the bucket (if stage & prod share a
  bucket, one env's sweep deletes the other's files). Cleans up abandoned
  presigned uploads.
- **Smoke-test Plan Room end-to-end** on dev: open a plan set (PDF + an aerial
  image), mark up, calibrate + measure against a known dimension, share to the
  company + copy it down on another browser profile, export the flattened PDF,
  and confirm the locked card shows for a company without the add-on.

**Takeoff layer (M7 shipped — roofing pack):**
- **Stripe:** the $60 takeoff layer reuses the existing `addon_takeoff` product.
  Decide whether to move its price to ~$60 (new price IDs; existing subscribers
  keep their legacy price automatically). The superadmin Takeoff toggle already
  turns the roofing tools on for your own company with no Stripe change.
- **Verify the roofing math** against a hand calc (a plane's squares, a
  hip/valley pitch-corrected LF) before selling it.
- The sitework-consolidation cutover confirmation is yours when it comes.

## 📖 Done / shipped log
*Landed on `dev`, newest first. (What happens past dev is handled outside this doc.)*

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
