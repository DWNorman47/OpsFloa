---
name: project_storm_utility_module
description: Deferred paid add-on idea — an invert-driven Storm/Utility takeoff module (deeper version of the sitework takeoff tool)
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-07-24T05:22:36.705Z
---

**In progress (2026-07-15):** building the dedicated **Storm-drain / underground-utility takeoff module** as a **separate paid add-on**, priced **$20/mo ($200/yr) as a light upsell on top of the Takeoff layer** (reconsidered down from $50 — the deep features present thin in the UI, so it's an upsell, not a standalone product; name it "Storm/Utility" and sell it on the "invert-driven depth" hook) (fits [[project_product_vision]] — specialized depth a subset pays extra for; anchored far below AGTEK/Trimble-class $1,500–4,000/yr). It's the *deep* version of the takeoff, **built inside Plan Room** (extends the `qline`/`qcount` takeoff) — NOT the sitework tool (untouched per [[feedback-never-break-sitework]]). Full milestone plan: `docs/plans/storm-utility-pack.md`. **M1–M5 all shipped (module complete, 2026-07-15):** M1 pipe schedule (Ø + material, auto width, bid rollup by Ø × material); M2 structure depth (VF pricing + type × depth schedule); M3 invert-driven depth (optional end-depth → average-end-area CY); M4 spoil/backfill netting (pipe volume + Native/Import toggle → net export + import backfill); M5 billing — `addon_storm` flag (migration 0139) + `STRIPE_PRICE_STORM`(~$50) wired through stripe.js/auth/superadmin, deep fields gated in the Plan Room tool via `STORM_ON`/`body.has-storm`. **ON SALE (2026-07-23):** `STORM_SELLABLE=true` in `BillingPanel.jsx` — David opened it for purchase. Storm→Takeoff dependency now enforced end-to-end (server `/checkout` + `/addon` `takeoff_required`, manage-list gate, checkbox pulls Takeoff in). ⚠️ **Two live-gates remain:** (1) `STRIPE_PRICE_STORM`(+`_ANNUAL`, ~$20) must be set or the buy card stays hidden; (2) the utility/excavation math was flipped on WITHOUT the hand-verification this flag originally guarded — David's call, but verify on a real utility job. Set `STORM_SELLABLE=false` to pull it. Plan doc: `docs/plans/storm-utility-pack.md`.

**Already shipped (the quick win, commit 04e4e6d):** pipe-size Line presets (12/18/24/36" trench widths) + storm-structure Count presets (Inlet, Junction box, Cleanout, FES, Area drain). The Line tool already does pipe LF + trench excavation CY + bedding CY; Count does structures EA; it all prices in the Bid report.

**The 4 gaps this add-on would close (what the presets do NOT do):**
1. **Pipe schedule** — size/material → auto trench width, and pipe LF broken out by diameter/material (today width is manual, and everything is one generic "pipe").
2. **Invert-driven per-segment depth** — compute trench depth from rim/invert elevations + pipe slope, varying along the run (today the Line tool takes ONE constant depth per takeoff; workaround is tracing each structure-to-structure segment with an average depth). The `▚ Wall` tool already measures depth off traced contours — that mechanism could be reused.
3. **Structure depth** — a 12-ft manhole costs far more than a 4-ft catch basin, but the Count tool is depth-blind (EA only).
4. **Spoil vs. import backfill netting** — export = excavation − pipe volume − bedding − backfill (today it gives excavation + bedding but no net export for utility trench).

**Why monetizable:** utility contractors pay for invert-driven depth + a pipe schedule that generic earthwork tools lack. Related backlog: [[project_tool_roadmap]].
