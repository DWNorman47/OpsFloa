# Rate-aware overtime — one adaptable pay engine for any use case

**Goal (David, 2026-07-26):** the app must be accurate for wildly different
customers — an Oregon excavator bouncing between government prevailing-wage jobs
and civilian jobs in a single day, a Kentucky call center, a Honduran elevator
company — with **no country's or state's rules hardcoded.** Rules are
configuration; the engine applies whatever each company set.

This plan supersedes the narrower `certified-payroll-ot.md` (the WH-347 is just one
consumer of the fixed engine).

## What's already adaptable (don't rebuild)

OT threshold, multiplier, daily-vs-weekly, tiers, rest-day, 7th-day are all
per-company settings (`hours_rules` / `otConfig`), per-role too. Nothing is
US-specific. So:

- **Kentucky call center** → set weekly-40 (or OT off). Works today.
- **Honduras elevator co** → set their local threshold + multiplier (e.g. daily-8
  @ 1.25×). Works today, because the numbers are config, not code.

## The one real gap

When a worker earns **more than one rate** in a period — prevailing on a government
job, civilian on the next, or any job-to-job rate change — those hours are paid
**flat, no overtime**. `computeOT` / `annotateEntryOvertime` hard-exclude
non-`regular` wage types (`payCalculations.js:533`); `buildPayStatement` prices
prevailing as a separate flat bucket (`payStatement.js:57-63`). That's what breaks
the Oregon excavator, and it's what makes the app accidentally construction-shaped.

## The fix: rate-aware OT, "rate when worked"

Make the engine price overtime **per hour at the rate that hour earned**:

1. **One stream toward the threshold.** All of a worker's worked hours (regular +
   prevailing, any rate) count together toward their configured daily/weekly OT
   threshold. (Today regular and prevailing are counted separately, so neither
   trips the other's overtime.)
2. **OT attributed to the crossing hours.** The hours that push past the threshold
   are the overtime — chronologically, the later ones (the engine already fills
   straight-time earliest-first for regular; extend it to all worked hours).
3. **Each OT hour paid at its own base rate × the multiplier.** Prevailing OT at
   the prevailing rate, civilian OT at the civilian rate.

**Why "rate when worked" and not the US "weighted-average blended rate":** it's the
one method that generalizes worldwide — "you get the OT premium on whatever you were
earning when you went into overtime." Weighted-average is a US-FLSA-specific wrinkle;
if a US customer ever needs it, it becomes a per-company toggle, not the default.
Fringe (already modeled separately in `worker_fringes`) stays straight-time on all
hours and is shown as its own column, never multiplied.

## The scenario matrix = the spec of "accurate"

These are the locked targets. Each becomes a test; **David confirms these read
right, since the engine code won't.** (All use the company's *configured* rule — the
numbers below assume the stated config.)

| # | Use case | Config | Hours | Expected pay |
|---|----------|--------|-------|--------------|
| A | Oregon excavator, prevailing then civilian | daily-8, 1.5× | 6h prevailing @ $45, **then** 4h civilian @ $30 (10h) | ST: 6×45 + 2×30 = $330. OT: last 2h are civilian → 2×(30×1.5)=$90. **$420** |
| B | Same day, **civilian then prevailing** (order matters under this method) | daily-8, 1.5× | 4h civilian @ $30, **then** 6h prevailing @ $45 | ST: 4×30 + 4×45 = $300. OT: last 2h are prevailing → 2×(45×1.5)=$135. **$435** |
| C | Kentucky call center (no prevailing) | weekly-40, 1.5× | 45h regular @ $18 | 40×18 + 5×(18×1.5) = **$855** (unchanged from today — proves non-construction still works) |
| D | Honduras elevator co (local rule) | daily-8, **1.25×** | 9h @ L.100 | 8×100 + 1×(100×1.25) = **L.925** (proves no US assumptions) |
| E | Pure prevailing week (the WH-347 core case) | weekly-40, 1.5× | 48h prevailing @ $45 | 40×45 + 8×(45×1.5) = **$2,340** |
| F | Break > shift, mixed rates | any | dirty data | never negative; clamps to 0 (already fixed) |

If any expected number is *not* what that business would actually pay, we change the
row before writing code — that's the whole point of doing this first.

## Non-negotiable safety net

- **Every surface agrees.** Worker invoice, payroll CSV, pay stub, and WH-347 all
  read the same `buildPayStatement` — a test asserts identical gross for the same
  worker/week. The paycheck can never disagree with the compliance report.
- **No regression for existing customers.** Every current pay test stays green
  unchanged; a company with a single rate and no prevailing gets byte-identical
  results (rate-aware pricing collapses to today's math when there's one rate).
- **Ships to `dev` only.** David reviews the PR (via the scenarios, not the engine)
  before it ever reaches a real paycheck.

## Build order

1. ✅ **Scenario tests + the calculator + the method setting** (increment 1, done
   2026-07-26). `utils/rateAwareOvertime.js`, `constants/payEnums.js`,
   `overtime_rate_method` setting, `rateAwareOvertime.test.js` (A–F pass).
2. ✅ **Integrate into `buildPayStatement`** (increment 2, done 2026-07-26). Gated on
   `hasSimpleOtConfig` + hourly; premium configs (tiers/rest-day/7th-day/window/
   night) and daily-rate workers keep the existing per-band path. Regular-only and
   prevailing-under-threshold are byte-identical (whole existing suite green);
   prevailing-over-threshold now earns OT. The four surfaces that read the statement
   — worker invoice, payroll CSV, pay stub, overtime report — get it for free.
3. ⬜ **Consolidate the 4 duplicate engines** that never went through
   `buildPayStatement` and now DISAGREE with it (still pay prevailing flat):
   - `routes/admin.js` `GET /projects/:id/bill` (project bill route) — its own OT
     engine; prevailing flat at ~:1710.
   - `routes/qbo.js` `computeGroupOvertime` (~:796) — OT on regular only, premium
     off `hourlyRate`.
   - `routes/admin.js` certified-payroll (~:3457) — the WH-347; also needs its
     per-day ST/OT grid (see `certified-payroll-ot.md`).
   - `client/src/components/WorkerSummary.jsx:108` — a client-side *estimate*
     (labeled "estimated"); lowest priority.
   Route each through `buildPayStatement` / the shared calculator so every surface
   agrees. Until then there's a known dev-only gap: the worker invoice pays
   prevailing OT while these four still show it flat.
4. ⬜ **Cosmetic:** the `Overtime Pay (1.5×)` labels in `BillPDF.jsx:262` /
   `ProjectBillPDF.jsx:182` / `ProjectsPage.jsx:1111` imply `otHours × workerRate ×
   1.5`, which no longer reproduces the now-blended `cost.overtime` when OT spans two
   rates. The dollar figure is right (read from `cost.overtime`); only the implied
   arithmetic in the label is stale.
5. ⬜ **UI:** a settings toggle for `overtime_rate_method` (rate-when-worked /
   weighted-average), EN+ES.

## Known edge to decide later, not guess now

- **Weighted-average blended rate** as a US-compliance option (per-company toggle).
- **Tiered OT × multiple rates** in the same bucket (e.g. CA >12h at 2× while rates
  switch mid-day) — the per-entry/per-band attribution handles it, but it's the
  gnarliest test case; pin it explicitly in step 2.
