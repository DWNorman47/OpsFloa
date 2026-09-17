---
name: project_pay_rule_windows
description: "Pay-engine design principle — every rule evaluates against ITS OWN required window, independent of the from/to range pulled; display + what's paid stay scoped to the range"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-08-13T20:20:10.862Z
---

**David's pay-engine design principle (2026-08-13):** the from/to range a caller pulls
controls what is DISPLAYED and what is PAID — but every pay RULE must be evaluated
against the exact data window IT needs, reaching outside the pulled range for its own
context WITHOUT dragging those out-of-range rows into the display.

Concrete cases David gave:
- **min_daily "every weekday / every other day that week" guarantee** → evaluate the
  gate against the worker's REAL full-week attendance, even days outside the range
  (e.g. a Monday when the range starts Tuesday). If it qualifies, pay the guarantee on
  the in-range day (the Sunday). Do NOT show the out-of-range Monday as an entry.
- **Grouped monthly deductions (RAP)** → compute on the full month's combined
  pay-period gross (ALL the month's weeks — which can include the last days of the
  PREVIOUS calendar month via arrears), even when only one week is pulled. Pay on the
  check that carries it.
- Generally: weekly-OT thresholds, 7th-day, etc. measure over their natural window, not
  the clipped range.

**Why:** otherwise earned hours / deductions FLICKER based on where the pay-period or
report boundary falls relative to the week/month (David hit this: shifting the report
start from Mon→Tue made a Sunday's 8h guarantee vanish). Report and paycheck must be
boundary-independent and consistent.

**Status (verify against code before asserting):**
- DONE: `computePayrollRun` (`server/routes/admin.js`) widens ±45d and groups the full
  month so the RUN's grouped deductions are correct for any sub-range; outputs only
  checks whose pay date is in [from,to]. See [[project_payroll_review_decisions]] #6.
- STILL NEEDED: (1) the min_daily week-gate guarantee in `computeOT`
  (`server/utils/payCalculations.js`) evaluates against only the in-range entry buckets
  → flickers when the range clips the week; must load the full week for the gate.
  (2) the PREVIEW surfaces — WorkerMetrics "Pay Summary" bill (`workerStatement`) and
  the per-period pay stubs — still apply deductions RAW (no grouping/exempt), so RAP
  doesn't reflect the full month there.

**How to apply:** when touching any pay loader, `computeOT` gate, or a deduction path,
make the rule pull its own window (week/month) for evaluation while keeping the display
and the amounts paid scoped to [from,to]. Related: [[reference_map_and_verify]] (pay
math lives in `server/utils/payStatement.js`), [[feedback_traceability]].
