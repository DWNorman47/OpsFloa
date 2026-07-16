# OpsFloa — Framing & Lumber takeoff pack (inside the Plan Room Takeoff layer)

Status: **Fr1 shipped** (2026-07-15). A new takeoff **trade** in Plan Room
(alongside Roofing, Earthwork, Drywall & Paint, Flooring & Tile), included in the
**$60 Takeoff** add-on — no own SKU.

## The buyer
Framing subs and GCs pricing rough carpentry — wall framing, openings, sheathing.
Same "focused browser tool vs. PlanSwift/STACK" play as the other packs.

## The domain motion
Walls are plan-view lines, so this reuses the **Line engine** (like Flooring
reused Area). Trace each wall run → LF; project stud spacing + height + plate
count drive stud counts, plate lumber, and board-feet. Stud **size** (2×4/2×6/
2×8) is a per-wall attribute (exterior vs interior) that rolls up the material.

## Trade shape (mirrors Drywall / Flooring)
- New trade `framing` (🪵), trade-dropdown option, body class `trade-framing`,
  toolbar sub-row (`tr-fram`), side panel (`framPanel`), bid section.
- `state.framing` settings: stud `spacing` (16/24" OC), wall `height`, `topPlates`
  (1 or 2 — double top plate).

## Takeoff motions
- **Walls (Line tool → `fwall`, Fr1):** trace a wall run → LF; per-wall **stud
  size** (2×4/2×6/2×8). Studs = ⌈LF·12 / spacing⌉ + 1; plate LF = LF × (1 bottom
  + topPlates); board-feet from nominal size. Roll up by stud size.
- **Openings (Count tool → `fopening`, Fr2):** doors/windows → header LF + king/
  jack/cripple studs.
- **Sheathing (Area tool → `fsheath`, Fr3):** wall/floor sheathing SF → 4×8 sheets.

## Materials math (rates editable, into the shared bid)
- **Studs:** count by spacing → EA, priced per stud by size.
- **Plates:** LF × (1 + topPlates) → plate lumber LF, priced per LF by size.
- **Board-feet:** (studs × height + plate LF) × BF/LF (2×4 = .667, 2×6 = 1.0,
  2×8 = 1.333) — shown in the panel as a cost basis.
- **Labor:** wall framing per LF of wall.

## Milestones (each committable to `dev`, push after each)
- **Fr1 — trade + walls** ✅ *shipped*: `framing` trade (🪵) + `fwall` line kind
  (per-wall stud size 2×4/2×6/2×8, double-click to change); spacing (16/24" OC),
  wall height, single/double top-plate settings; bid = studs EA + plate LF by
  size + one wall-framing labor LF line; panel shows per-size LF/studs/plates/BF
  + total wall LF. Persists in projectData + all load paths.
- **Fr2 — openings + headers**: `fopening` count kind → header LF, king/jack/
  cripple studs by opening size.
- **Fr3 — sheathing**: `fsheath` area kind → sheathing SF → 4×8 sheets + nails.

## Verification
- Fr1: a 20-ft 2×4 wall @ 16" OC = ⌈20·12/16⌉+1 = 16 studs; plate LF = 20×3 = 60
  (double top); two 2×4 walls roll up together, a 2×6 wall shows separately.
  `app.js` parses; `git status --porcelain sitework/` clean.
