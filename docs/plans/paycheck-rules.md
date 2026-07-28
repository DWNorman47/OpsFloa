# Paycheck Rules — customizable pay-cycle + deduction rulesets

## Goal
A new **Paycheck Rules** settings section (parallel to custom Hours & Rules) where an
admin builds **named rulesets**. A ruleset describes *when* paychecks are issued and
*how/when deductions apply*. Rulesets are assigned to employee types **later** — this
phase builds the settings section, the builder UI, and storage. It does **not** yet
wire into the pay engine or assign to workers.

## Driving examples (from David)
1. **Every other Thursday.** Deductions apply only on the *second* Thursday of each
   pair. The deductible amount = (check₁ + check₂ combined) − $11,000; deductions come
   out of that remainder, on the second check.
2. **15th & 30th.** Deductions apply to the *30th*, same math: (15th + 30th) − $11,000,
   deduct from the remainder.

Both reduce to one pattern: **group N paychecks → apply deductions to one of them →
base = combined earnings − an exempt amount → deduct from that base.** Plus a flexible
pay schedule. Keep it very customizable, like the hours-rules builder.

## Storage
New company setting **`paycheck_rules`** — a JSON policy string (mirrors `hours_rules`).
Money stored in **cents** (house convention); the UI edits dollars.

```jsonc
{
  "rulesets": [
    {
      "id": "pr_ab12cd",
      "name": "Biweekly Thursday — garnishment",
      "schedule": {
        "frequency": "biweekly",        // weekly | biweekly | semimonthly | monthly
        "payWeekday": 4,                // weekly/biweekly, 0=Sun … 4=Thu
        "anchorDate": "2026-01-08",     // biweekly: a known payday that sets the cadence
        "daysOfMonth": [15, 30],        // semimonthly: two days ("30" = 30th or last day)
        "dayOfMonth": 30,               // monthly ("last" allowed)
        "weekendShift": "before"        // none | before | after (payday lands on Sat/Sun)
      },
      "deductions": {
        "timing": "grouped",            // every | grouped
        "group": {
          "by": "pair",                 // pair (2 consecutive) | month (calendar month)
          "applyOn": "second"           // first | second | last  — which check deductions hit
        },
        "combineGroup": true,           // base uses the group's combined earnings
        "exemptAmountCents": 1100000,   // subtract before deducting ($11,000)
        "cap": { "type": "none", "valueCents": 0, "valuePct": 0 }, // none|amount|percent (garnishment cap)
        "minNetCents": 0,               // never reduce net below this
        "scope": "all",                 // all | selected (which configured deductions apply)
        "selectedDeductionIds": []
      },
      "notes": ""
    }
  ]
}
```

### Field semantics
- **schedule.frequency** picks which of the other schedule fields matter (the builder
  shows/hides like `syncAreaMode`/the hours builder).
  - `weekly`   → `payWeekday`.
  - `biweekly` → `payWeekday` + `anchorDate` (every other one from the anchor).
  - `semimonthly` → `daysOfMonth` (2 values; "30" clamps to the last day of short months).
  - `monthly`  → `dayOfMonth` ("last" = end of month).
- **weekendShift** — pay the business day before/after when the computed payday is Sat/Sun.
- **deductions.timing**
  - `every`   → deductions apply on every paycheck (group/combine ignored).
  - `grouped` → group paychecks by `group.by`, apply on `group.applyOn`.
- **combineGroup** — when grouped, the deduction base is the *sum* of the group's
  paychecks (example: check₁ + check₂). When false, base is just the applied check.
- **exemptAmountCents** — subtracted from the base first; `base = max(0, combined − exempt)`.
- **cap** — optional ceiling on total deductions (garnishment-style): `percent` of base,
  or a flat `amount`. `none` = uncapped.
- **minNetCents** — floor: deductions never push net below this.
- **scope / selectedDeductionIds** — which of the company's configured deductions this
  ruleset governs (`all`, or a chosen subset). Ties into the existing deductions system.

### Order of operations (documented for the later pay-engine phase)
`base = max(0, combinedEarnings − exemptAmountCents)` → apply selected deductions to
`base` → apply `cap` → enforce `minNetCents` → round. Recorded here so the eventual
engine matches the builder's stated intent.

