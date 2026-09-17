---
name: Auto-approve tool calls
description: User wants tool calls auto-approved without manual confirmation prompts; do not open files in the IDE on the user's behalf
type: feedback
---

Do not prompt the user to approve tool calls — proceed directly.

**Why:** User explicitly said "auto approve things."

**How to apply:** Never pause for confirmation on standard tool use (reads, edits, bash commands). Only pause for genuinely destructive or irreversible actions (force push to main, dropping tables, etc.) as required by safety policy.

Also: never open files in the IDE on the user's behalf under any circumstances. The user has said this multiple times — it is a firm rule.