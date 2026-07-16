# OpsFloa — Siding, Gutters & Insulation takeoff pack (inside the Plan Room Takeoff layer)

Status: **Si1–Si3 all shipped — pack complete** (2026-07-16). A new takeoff **trade** in Plan Room
(the 9th, alongside Roofing, Earthwork, Drywall & Paint, Flooring & Tile, Framing
& Lumber, Erosion & Sediment Control, Striping & Signage), included in the **$60
Takeoff** add-on — no own SKU.

## The buyer
Siding/exterior contractors, and **roofers** — roofers sell gutters, so this
reaches the buyer the Roofing pack already targets ("the biggest new market" per
the tool roadmap). It also closes the residential shell story: with Framing →
**Siding** → Roofing → Drywall → Flooring, a builder can take off the whole house
in one tool.

## The domain motion
Elevations are plan-view area, so siding reuses the **Area engine** the way
Flooring did. The real work isn't geometry — it's the **net wall area** (gross
minus openings), the material taxonomy, and squares as the trade's native unit.

## Trade shape (mirrors Striping / ESC)
- New trade `siding` (▥), trade-dropdown option, body class `trade-siding`,
  toolbar sub-row (`tr-sid`), side panel (`sidPanel`), bid section.
- `state.siding` project settings (shape fixed in Si1 so persistence is wired
  once; the insulation fields go live in Si3): siding waste %, insulation
  waste %, batt coverage (SF/bag).

## Takeoff motions
- **Wall areas (Area → `swall`, Si1):** trace an elevation → SF by **material**
  (vinyl lap, fiber-cement lap/panel, wood lap, stucco, brick veneer, stone
  veneer) — gross area.
- **Openings (Count → `sopening`, Si1):** click each window / door / garage door
  → each **deducts** its SF from the wall area and counts for the bid. Same
  mechanism as the drywall pack's `dopening`.
- **Gutters & downspouts (Line → `sgutter`, Si2):** trace runs → LF by type
  (5"/6" K-style, half-round, downspout, fascia wrap).
- **Insulation (Area → `sinsul`, Si3):** trace → SF by R-value → bags/rolls.

## Materials math (rates editable, into the shared bid)
- **Siding:** net SF = gross − opening deducts; material SF = net × (1 + waste);
  priced per SF, with **squares (÷100)** shown in the panel — squares are how the
  trade actually talks, but SF is the finer bid unit and matches the sibling
  packs.
- **Openings deduct but are not free:** each also bills a trim/wrap allowance EA,
  because cutting siding around an opening costs more than the SF it removes.
- **Gutters (Si2):** installed $/LF per type.
- **Insulation (Si3):** SF × (1 + waste) → bags at coverage SF/bag.

## The net-area trap
Gross elevation area over-bids every house — a wall is mostly windows on some
elevations. `swall` traces gross and `sopening` deducts, so the bid uses **net**.
The panel shows gross, deducts, and net side by side so the deduction is visible
rather than silently applied — if the net looks wrong, the user can see which of
the three is off.

## Milestones (each committable to `dev`, push after each)
- **Si1 — trade + walls + openings** ✅ *shipped*: `siding` trade (▥) + `swall` area kind
  (7 materials, double-click to change) + `sopening` count kind (window / door /
  garage door, per-type deduct SF, double-click to change); waste %; bid =
  per-material net SF × (1+waste) at seeded $/SF + opening trim EA; panel shows
  gross / deducts / net, SF + squares by material, and the opening tally.
  Persists in projectData + all 5 load paths.
- **Si2 — gutters & downspouts** ✅ *shipped*: `sgutter` line kind (5"/6" K-style,
  half-round, downspout, fascia wrap; double-click to change) → LF by type at
  seeded installed $/LF; panel section.
- **Si3 — insulation** ✅ *shipped*: `sinsul` area kind (batt R-13/19/21, blown
  attic R-38/49, spray foam; double-click to change) → SF × (1+waste) at seeded
  $/SF. **Only batts convert to bags** (at the coverage setting) — blown and foam
  are bid straight by SF, so a bag count there would be meaningless. Waste +
  coverage inputs render only when insulation is traced.

## Verification
- Si1: a 1,200 SF elevation with 4 windows (−15 SF ea) and 1 door (−21) = 1,200 −
  81 = **1,119 net SF** → ×1.10 waste = 1,230.9 material SF = **12.3 squares**;
  two vinyl walls roll up as one line while a stucco wall stays separate; a
  garage door deducts 112 SF. Deducts can't drive net below 0.
- Structural: `swall`/`sinsul` in `NEEDS_SCALE` + `CLOSED_KINDS`; `sopening` in
  `POINT_KINDS` + `VERTEX_NONEDIT`; every kind in `hitMarkup`, `MK_LABEL`,
  `MK_ICON` — an unlisted kind is silently unclickable (see `docs/WORKLOG.md`
  2026-07-16). Math checked by lifting the real functions out of `app.js`.
  `app.js` parses; `git status --porcelain client/public/tool-apps/sitework/` clean.
