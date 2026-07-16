# OpsFloa — Flooring & Tile takeoff pack (inside the Plan Room Takeoff layer)

Status: **F1–F3 all shipped — pack complete** (2026-07-15). A new takeoff **trade** in Plan Room
(alongside Roofing, Earthwork, Drywall & Paint), included in the **$60 Takeoff**
add-on — no own SKU. Completes the interiors story next to Drywall & Paint.

## The buyer
Flooring contractors and interior GCs pricing floor finishes — tile, LVP/laminate,
hardwood, carpet, sheet vinyl. Everyday, high-volume interior work; same
"focused browser tool vs. PlanSwift/STACK" play as the other packs.

## The domain motion
Floors are plan-view area, so this reuses the **Area engine** directly (unlike
roofing's pitch or drywall's height): trace each room as a polygon → floor SF,
by material, with waste. The color-coded per-material rollup mirrors the sitework
area takeoff.

## Trade shape (mirrors the Drywall pack)
- New trade `flooring` (🟫), trade-dropdown option, body class `trade-flooring`,
  its own toolbar sub-row (`tr-floor`), side panel (`floorPanel`), and bid section.
- `state.flooring` project settings: `waste` %, tile size + grout joint (for tile
  material math), default material.

## Takeoff motions
- **Rooms (Area tool → `froom`):** trace a room polygon → floor SF; per-room
  **material** attribute (tile / LVP / laminate / hardwood / carpet / vinyl).
  Group + roll up SF by material.
- **Transitions (Line tool → `ftrans`, F2):** thresholds / reducers / T-molding /
  stair-nose runs → LF by type.

## Materials math (rates editable, into the shared bid)
- **All floors:** net SF → material SF × (1 + waste%); install labor SF;
  underlayment SF (F2).
- **Tile (F3):** thinset (bags/SF), grout (lbs/SF from tile size + joint width),
  backer board SF, corner/edge trim.
- Bid: per-material SF lines + install + transitions, through the shared price
  library + bid report, flooring defaults seeded.

## Milestones (each committable to `dev`, push after each)
- **F1 — trade + rooms** ✅ *shipped*: `flooring` trade (▦, dropdown + `tr-floor`
  toolbar + `floorPanel` + bid section) + `froom` room-area kind (closed polygon,
  material attribute; double-click a room to change material); waste %; bid =
  per-material floor SF × (1+waste) at seeded $/SF; panel shows SF-by-material +
  total. Persists in projectData + all load paths. *(Install labor is folded into
  the seeded $/SF for now; split into material + labor lines in F3 if wanted.)*
- **F2 — transitions + underlayment** ✅ *shipped*: `ftrans` line kind
  (threshold / reducer / T-molding / stair-nose / transition strip → LF by type,
  double-click to change type; toolbar tool + type select). Project underlayment
  setting (foam / cork / cement board / uncoupling membrane) → an underlayment SF
  line = total floor SF × (1+waste) at seeded $/SF. Panel shows underlayment +
  transitions LF; bid rolls them up.
- **F3 — tile materials** ✅ *shipped*: project **tile size** + **grout joint**
  settings → **thinset** (bags by coverage, default 95 SF/bag) and **grout**
  (lbs & 25-lb bags via the (L+W)/(L·W) × joint × thickness × 14.5 lbs/SF formula,
  0.375" assumed thickness) for the tile rooms' SF. Panel "Tile materials" section
  + bid lines. *(Backer board is the F2 cement-board underlayment; edge trim is an
  F2 transition — not duplicated here.)*

## Verification
- F1: a 12×15 room as tile = 180 SF gross → material SF = 180 × 1.10 (10% waste);
  two rooms of the same material roll up as one line; a carpet room and a tile
  room show as two lines. `app.js` parses; `git status --porcelain sitework/` clean.
