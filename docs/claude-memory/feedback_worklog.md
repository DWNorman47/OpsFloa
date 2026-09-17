---
name: feedback_worklog
description: "Capture end-of-task reports to David in docs/WORKLOG.md — the findings and judgment calls, not a second git log"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
---

David asked (2026-07-16) that the reports given to him at the end of each task be
written to **`docs/WORKLOG.md`** instead of only living in the chat: *"once you
finish a task, you have all this stuff you give me to look at. Could you document
it for me?"*

**Why:** those end-of-task summaries carry things that exist nowhere else — the
root cause behind a bug, the judgment calls made on his behalf, the near-misses.
Commit messages hold code rationale, [[project_backlog_doc]] holds parked items,
`docs/plans/*.md` hold per-feature design, `docs/db-enums.md` holds fixed-value
rules. The reports are the only record of the *reasoning* and the *decisions* —
and they scroll away.

**How to apply:** after finishing a task and reporting back, append an entry at
the top (newest first) of `docs/WORKLOG.md`. Keep to its four beats:
- **Shipped** — one-liner + commit refs.
- **Found** — the non-obvious thing; this is the point of the file.
- **Calls made** — decisions he might want to overrule, stated so he can.
- ⚠️ **Needs David** — anything awaiting him; also mirrored in the standing
  section at the bottom.

Cross-reference the other docs rather than restating them — the file is worthless
if it becomes a second copy of the git log. Fold several commits into one logical
task entry; don't write one entry per commit.

Related: [[project_backlog_doc]], [[feedback_never_break_sitework]].
