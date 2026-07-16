# OpsFloa — Demolition takeoff pack (inside the Plan Room Takeoff layer)

Status: **D1 shipped; D2–D3 remaining** (2026-07-16). The **10th** takeoff trade in Plan Room,
included in the **$60 Takeoff** add-on — no own SKU.

## The buyer
Sitework and demo contractors — the **same buyer as Earthwork and ESC**, on the
same plan set. Finishes the sitework suite: a site contractor now takes off the
demo, the cut/fill, and the ESC plan for one job without leaving the tool.

## The domain motion
Areas and counts — no new geometry. The value is entirely in the **debris
conversion**: turning a footprint or a slab into loose CY, tons, and truck loads,
which is the number demo is actually bid and scheduled on.

## Trade shape (mirrors Siding / Striping / ESC)
- New trade `demo` (💥), trade-dropdown option, body class `trade-demo`, toolbar
  sub-row (`tr-dem`), side panel (`demPanel`), bid section.
- `state.demo` project settings (shape fixed in D1): swell %, truck capacity CY,
  and a default thickness per pavement type.

## The two-families problem (why one area kind, two formulas)
A building and a slab both trace as an area but convert to debris completely
differently, and getting this wrong is the whole pack:

- **Buildings** are mostly **air**. Footprint × height would be wildly wrong — a
  1,000 SF single-story house doesn't yield 444 CY of debris, it yields the
  walls, roof and floor. So buildings use an empirical **CY of debris per SF of
  footprint**, by construction type (wood ≈ 0.25, masonry ≈ 0.45, steel ≈ 0.20 —
  steel is lower because the frame goes to scrap, not the pile). The factor
  already accounts for bulking.
- **Pavements / slabs** are solid, so they use **thickness × swell**: broken
  concrete and asphalt bulk up ~40–60% once ripped, and hauling the un-swelled
  volume under-books trucks by half a load on a small job and many loads on a
  big one.

One `dmarea` kind carries the type; the math branches on it — the same shape
`escarea` uses.

## Takeoff motions
- **Demo areas (Area → `dmarea`, D1):** trace a footprint or slab → SF by
  **type** → debris CY, tons, and **truck loads**.
- **Linear removals (Line → `dmline`, D2):** curb & gutter, sidewalk strip, pipe,
  fence, guardrail → LF by type.
- **Items & structures (Count → `dmitem`, D3):** tree, light pole, sign, catch
  basin, manhole, hydrant → EA by type.

## Materials math (rates editable, into the shared bid)
- **Buildings:** CY = SF × CY/SF factor (bulking included).
- **Pavement:** CY = SF × (thickness ÷ 12) ÷ 27 × (1 + swell%).
- **Tons:** CY × in-place density ÷ 2000, per type.
- **Haul:** loads = ⌈total debris CY ÷ truck capacity⌉ — the same truck-count
  idea the earthwork pack uses, but with **its own `truckCap` setting** rather
  than reading `state.earthwork.truckCap`. Coupling the two would mean changing
  the earthwork setting silently re-prices the demo bid.
- **Linear / items (D2–D3):** installed $/LF and $/EA — removal and haul are in
  the unit price the way they're quoted, so they do **not** add to the CY pile.
  The panel says so, or the loads look under-counted.

## Milestones (each committable to `dev`, push after each)
- **D1 — trade + demo areas** ✅ *shipped*: `demo` trade (💥) + `dmarea` area kind (3 building
  types + 4 pavement types, double-click to change); swell / truck-capacity /
  per-type thickness settings; bid = per-type demo SF at seeded $/SF + haul
  loads; panel shows SF by type, debris CY + tons, and the load count.
  Persists in projectData + all 5 load paths.
- **D2 — linear removals**: `dmline` line kind → LF by type; bid LF lines.
- **D3 — items & structures**: `dmitem` count kind → EA by type; bid EA lines.

## Verification
- D1: 1,000 SF wood building = 250 CY (0.25 CY/SF); 10,000 SF of 3" asphalt =
  92.6 CY in place → **138.9 CY at 50% swell** → 12 loads at 12 CY/truck; a 6"
  concrete slab uses its own thickness, not asphalt's; a masonry building doesn't
  use the pavement formula. Empty settings fall back to the documented defaults;
  no divide-by-zero at truckCap 0.
- Structural: `dmarea` in `NEEDS_SCALE` + `CLOSED_KINDS`; every kind in
  `hitMarkup`, `MK_LABEL`, `MK_ICON` (an unlisted kind is silently unclickable —
  see `docs/WORKLOG.md` 2026-07-16). Math checked by lifting the real functions
  out of `app.js`. `app.js` parses;
  `git status --porcelain client/public/tool-apps/sitework/` clean.
