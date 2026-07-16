# OpsFloa — Erosion & Sediment Control takeoff pack (inside the Plan Room Takeoff layer)

Status: **E1–E3 all shipped — pack complete** (2026-07-16). A new takeoff **trade** in Plan Room
(alongside Roofing, Earthwork, Drywall & Paint, Flooring & Tile, Framing &
Lumber), included in the **$60 Takeoff** add-on — no own SKU.

## The buyer
Sitework / grading contractors and their SWPPP subs — the **same buyer already
using the Earthwork trade, on the same plan set**. Every grading permit requires
an ESC / SWPPP sheet, so the ESC takeoff rides along with the cut/fill job it's
already being priced next to. Highest-synergy sibling to the Earthwork flagship,
and the cheapest of the remaining packs to build.

## The domain motion
An ESC sheet is perimeter lines, point BMPs, and stabilized areas — so it maps
cleanly onto the three engines already built, one per milestone: **Line** (silt
fence LF), **Count** (inlet protection EA), **Area** (construction entrance /
seeding SF → tons, SY, lbs). No new geometry math — the value is the BMP type
taxonomy plus the material conversions.

## Trade shape (mirrors Framing / Flooring)
- New trade `esc` (🌱), trade-dropdown option, body class `trade-esc`, toolbar
  sub-row (`tr-esc`), side panel (`escPanel`), bid section.
- `state.esc` project settings (shape defined in E1 so persistence is wired
  once; the E3 fields are unused until then): construction-entrance stone depth,
  stone density, seed rate, mulch rate, blanket waste %, riprap depth.

## Takeoff motions
- **Perimeter / linear controls (Line → `escline`, E1):** trace a run → LF by
  **type** — silt fence, super silt fence, compost sock, straw wattle, tree
  protection fence, diversion berm, turbidity curtain.
- **Point BMPs (Count → `escitem`, E2):** click each → EA by **type** — inlet
  protection (drop / curb), rock check dam, concrete washout, dewatering bag.
- **Stabilized areas (Area → `escarea`, E3):** trace → SF by **type** —
  construction entrance, erosion blanket, hydroseed, riprap → tons / SY / lbs.

## Materials math (rates editable, into the shared bid)
- **Linear / point:** installed unit prices ($/LF, $/EA) — labor baked in, the
  way ESC is actually bid. No separate labor line (unlike the framing pack).
- **Construction entrance:** SF × depth/12 → CF → CY → **tons** (× density).
- **Erosion blanket:** SF × (1 + waste) ÷ 9 → **SY** (overlap waste).
- **Hydroseed:** SF ÷ 43,560 → **acres** → **seed lbs** (× rate) + **mulch tons**.
- **Riprap / outlet protection:** SF × depth/12 → CF → CY → **tons**.

## Milestones (each committable to `dev`, push after each)
- **E1 — trade + linear controls** ✅ *shipped*: `esc` trade (🌱, dropdown +
  `tr-esc` toolbar + `escPanel` + bid section) + `escline` line kind (7 BMP
  types, per-run type attribute; double-click a run to change its type); LF by
  type; bid = per-type LF at seeded installed $/LF; panel shows LF-by-type +
  total. Persists in projectData + all 5 load paths.
- **E2 — point BMPs** ✅ *shipped*: `escitem` count kind (inlet protection
  drop/curb, rock check dam, concrete washout, dewatering bag) → EA by type,
  double-click a group to change its type; bid EA lines at seeded installed
  $/EA; panel "Point controls" section. Registered in `POINT_KINDS` (1 click per
  BMP, no rubber band) — the framing pack's `fopening` was left out, which is
  why it wrongly needs 2 clicks.
- **E3 — stabilized areas + materials** ✅ *shipped*: `escarea` closed-polygon
  kind (construction entrance / erosion blanket / hydroseed / riprap, per-area
  type, double-click to change) → SF by type, converted to stone tons, SY, and
  seed/mulch by `escMaterials()` — shared by the bid and the panel so the two
  can't drift. Registered in `NEEDS_SCALE` + `CLOSED_KINDS`. The `state.esc`
  rate settings (defined back in E1) are now live and editable, and the rate
  inputs render only for the area types actually traced, so an empty panel
  isn't six numeric fields of noise.

## Verification
The material math is checked by lifting `escTotals`/`escMaterials`/`escBidLines`
**verbatim out of app.js** and running them against stubbed state, rather than
re-implementing the formulas in the test (which would only re-derive the same
mistakes). All pass:
- 5,000 SF entrance @ 6" / 105 lb/ft³ → 92.59 CY, **131.25 tons** → $4,593.75
- 10,000 SF blanket @ 10% overlap → **1,222.2 SY**
- 43,560 SF hydroseed = **1.00 acre** → 200 lb seed, 2.0 ton mulch
- 500 SF riprap @ 12" → **26.25 tons**
- 400 LF silt fence @ $2.50 → **$1,000**; 4+3 drop inlets → **7 EA / $1,050**
- same-type runs/groups roll up; different types stay separate lines
- an empty `state.esc` still yields 131.25 tons (defaults hold)
- an uncalibrated sheet refuses `escline`/`escarea` and sends you to 📏
- `app.js` parses; `git status --porcelain client/public/tool-apps/sitework/` clean.

## Two pattern deviations (deliberate — the earlier packs got these wrong)
- **`NEEDS_SCALE`**: `escline` (and `escarea` in E3) are registered, because they
  produce LF/SF. The drywall / flooring / framing packs omitted their
  scale-needing kinds, so those tools let you trace on an uncalibrated sheet and
  silently return 0. Filed in `docs/BACKLOG.md` rather than fixed here.
- **`POINT_KINDS`**: `escitem` will be registered in E2. The framing pack's
  `fopening` was left out, so it wrongly rubber-bands and needs 2 clicks — don't
  copy that.
- **Panel mutual exclusion**: each panel toggle used to hard-code a list of the
  *other* panels to close, and the lists had already drifted (opening Floor left
  Framing open). E1 replaces them with a `closeOtherPanels(keepId)` helper over a
  single `PANEL_IDS` list, so the 7th panel doesn't repeat the bug.
