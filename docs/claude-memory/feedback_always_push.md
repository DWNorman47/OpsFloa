---
name: Always push after committing
description: User expects git push to always follow git commit — never leave commits unpushed
type: feedback
---

Always run `git push` immediately after every `git commit`. Never finish a task with unpushed commits.

**Why:** User reminded me explicitly after I committed without pushing.

**How to apply:** Every time I create a commit, the very next command should be `git push`.
