---
name: project_field_audit_decisions
description: One open decision left from the 2026-08 Field Work audit — the clock-out reader cutover (visible_to_user_ids resolved: declutter only, no enforcement)
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-08-28T20:45:45.719Z
---

Open decisions from the Field Work deep audit (Aug 2026, dev). Both are flagged in
`docs/BACKLOG.md` → "Open questions / decisions for you". Neither was acted on
unilaterally.

1. **Clock-out reader cutover (MONEY-CRITICAL).** Pay reads wall-clock `start_time`/
   `end_time` (capped <24h), so a forgotten/multi-day clock-out reads as ~1h. The
   correct `start_ts`/`end_ts` instants ARE stored; the real fix is the Phase-3 reader
   cutover to `elapsedMinutes(start_ts,end_ts)`. Deferred because it shifts pay for any
   entry where reported wall-time ≠ server instant (DST, client drift, manual edits) —
   needs its own staged, tested change. **Interim SHIPPED 2026-08-20:**
   `time_entries.long_shift_flagged` (migration 0196) + red "⚠ Long shift" badge in the
   Approvals queue so an admin doesn't blind-approve a truncated entry. Cutover itself
   still owed.

2. **`visible_to_user_ids` enforcement — RESOLVED 2026-08-28: declutter only.** David
   decided per-project visibility is *mainly picker declutter*, NOT an access boundary. So
   the display-only behavior is intended: no server-side enforcement to add on clock-in /
   switch / field-report write paths. Do not "harden" it into an access control. (Sibling
   `field_show_overhead_projects` is likewise just declutter.)

Related: [[project_payroll_review_decisions]], [[project_pay_rule_windows]].
