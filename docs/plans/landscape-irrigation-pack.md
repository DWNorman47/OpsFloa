# OpsFloa — Landscape & Irrigation takeoff pack (inside the Plan Room Takeoff layer)

Status: **L1–L3 all shipped — pack complete** (2026-07-16). The **12th** takeoff trade in Plan Room
and the **last of the takeoff-siblings list** in `project_tool_roadmap`, included
in the **$60 Takeoff** add-on — no own SKU.

## The buyer
Landscape contractors and the site contractors who sub them — the same site plan
that already gets Earthwork / ESC / Demo / Striping / Fencing takeoffs also
carries the landscape and irrigation plan. High-volume, everyday work.

## The domain motion
Areas, counts and lines — nothing new geometrically. The value is the material
conversion (mulch CY, sod SY, rock tons) and the plant/head schedule, which is
otherwise counted by hand off the plan with a highlighter.

## Trade shape (mirrors Fencing / Demo / Siding)
- New trade `landscape` (🌳), trade-dropdown option, body class
  `trade-landscape`, toolbar sub-row (`tr-lsc`), side panel (`lscPanel`), bid
  section.
- `state.landscape` project settings: mulch depth, rock depth, bed-soil depth,
  rock density, sod waste %, lawn-seed rate (lb / 1000 SF).

## Bid units: a deliberate departure from the other packs
The last four packs all bid an **installed $/unit** with materials derived as a
panel-only cost basis (striping's paint, demo's haul, fencing's posts) — because
those trades quote that way and billing the material again would double-charge.

**Landscape is different and bids in the material's own unit**: mulch is bought
and sold by the **CY**, rock by the **ton**, sod by the **SY**. Quoting mulch per
SF would be the unnatural choice here. So in this pack the materials math **is**
the bid rather than a cost basis, and there's no double-count risk because each
area type produces exactly one line in exactly one unit.

Seed is the exception: seeding is quoted per SF, so it bids by SF with the
**lbs shown in the panel** as the buying number.

## Takeoff motions
- **Areas (Area → `lsarea`, L1):** trace → SF by **type** — mulch bed, sod,
  lawn seed, decorative rock, planting bed (soil prep) → CY / SY / tons / lbs.
- **Plants (Count → `lsplant`, L2):** tree 2″/3″ cal, shrub 5/3 gal, perennial,
  ornamental grass → EA by type.
- **Irrigation (Line → `lsline` + Count → `lshead`, L3):** mainline, lateral,
  drip tubing, sleeve, steel edging → LF; spray/rotor heads, drip emitters, zone
  valves, controller, backflow → EA.

## Materials math (rates editable, into the shared bid)
- **Mulch:** CY = SF × (depth ÷ 12) ÷ 27 — bid by CY.
- **Rock:** CF = SF × (depth ÷ 12); tons = CF × density ÷ 2000 — bid by ton.
- **Bed soil:** CY = SF × (depth ÷ 12) ÷ 27 — bid by CY.
- **Sod:** SY = SF × (1 + waste) ÷ 9 — bid by SY.
- **Seed:** lbs = SF ÷ 1000 × rate — bid by SF, lbs shown in the panel.

Each depth is **per type** (mulch 3″, rock 3″, bed 6″ by default), not one shared
number — a 3″ mulch bed and a 6″ soil-prep bed on the same plan are normal.

## Milestones (each committable to `dev`, push after each)
- **L1 — trade + areas** ✅ *shipped*: `landscape` trade (🌳) + `lsarea` area kind (5 types,
  double-click to change); per-type depth / density / waste / seed-rate settings;
  bid = each type in its own material unit; panel shows SF by type plus the
  converted quantities. Persists in projectData + all 5 load paths.
- **L2 — plants** ✅ *shipped*: `lsplant` count kind → EA by type; bid EA lines.
- **L3 — irrigation** ✅ *shipped*: `lsline` line kind → LF by type + `lshead` count kind →
  EA by type; bid LF + EA lines.

## Verification
- L1: a 1,000 SF mulch bed at 3″ = **9.26 CY**; 1,000 SF of rock at 3″ @ 100
  lb/ft³ = **12.5 tons**; 900 SF of sod at 5% waste = **105 SY**; 5,000 SF of
  lawn seed at 5 lb/1000 SF = **25 lb**; a 6″ bed uses its own depth, not the
  mulch 3″. Each type bids in its own unit and only its own unit.
- Structural: `lsarea` in `NEEDS_SCALE` + `CLOSED_KINDS`; `lsline` in
  `NEEDS_SCALE`; `lsplant`/`lshead` in `POINT_KINDS`; every kind in `hitMarkup`,
  `MK_LABEL`, `MK_ICON` (an unlisted kind is silently unclickable — see
  `docs/WORKLOG.md` 2026-07-16). Math checked by lifting the real functions out
  of `app.js`. `app.js` parses;
  `git status --porcelain client/public/tool-apps/sitework/` clean.