## Constants + validation
`server/constants/paycheckRuleEnums.js` (new): frozen allowed values +
`docs/db-enums.md` rows for every fixed-value field —
`PAYCHECK_FREQUENCIES` (weekly/biweekly/semimonthly/monthly),
`DEDUCTION_TIMINGS` (every/grouped), `GROUP_BY` (pair/month),
`GROUP_APPLY_ON` (first/second/last), `WEEKEND_SHIFTS` (none/before/after),
`DEDUCTION_CAP_TYPES` (none/amount/percent), `DEDUCTION_SCOPES` (all/selected).
A `normalizePaycheckRules(raw)` helper parses/validates the JSON defensively (bad
input → empty rulesets), mirroring `hoursRules.parsePolicy`.

## UI
`PaycheckRulesSettings.jsx` (section) + a per-ruleset editor. List of rulesets with
add / duplicate / delete, an expandable editor per ruleset (schedule block that
show/hides by frequency; deductions block), a plain-English summary line per ruleset
(`describeRuleset`, like `describeRule`), and a Save that PATCHes `paycheck_rules`.
**Presets** seed the two driving examples. Mount beside Hours & Rules in the same
settings page/tab, under the same admin permission. Bilingual EN+ES keys.

## Packaging — the Advanced Payroll add-on (SHIPPED 2026-07-27)
Paycheck Rules + WH-347/certified payroll + the Payroll tab gate on a paid add-on,
**Advanced Payroll** (`companies.addon_advanced_payroll`, migration 0155). Certified
payroll was folded in (its old `addon_certified_payroll` is OR-gated + backfilled;
`requireCertifiedPayrollAddon` now checks the new flag, keeping its name to avoid
churn). Free in Reports (base plan): the hours register (regular/OT/prevailing) +
timesheet export. `usePlan().hasAdvancedPayroll` gates the client; superadmin-
toggleable today (like certified payroll was) — **Stripe self-serve is a follow-up**
(model on the takeoff add-on: `ADDON_PRICES`, webhook entitlement, BillingPanel,
`STRIPE_PRICE_ADVANCED_PAYROLL[_ANNUAL]`). Also fixed a latent bug: the WH-347 panel
used to gate on `hasQbo` — now `hasAdvancedPayroll`.

## Assignment + run (SHIPPED 2026-07-27)
Assignment is **by role**: a ruleset lists the `roles` it covers; each deduction
carries `roleIds` (empty = all). The run — `server/utils/paycheckRun.js` +
`GET /admin/payroll-run` + `PayrollRun.jsx` in the Payroll tab — resolves each
worker's ruleset from their role and computes gross → deductions → net for a period:
- **Tie-breaker (David):** a role matching **0 or >1** rulesets (or a worker with no
  role) is a **flagged setup error** in the run, never a silent guess.
- Deductions = company-wide + the worker's role-scoped + their personal rows, run
  through the ruleset's **exempt → deduct → cap → min-net** math (`computeRuleNet`).

## Pay periods + multi-check combining (SHIPPED 2026-07-27)
`server/utils/payPeriods.js` (pure, UTC, 10 tests) generates the paychecks a
ruleset's schedule issues in a window — weekly / biweekly-from-anchor / semimonthly
(with day clamping) / monthly, weekend-shift — then groups them (pair / calendar
month) and flags which check the deductions land on. The run now generates each
worker's periods, fetches gross per period (one `companyStatements` per distinct
range), and `applyGroupDeductions` combines the group's gross, subtracts the exempt
**once**, and deducts on the flagged check — David's "every other Thursday, deduct on
the 2nd, combined − $11k" and "15th & 30th, deduct on the 30th" now compute exactly.
The register is one row per (worker, check), sorted by pay date.

## Later (out of scope now)
- **Stripe self-serve purchase** of Advanced Payroll.
- Server-side gate on the `paycheck_rules` SAVE (currently client-gated; inert
  without the engine).
- Pay stubs + payroll-processor export off the run; prod smoke test.
