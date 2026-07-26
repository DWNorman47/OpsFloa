# Certified Payroll (WH-347) — real ST/OT split

**Status:** spec only, blocked on one validation step (see Gate). No pay-math code
until a real WH-347 confirms the rule for the states/crafts we serve.

## Problem

`GET /admin/certified-payroll` (`server/routes/admin.js:3454`) feeds the WH-347.
Today it rounds punches (`roundEntriesFromSettings`) but **never runs OT**: it
buckets raw hours per day into `regular_days` / `prevailing_days` and computes
`gross_pay = regTotal × rate + prevTotal × prevRate` — flat
(`admin.js:3536-3552`). So:

- The WH-347 reports **zero overtime for everyone on it** (regular hours too, not
  just prevailing). WH-347 requires a straight-time / overtime split and OT at
  1.5× the base rate for hours over 40/week (CWHSSA). Any >40h week yields a
  non-compliant form and an understated gross.
- This endpoint **bypasses `buildPayStatement`** — it re-sums hours by hand, which
  is why it drifted from the consolidated pay engine.

## What the audit already resolved

- **Rate is base-only; fringe is separate.** `prevailing_rate` is the project's
  `prevailing_wage_rate` (base); `fringes` / `fringe_total_per_hour` are a separate
  per-category per-hour amount and are excluded from `gross_pay`
  (`admin.js:3540-3551`). This is exactly the WH-347 model (rate of pay + fringe
  shown separately), so **"OT on the base rate, fringe paid straight" needs no
  schema change.**
- Break-clamp bug on this endpoint (`hoursWorked − break/60`, unclamped) — **fixed
  2026-07-26** (it had its own inline copy, so the Batch-6 engine clamp didn't
  reach it).

## Design stance: config-driven, NOT a 50-state ruleset

Anyone in any state can buy this, so we do **not** hardcode state law. Two reasons:
state rules change, and prevailing OT is ultimately fixed by the **wage
determination attached to each contract** (a per-project document) that can
override state law per craft. A built-in 50-state table would rot *and* still miss
determination-specific clauses.

Instead: make the OT config expressive enough to represent any
threshold/rate/premium (it mostly already is), default it sensibly, and let the
**company's own configured rule** drive the report. We're not building "California
prevailing OT" — we're making the WH-347 honor the same OT rule the rest of the app
already honors. That's multi-state by construction because the config is
per-company.

## The rule (what the config must express)

- **Threshold:** federal CWHSSA is weekly >40h; states can add daily (CA >8h/day,
  2× >12h, 7th-day). → **Reuse the company's existing OT config** (`hours_rules` /
  `otConfig`; company-wide + per-role via `effectiveRulesForRole` /
  `otConfigByRoleFactory`). A CA contractor already set daily-8; a federal shop set
  weekly-40.
- **OT rate:** 1.5× (or the configured tier mult) × the **base** rate — the
  prevailing base rate for prevailing hours, the worker's `hourly_rate` for
  regular hours.
- **Fringe:** paid straight-time on all hours (ST and OT alike), never multiplied.
  Already a separate column.
- **Combine streams:** all hours (regular + prevailing) count toward the threshold;
  the OT portion is priced at the rate of the hours that crossed the line.

## The engine boundary that "broad" runs into

The OT engine today is **company-wide + per-role** only — there is **no per-project
or per-classification OT rule** (classification is a separate field from
`role_id`). So:

- A company whose single OT rule covers all its work → Phase 1 is correct and broad.
- A company running a prevailing job whose determination needs daily-8 while its
  regular work is weekly-40, **or** two prevailing jobs in different states, →
  cannot be expressed by company+role config. That's the real extensibility gap,
  addressed in Phase 2.

## Implementation approach

Route the report through the shared engine instead of hand-summing.

1. **Per-entry OT already exists.** `annotateEntryOvertime(paid, rule, threshold,
   weekStart, otConfig)` (`payCalculations.js`) stamps each entry with
   `overtime_hours` within the worker's stream — the pay stubs already use it. Run
   it over each worker's full week (regular + prevailing together) so OT is
   attributed per entry against the combined threshold.
