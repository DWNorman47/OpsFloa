# OpsFloa — Storm / Utility takeoff pack (deep underground-utility module)

Status: **M1 in progress** (2026-07-15). The deep, invert-driven version of the
storm-drain / underground-utility takeoff — a **separate paid add-on** on top of
the Takeoff layer (target **~$50/mo**, `$500/yr`; anchored far below AGTEK /
Trimble-class incumbents at $1,500–4,000+/yr). Sold to utility / underground
contractors who need what generic earthwork can't do.

## Where it's built
Inside **Plan Room**, extending the existing line/trench takeoff (`qline`) and
structure count (`qcount`) — NOT the standalone sitework tool (untouched per the
never-break-sitework rule). The quick-win presets already shipped in both tools
(pipe-size line presets, storm-structure count presets); this pack adds the depth
those presets don't have.

## Parity guard
The `qline` trench engine is shared/mirrored with sitework (`PARITY.md`). Every
deep feature here must be **additive** — a basic pipe takeoff with no new fields
set must produce the **same** trench/bedding CY as today, so the sitework parity
cutover gate (planroom-sitework-pack S4) still holds. New attributes default off.

## The 4 gaps this pack closes
1. **Pipe schedule** — structured size + material (not a freetext label); auto
   trench width from diameter; LF / trench CY rolled up by diameter × material.
2. **Invert-driven per-segment depth** — trench depth from rim/invert elevations
   + pipe slope, varying along the run (today: one constant depth per takeoff).
3. **Structure depth** — a 12-ft manhole ≠ a 4-ft catch basin; price structures
   by depth (VF), not just EA.
4. **Spoil vs. import backfill netting** — net export = excavation − pipe volume
   − bedding − backfill (today: excavation + bedding only, no net).

## Milestones (each committable to `dev`, push after each)
- **M1 — Pipe schedule** *(building now)*: add `dia` (diameter, in) + `mat`
  (RCP/PVC/HDPE/DIP/CMP/VCP/other) to the trench line config; auto-suggest trench
  bottom width from diameter (editable); the bid + on-canvas label roll up pipe
  runs by `Ø × material`. Totals unchanged when `dia`=0 (parity).
- **M2 — Structure depth**: add a `depth` (ft) attribute to `qcount` structures
  (manhole/inlet/catch basin/etc.); price by vertical foot or depth tier; panel
  shows a structure schedule (type × depth × count).
- **M3 — Invert-driven depth**: per-segment trench depth from upstream/downstream
  rim & invert elevations + slope; average-depth-per-segment CY; reuse the
  depth-off-contours mechanism. Trace structure-to-structure segments.
- **M4 — Spoil / backfill netting**: compute pipe volume from `dia`, subtract
  pipe + bedding + backfill from excavation → net export (haul-off) CY; feed the
  haul truck-count.
- **M5 — Billing split**: new `addon_storm` flag — migration + `server/constants`
  + `stripe.js` `ADDON_PRICES` + `requireStormAddon` gate + `BillingPanel` +
  SuperAdmin toggle + `docs/db-enums.md`; `STRIPE_PRICE_STORM` (+`_ANNUAL`) at
  ~$50. Gate the deep features behind it. **Ship last**, once the module is real
  and ready to sell separately. (Pre-launch there are no paying takeoff subs, so
  moving these features from "included in Takeoff" to "paid" strands no one.)

## Verification
- M1: a 100-ft 24" RCP run yields the same trench CY as the old `pipe24` preset;
  two 12" and one 18" run roll up as three schedule lines by Ø; label shows size.
- Each milestone: `app.js` parses; `git status --porcelain sitework/` clean.
