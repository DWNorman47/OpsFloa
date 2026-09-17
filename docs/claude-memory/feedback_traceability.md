---
name: feedback_traceability
description: Everything in Team Member Reports must be traceable — every hour/dollar → a row + the rule behind it
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-07-29T00:28:04.059Z
---

David's standing rule for pay/reports: **everything must be traceable.** Any question
of the form "why is this amount what it is?" must be answerable directly from the
Team Member Report — no number should appear without a line item you can click to see
the rule/setting that produced it.

**Why:** he's told me this more than once; it's a core product principle for him, and
pay math is money-critical, so opaque totals erode trust.

**The hard rule (David, 2026-07-28, emphatic):** *"Every time hours are added, they
need to be added to time entries first. Period."* No hour may be paid unless it exists
as a **time entry (row)** the pay then derives from — not synthesized in the engine and
folded into a summary. If a rule generates hours (min-daily floor, a no-clock-in
"guarantee N paid hours" day, leave, weekly guarantee), the engine must emit a
**synthetic entry row** for it (see `computeOT` `floorDetail` → `buildPayStatement`
`floorEntries`, 2026-07-28), so it shows in the Time Entries list everywhere. Summary
totals derive FROM the entries; they never introduce hours the entries don't show.

**How to apply:**
- Never fold a derived amount silently into a summary total like "Regular" — and don't
  even settle for a summary *line*; materialize it as an **entry**. Priced hours flow
  entry → pay, never the reverse.
- "Don't add more hours in summary" — the PAY SUMMARY shouldn't inflate a category with
  hours that have no matching traceable entry.
- The per-entry `?explain=1` trace (`server/utils/payStatement.js` builds `explain[]`;
  client renders via `utils/reportTrace.js`) is the mechanism — extend it, don't bypass it.
- Keep it consistent across surfaces (report UI, CSV, and ideally the bill PDF).
