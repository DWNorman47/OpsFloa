---
name: feedback_never_break_sitework
description: "Never break the standalone sitework takeoff tool while building Plan Room; verify it's untouched at every commit"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-07-25T21:56:45.940Z
---

**STATUS (2026-07-25): sitework is fully GONE — retired by David.** The tool +
its dependent `siteworkToPlanRoom.test.js` and ALL live references (ToolsPage
wiring, the CLAUDE.md "Frozen sitework" rule, MAP entry, stale route comments)
were removed from the repo. It was briefly boxed into `sitework-archived/`, then
that box was deleted too — so nothing sitework remains in the tree. **Recoverable
from git history: commit `e859f05` ("Box sitework…") holds the complete tool +
test + README**; restore with `git checkout e859f05 -- sitework-archived/`. The
frozen/never-edit rule below is fully retired (only relevant if it's restored).
Plan Room + `tool-apps/shared/` are independent copies, never affected.
Intentionally kept (NOT the tool): the Calculators "Sitework" category, the
vestigial `live_sessions.tool='sitework'` enum value, and historical/roadmap
mentions in `docs/plans/*` + `tool-apps/shared` provenance + the WORKLOG.

The standalone **sitework takeoff tool** (was at `client/public/tool-apps/sitework/`)
must keep working untouched while Plan Room is built up by copying/porting its
logic. Plan Room reuses a shared engine copied out of the sitework monolith
(`client/public/tool-apps/shared/`) — the sitework app itself stays frozen.

**Why:** it's a live, in-use tool and the interim sitework "pack" until Plan
Room's sitework port is confirmed and earns the cutover (see the S4 parity gate
in `docs/plans/planroom-sitework-pack.md`). A regression there breaks real work.

**How to apply:**
- At **every Plan Room commit**, run `git status --porcelain client/public/tool-apps/sitework/`
  and confirm it's empty (report "sitework untouched"). Make it part of the
  verify step alongside parse/eslint/i18n-parity.
- Port by **copying** sitework logic into Plan Room (`planroom/app.js`, the
  shared engine) — never by editing sitework in place.
- Touch sitework only with **explicit per-case authorization** (like
  [[feedback_only_touch_dev]] for prod) — never on your own initiative. Say so
  explicitly in the commit. **Authorized exceptions so far:**
  - A user-reported data-loss bug fix in sitework's Load path (loading a file
    overwrote the open project).
  - **2026-07-17 — "Send to Plan Room" export button** (David authorized).
    Additive only: `convertToPlanRoom` + `sendToPlanRoom` + one modal button;
    no existing sitework path changed. So sitework now legitimately has an
    export feature — that diff is expected, not a regression. See
    `docs/plans/sitework-to-planroom-export.md` and `siteworkToPlanRoom.test.js`.
    (Converts a sitework takeoff into a new Plan Room project: image-px ÷
    renderScale → base px; drawings + scale carry, pricing/wall-volumes/
    production don't.)

Related: [[feedback_only_touch_dev]], [[project_tool_roadmap]],
[[project_storm_utility_module]].
