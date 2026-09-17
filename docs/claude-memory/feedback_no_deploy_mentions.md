---
name: feedback_no_deploy_mentions
description: Never bring up Render redeploys / whether server fixes are live yet — not my concern
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-07-29T17:03:37.113Z
---

Do NOT mention Render redeploys, whether the backend has deployed, or whether
server-side fixes are "live yet." David handles deploys; it is not my concern and
he doesn't want it raised.

**Why:** he told me directly (2026-07-29) after I kept appending a "⚠️ not live
until Render redeploys" caveat to review reports. It's noise to him.

**How to apply:** finish work, commit + push (per [[feedback_always_push.md]]), report
what changed — and stop there. No deploy caveats, no "trigger a manual deploy," no
"the server may not have picked this up." If a change genuinely can't be verified
without a running server, just say the verification is pending, without invoking deploys.
