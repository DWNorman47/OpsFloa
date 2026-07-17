# OpsFloa — Drywall & Paint trade pack (inside the Plan Room takeoff layer)

Status: **D1 + D2 + D3 built** (D3 2026-07-14). D1: 🧱 trade, wall-run + ceiling
tools, height/sides, board/mud/tape/paint into the bid, panel. D2: openings (🚪
count by type, deduct SF from wall + door/window/opening EA in the bid) and trim
(▁ base/crown/chair → LF). **D3:** texture (smooth/orange/knockdown/popcorn →
$/SF on the finished drywall surface), batt/sound insulation in the wall pass
(single-face wall area × R-type → $/SF), and ACT/drop-ceiling grid takeoff
(per-ceiling type toggle: Drywall vs ACT 2×4 / 2×2 → tiles, main & cross tees,
wall angle, hanger wire, installed $/SF). **D4 (2026-07-14):** interior-elevation
heights — a ↕ measure tool captures a named wall height off an elevation/section
sheet (uses that sheet's own scale); the set of height markers is the reusable
library, applied as the new-run default (🧱 panel) or per-run (double-click a
wall). **The pack is now feature-complete.** A trade pack under the master plan
(`docs/plans/plan-viewer-markup.md`) — no own SKU, no own tool-app; included in
the $60 takeoff layer. Ships **M-later, after the roofing pack (M7)** proves the
integrated takeoff UX. This doc owns the drywall/paint **domain spec** only.

## The buyer
Drywall subs, painting contractors, and GC estimators pricing interiors. Most
do this by hand or in Excel; the generic incumbents (PlanSwift/STACK,
~$1,500–4,000/yr) are the same ones the sitework tool undercuts. Lower per-job
dollars than roofing, but an everyday, high-volume trade.

## The domain nuance: height
Plans are plan-view; drywall/paint quantities are mostly **vertical** surface.
The pack's central move mirrors roofing's pitch-per-plane: a **height
attribute per wall run** (and per-room ceiling height), so LF × height → SF.

## Takeoff motions (all on existing engine tools)
- **Walls (Line tool + attributes):** trace wall runs → LF × height → wall SF.
  Per-run attributes: height (default from a project setting, override per
  run), **sides** (1 for perimeter/against-structure, 2 for interior
  partitions — doubles the SF), finish level. Room/zone grouping reuses the
  color-coded subheader motion.
- **Ceilings (Area tool):** room polygons → ceiling SF (own height attribute
  for paint-cutting/plate math later; MVP just needs SF).
- **Openings (Count tool):** doors, windows, wall openings as counts with
  standard deduct sizes (e.g. door 21 SF, window 15 SF, editable) —
  subtracted from wall SF, and doubling as the trim/paint item counts.
- **Trim (Line tool):** base, crown, chair rail → LF.

## Materials math (rates editable, quantities flow into the bid)
- **Drywall:** net SF → board count by sheet size (4×8 / 4×10 / 4×12 / 54"
  options), waste % (default ~10%); screws per board; joint compound
  (default ~0.053 gal or ~1.4 lb ready-mix per SF-class — express as
  boxes/buckets per 1,000 SF); tape LF per SF; corner bead sticks from a
  corner count. Finish level (L3/L4/L5) scales mud/labor rates.
- **Paint:** wall + ceiling SF → gallons via coverage (default 375 SF/gal) ×
  coats (default 2) + primer option; separate products/prices for walls,
  ceilings, and trim; doors/windows priced EA from the opening counts.
- **Bid:** per-SF hang/finish rates, per-SF paint rates, per-EA/LF items —
  through the shared price library + bid report, drywall/paint defaults
  seeded.

## Delivery
- Pack = presets + attribute prompts (height, sides, sheet size, finish
  level, coats) + materials calculators on the shared engine inside the
  planroom app. Gating: base + takeoff flags (stacked billing) — no
  pack-specific flag.
- Verification: a hand-calced rectangular room (walls, ceiling, one door, one
  window) matches board count, mud, and gallons; a two-room plan with a
  shared partition counts the shared wall at 2 sides exactly once; bid totals
  match manual pricing.

## Later
- ~~texture/specialty finishes~~ — **built D3** (global texture setting, $/SF).
- ~~batt/sound insulation in the same wall pass~~ — **built D3** (single-face
  wall area × R-type, global setting; per-run include is a future refinement).
- ~~act/drop-ceiling grid takeoff~~ — **built D3** (per-ceiling type; grid
  material counts by rule-of-thumb, installed $/SF in the bid).
- ~~interior-elevation takeoff~~ — **built D4** (2026-07-14). The ↕ height tool
  measures a named height off an elevation/section sheet using that sheet's own
  calibrated scale; heights become a reusable library (the markers themselves),
  applied as the new-run default or per wall run. Nothing left deferred.
