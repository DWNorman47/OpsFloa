# OpsFloa — Storm / Utility takeoff pack (deep underground-utility module)

Status: **M1–M4 shipped** (2026-07-15) — the full takeoff engine is built.
**M5 (billing split) remaining**, deliberately last (see below). The deep, invert-driven version of the
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
- **M1 — Pipe schedule** ✅ *shipped*: `dia` (diameter) + `mat` on the trench line
  config; diameter auto-suggests trench width; bid + on-canvas label roll up pipe
  runs by `Ø × material`. Totals unchanged when `dia`=0 (parity).
- **M2 — Structure depth** ✅ *shipped*: `depth` (ft) on `qcount` structures; bid
  breaks structures out by type × depth and emits a vertical-feet line (count ×
  depth) so deep structures aren't priced like shallow ones.
- **M3 — Invert-driven depth** ✅ *shipped*: optional `depth2` (end depth) → the
  excavation uses the average end area over a sloped segment; trace structure-to-
  structure and enter depth (= rim − invert) at each end. Constant when unset.
  *(Later refinement: enter rim/invert elevations directly and derive the depths.)*
- **M4 — Spoil / backfill netting** ✅ *shipped*: pipe volume from `dia`; a Native/
  Import backfill toggle → net export (haul-off) CY (native = displaced pipe +
  bedding; import = full excavation) + import-backfill CY. Additive; trench/bedding
  unchanged.
- **M5 — Billing split** *(remaining — ship when ready to sell)*: new `addon_storm`
  flag — migration + `server/constants`
  + `stripe.js` `ADDON_PRICES` + `requireStormAddon` gate + `BillingPanel` +
  SuperAdmin toggle + `docs/db-enums.md`; `STRIPE_PRICE_STORM` (+`_ANNUAL`) at
  ~$50. Gate the deep features behind it. **Ship last**, once the module is real
  and ready to sell separately. (Pre-launch there are no paying takeoff subs, so
  moving these features from "included in Takeoff" to "paid" strands no one.)
  - **Client gate:** the deep fields (pipe Ø/material, End depth, backfill, and
    structure depth) live in the Plan Room tool-app. When the company lacks
    `addon_storm`, hide those fields so a plain trench/count works as before; show
    a small "🔒 Storm/Utility add-on" hint. Read the flag from `tc_addons`/user
    (same mechanism the tool uses for the takeoff gate).

## Verification
- M1: a 100-ft 24" RCP run yields the same trench CY as the old `pipe24` preset;
  two 12" and one 18" run roll up as three schedule lines by Ø; label shows size.
- Each milestone: `app.js` parses; `git status --porcelain sitework/` clean.
- **Before M5 (paywalling):** hand-check the utility math on a known run —
  pipe-volume displacement, average-end-area CY on a sloped segment, and the
  native-vs-import net export — the same "verify before you sell it" gate the
  roofing pack has.
