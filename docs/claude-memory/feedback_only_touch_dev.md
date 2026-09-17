---
name: feedback_only_touch_dev
description: Only ever touch the dev branch; never stage or prod without explicit per-case permission
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-07-24T05:28:16.537Z
---

Only touch the `dev` branch. **Never touch `main` — full stop.** No commits, merges, PRs, deploys, reverts, or force-pushes to `main`/prod — and do **not even offer, propose, or prepare** one (no "want me to prep the dev→main PR?"). Same for `stage`. He reinforced this hard on 2026-07-23 ("No, never, don't touch main. Remember that.") after I offered to prep a dev→main PR — offering was already too far.

**Why:** The user owns the promotion pipeline end to end and tests each stage himself. The flow is entirely his: he tests in **dev**, then promotes to stage/prod on his own. My job stops at `dev`. Even preparing a PR toward `main` short-circuits his process and is unwelcome.

**How to apply:** Default every commit/push to `dev` (see [[feedback_always_push]] — push after committing, to dev). When work is ready, leave it on dev and just say it's there; **do not mention promoting, merging, or PRing to main** — he'll take it from there. Only operate on `stage`/`main`, or bring them up at all, if he explicitly says to for that specific task (rare). Supersedes the earlier prod-only note.