2. **Per-day ST/OT grid.** For each entry, split its paid hours into
   `ot = e.overtime_hours` and `st = duration − ot`, and add to that day's bucket,
   keyed by `wage_type`. Result per worker: `regular_st_days` / `regular_ot_days` /
   `prevailing_st_days` / `prevailing_ot_days` (the WH-347 "O" and "S" sub-rows).
3. **Gross.**
   `gross = Σ(st × baseRate) + Σ(ot × baseRate × otMult) + totalHours × fringePerHour`
   where `baseRate` is `rate` for regular entries and `prevRate` for prevailing.
   Fringe is straight on every hour.
4. **Weekly-vs-daily attribution.** With a weekly (40h) rule, which specific day's
   hours are "OT" is a display convention — `annotateEntryOvertime` already fills
   straight time chronologically and marks the overflow, so the per-day split falls
   out of step 1 with no extra logic. Daily rules map to the grid directly.

Net: delete the manual `hoursWorked`/bucket loop (`admin.js:3513-3521`) and the flat
`gross_pay` (`:3551`); derive both from the annotated entries. Keeps `fringes` /
`prevailing_rate` / SSN / signature plumbing unchanged.

## Client (WH-347 form)

`CertifiedPayroll.jsx` / `CertifiedPayrollPDF.jsx` render `w.regular_total` /
`w.prevailing_total` as single rows today. Add the O/S sub-rows: per-day ST and OT
cells, a rate-of-pay column per (base) and the fringe column already present, and
an OT rate line. `i18n.js` EN+ES keys for the new labels (i18n.test.js parity).

## Phasing

- **Phase 1 — broad by construction.** Route the WH-347 through the shared engine so
  it honors the company's configured OT rule (the Implementation approach above).
  Correct for the majority; multi-state because the config is per-company; no schema
  change.
- **Phase 2 — any state, any job.** Add a **per-project (or per-classification /
  wage-determination) OT override** so a specific prevailing job can carry its own
  threshold + rate independent of the company blanket rule. The engine already
  threads per-*role* config through `roundEntriesFromSettings` (`workerRoleById` →
  `effectiveRulesForRole` / `otConfigByRoleFactory`); per-*project* is the same
  plumbing shape plus a small schema add (`projects.hours_rules` override, or an
  OT-rule field on the wage determination). Ship only if a real customer needs a
  per-job rule that differs from their company rule.

## Gate — an archetype matrix, not one customer's form

Validate against a **matrix of state archetypes** built as test fixtures with
expected outputs derived from published rules, so it doesn't hinge on a single
contractor:

- Federal-only: weekly >40h @ 1.5× base.
- California-style: daily >8h @ 1.5×, >12h @ 2×, 7th-consecutive-day.
- No-state-law state: federal baseline.

Plus the hard invariant: **WH-347 gross must reconcile to `buildPayStatement`** for
the same worker/week. First, confirm the existing config vocabulary can *express*
each archetype (it looks sufficient — daily/weekly/tier/rest-day/7th-day — but prove
it). A real customer's WH-347 is then a welcome sanity check, not the blocker.

## Tests

- A worker with a >40h prevailing week → correct ST (40) / OT (rest) split, OT
  priced at 1.5× prevailing base, fringe straight on all hours.
- A daily-OT (CA-style) config → per-day OT over 8h, 7th-day handled by the engine.
- A mixed regular + prevailing day → hours combine toward the threshold; OT priced
  per the crossing entry's rate.
- Reconcile the WH-347 gross against `buildPayStatement` for the same worker/week
  (anti-drift — the two must now agree).

## Risks

- **Money-critical + compliance-facing.** Mitigate with the Gate + the
  reconcile-against-`buildPayStatement` test.
- **Weekly-OT day attribution** is a convention; document whichever the real WH-347
  uses (chronological-fill is the common one and what the engine already does).
- State prevailing-wage OT can differ from CWHSSA; the "reuse the company's OT
  config" choice handles it **only if** the company configured their rule correctly
  — worth a one-line admin note on the certified-payroll settings.
