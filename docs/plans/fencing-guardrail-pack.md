# OpsFloa — Fencing & Guardrail takeoff pack (inside the Plan Room Takeoff layer)

Status: **F1–F3 all shipped — pack complete** (2026-07-16). The **11th** takeoff trade in Plan Room,
included in the **$60 Takeoff** add-on — no own SKU.

## The buyer
Fence contractors, and the site contractors who sub them — another trade riding
the same site plan that already gets an Earthwork / ESC / Demo takeoff. Fencing
is high-repetition, low-complexity work where a $1,500/yr seat is absurd, which
is the whole "focused browser tool" play.

## The domain motion
Fence is a Line trade: trace the run, get LF. The value is the **post count**,
which is the thing a fence estimator actually derives by hand — and it's derived
**per run**, not from total LF (see below).

## Trade shape (mirrors Demo / Siding / Striping)
- New trade `fence` (🚧), trade-dropdown option, body class `trade-fence`,
  toolbar sub-row (`tr-fnc`), side panel (`fncPanel`), bid section.
- `state.fence` project settings: post-hole diameter (in), hole depth (in),
  concrete bag yield (CF/bag).

## Posts are per-run, not per-total
Each run needs a post at **both ends**, so posts = ⌈LF ÷ spacing⌉ + 1 **for every
run separately**. Summing the LF first and computing once is the obvious
shortcut, and it's wrong: two 50-ft runs at 10-ft spacing are 6 + 6 = **12**
posts, not ⌈100/10⌉+1 = **11**. The error compounds — a 20-run job loses 19
posts, plus their concrete. (Same shape as the framing pack's studs-per-wall.)

Spacing is a property of the fence **type**, not a project setting: chain link
runs at 10 ft, vinyl privacy at 6, guardrail at 6.25 (the standard W-beam post
spacing). One project-wide spacing number would be wrong for every mixed job.

## The installed-price trap (third time this has come up)
`$/LF` for fence is an **installed** price — posts, rails, fabric and concrete
are already inside it. So the post count and its concrete are a **panel cost
basis, never bid lines**, or the job bills its own posts twice. Same call as the
striping pack's paint gallons and the demo pack's haul-inside-unit-price. Gates
*are* separate line items — they genuinely are quoted on top of the LF.

## Takeoff motions
- **Fence runs (Line → `fnline`, F1):** trace a run → LF by **type** (chain link
  4′/6′, wood privacy, vinyl privacy, ornamental aluminum, farm/field, W-beam
  guardrail, cable rail), each carrying its own post spacing → LF + posts.
- **Gates & end treatments (Count → `fngate`, F2):** walk gate, double drive
  gate, cantilever slide, guardrail end treatment → EA by type.
- **Post concrete (F3):** posts × hole volume → CY + 60-lb bags, panel-only.

## Materials math (rates editable, into the shared bid)
- **Fence:** installed $/LF per type — the only bid line for the run.
- **Posts (cost basis):** ⌈LF ÷ type spacing⌉ + 1, per run.
- **Gates:** installed $/EA — a real bid line, on top of the LF.
- **Concrete (cost basis, F3):** hole CF = π × (dia ÷ 2 ÷ 12)² × (depth ÷ 12);
  CY = posts × CF ÷ 27; bags = posts × CF ÷ bag yield.

## Milestones (each committable to `dev`, push after each)
- **F1 — trade + fence runs + posts** ✅ *shipped*: `fence` trade (🚧) + `fnline` line kind
  (8 types with per-type spacing, double-click to change); bid = per-type LF at
  seeded installed $/LF; panel shows LF + posts by type. Persists in projectData
  + all 5 load paths.
- **F2 — gates & end treatments** ✅ *shipped*: `fngate` count kind → EA by type; bid EA lines.
- **F3 — post concrete** ✅ *shipped*: hole dia/depth/bag settings → CY + bags from the post
  count, panel-only.

## Verification
- F1: **two 50-ft runs at 10-ft spacing = 12 posts, not 11** (the per-run
  assertion); a 100-ft vinyl run at 6-ft spacing = 18 posts and prices at $42/LF,
  not chain link's $18; same-type runs roll up on the bid but keep their posts
  counted per run.
- F3: 12 posts at 10″ × 30″ = 1.36 CF each → 0.61 CY → 37 bags at 0.45 CF/bag.
- Structural: `fnline` in `NEEDS_SCALE`; `fngate` in `POINT_KINDS`; every kind in
  `hitMarkup`, `MK_LABEL`, `MK_ICON` (an unlisted kind is silently unclickable —
  see `docs/WORKLOG.md` 2026-07-16). Posts/concrete asserted **absent** from the
  bid. Math checked by lifting the real functions out of `app.js`. `app.js`
  parses; `git status --porcelain client/public/tool-apps/sitework/` clean.
