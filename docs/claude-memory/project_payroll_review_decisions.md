---
name: project_payroll_review_decisions
description: "Open decisions + deploy action item from the deep Advanced-Payroll / certified-payroll review (batches 3–8, dev)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-08-13T18:32:27.809Z
---

A long multi-pass review hardened the whole pay engine: grouped paycheck-deductions,
the payroll run→finalize→paid/void lifecycle, both stub renderers, the deductions
editors, and the certified-payroll (WH-347) surface. Many money + compliance bugs
found and fixed across commits "review batch 3…8" on `dev` (through `e3f3d7f`,
2026-07-28/29). **Exhaustive detail is in `docs/WORKLOG.md` (per-pass reports) and
`docs/BACKLOG.md` (what's parked)** — don't re-derive it; read those.

**Why:** David asked to record everything, *especially the decisions he needs to make*.
These are product/judgment calls I deliberately did NOT decide for him.

**How to apply — decisions waiting on David (raise these when payroll/WH-347 comes up):**
1. **WH-347 fringe election (4a/4b/4c: cash vs approved-plan)** — BLOCKED ON HIM. Can't
   build without knowing how his fringes are actually paid and *where the election lives*
   (per company? per project? per fringe benefit?). Ask, then wire it.
2. **WH-347 gross folds in night/OT premium** (no itemized line) — left as-is because
   that's how the standard S/O form works. Confirm he's OK, or itemize if a reviewer wants it.
3. **Company-deduction saves are last-write-wins** — two admins editing the deductions
   list clobber each other (dead `version:1`, generic `/settings` PATCH). Worth optimistic
   concurrency? It's a shared-endpoint change, not payroll-only.
4. **Server error strings are English-only (systemic, whole app)** — Spanish users see
   English on any 4xx. Worth an app-wide `code`→`t.*` mapping? See [[feedback_traceability]]-
   adjacent bilingual rule.
5. **Grouped payroll edge cases** — multi-schedule run windows can overlap, and the finalize
   key blocks supplemental/partial-worker runs. Only matter if he runs 2+ *different* pay
   cadences or wants off-cycle/subset runs. Decide if those are real needs.
6. **Per-deduction timing behavior change (2026-08-13, UNDECIDED)** — reworked so paychecks
   issue on the pay schedule THROUGHOUT the month (not held until a monthly group closes),
   and so some deductions come out every paycheck (Seguro Social) while others group monthly
   (RAP). Implemented `timing:'grouped' + scope:'selected'` = selected deductions are grouped,
   the REST of the role's company deductions now apply PER PAYCHECK — they used to be dropped.
   David unsure if that silent change is a problem (a ruleset that used "selected" to *exclude*
   a deduction now applies it per check). Full write-up + the decision (keep implicit rule vs.
   add an explicit per-deduction toggle) is parked in `docs/BACKLOG.md` → "Open questions /
   decisions". Code: `applyDeductions` in `server/utils/paycheckRun.js`, split in
   `computePayrollRun` (`server/routes/admin.js`), individual-check dropdown in `/admin/payroll-periods`.

Related: [[project_backlog_doc]] · [[reference_map_and_verify]] (pay math lives in
`server/utils/payStatement.js`) · [[feedback_traceability]] (the crusade that kicked this off) ·
[[feedback_no_deploy_mentions]] (don't raise Render deploys).
