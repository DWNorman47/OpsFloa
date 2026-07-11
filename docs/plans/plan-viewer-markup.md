# OpsFloa — Plan Room: viewer + markup + measure (paid add-on, local-first + live sessions)

Status: **scoped, not started** (2026-07-11; architecture revised same day —
replaced the original cloud-first design after weighing its downsides). Depends
on the **M0 shared-engine extraction** in `docs/plans/roofing-takeoff.md` —
whichever plan builds first does M0. File references name mechanisms, not line
numbers.

## Context
The strongest horizontal "expensive-incumbent replacement" on the roadmap:
Bluebeam Revu (~$260–440/user/yr, per-seat) / PlanGrid / Fieldwire. A daily-use
tool for anyone who works plan sets — GCs, PMs, estimators, supers. ~60% of the
viewer core exists: the shared engine (canvas/pan/zoom, pdf.js, measure math,
storage/undo, UI) plus pdf-lib already vendored in the PDF Toolkit app.

## Decisions (locked with user, 2026-07-11)
1. **Own add-on SKU** — `addon_planviewer`, `STRIPE_PRICE_PLANVIEWER(_ANNUAL)`,
   mirroring the takeoff/roofing pattern end to end.
2. **Local-first + ephemeral live sessions** (revised from cloud-first).
   Projects live in the browser exactly like the takeoff tool — IndexedDB,
   save/load file, company-cloud library with "Copy to my projects". Realtime
   arrives as **live sessions**: the host "goes live" on their local project,
   teammates join and co-mark-up in real time; when the session ends the host
   owns the result and can optionally publish it to the company cloud, where
   others can copy it and host their own sessions (the existing fork
   philosophy, extended).
3. **Sessions survive host disconnect.** Server holds session state; everyone
   keeps working, the host rejoins and catches up. Auto-end on idle (no
   participants ~30 min, tunable), final state preserved for the host.
4. **The session layer is generic** — it syncs opaque JSON objects per tool
   (plan markups today; sitework/roofing takeoff shapes later get a "go live"
   button on the same rails). Gating is per-tool add-on flag.

### Why local-first won (recorded so it isn't relitigated)
Cloud-first's costs for this user base: no offline on jobsites (solo work must
work in dead zones), the server becomes load-bearing for daily work, holding
every customer's confidential plan sets (liability + unbounded storage), data
behind a lapsed subscription, and no private drafts. Local-first keeps all of
that, and buys realtime only for the moments people actually want it — a
session is inherently an online activity. The one capability given up: a
persistent "living master set" (Bluebeam Studio's long-running project).
Sessions + published snapshots require re-publish discipline instead. Accepted.

## Data model (migration — take the next free number at build time)
Markups live **inside the local project JSON** (like takeoff geometry) — no
permanent markup table, no per-markup DB enum. Only sessions touch the DB:
- **`live_sessions`**: id, `company_id UUID` (no FK, staging convention),
  **`tool`** (`planroom|sitework|roofing` — CHECK + shared constant +
  `docs/db-enums.md` row), host_user_id, name, `pdf_url` (R2 — see PDF note),
  `state JSONB` (server-side snapshot of the object set), **`status`**
  (`active|ended` — CHECK + constant + db-enums row), created_at,
  last_activity_at, ended_at. Index on company_id + status.
- Company library: **reuse `takeoff_projects`** + `server/routes/takeoffs.js`
  with a `data.app` marker (`'plan-room'`), lists filtered per tool — same
  approach as the roofing plan. Generalize the mount gate to "has any of the
  tool add-ons".

## Live-session layer (generic; the net-new server work)
- **REST** `server/routes/liveSessions.js`: start (create row; PDF ref or
  upload), list active for company (per tool), join (returns snapshot +
  pdf ref), end (host or admin), heartbeat.
- **WS** `server/ws.js`: `ws` on the same HTTP server (`upgrade` handler,
  `tc_token` auth, path `/ws/session/:id`), rooms per session, presence
  roster, op broadcast (create/update/delete of opaque objects, LWW per
  object id). Server applies ops to an in-memory doc and **snapshots to
  `state` every few seconds/ops** — a server restart loses at most the last
  few seconds and the room rebuilds from the snapshot. Late joiners and the
  rejoining host load snapshot + live tail.
- **Idle sweeper**: interval job auto-ends sessions with no participants past
  the timeout; final snapshot stays on the row for the host to reclaim.
- **Session PDF:** if the project is already company-shared, its PDF is
  already in R2 — "go live" references it and starts instantly. Otherwise the
  host uploads at go-live. **Full-size plan sets (50–200 MB) exceed the JSON
  body path (~48 MB PDF max), so the presigned three-step upload (pattern in
  `server/routes/recordings.js`, `getPresignedUploadUrl` in `server/r2.js`)
  is needed for the Plan Room's library share AND go-live** — scheduled M4,
  with its known caveats (R2 bucket CORS = infra action; orphan sweep).
- **End-of-session UX:** host ends → participants get "Save a copy to my
  projects?"; host gets "Share to company cloud?". Attribution (author +
  timestamp) rides on every object created in a session.

## Client — `client/public/tool-apps/planroom/` (on the shared engine + pdf-lib)
- **Viewer:** open local PDF; fast page navigation — lazy cached thumbnail
  strip, page jump, rotate, fit/zoom. Projects in IndexedDB like sitework.
- **Markups:** cloud, rect/ellipse, arrow/line, freehand, highlighter, text,
  callout; select/move/resize/delete; color + line-weight; per-page. Text
  entry via DOM overlay input. Filterable **markup list panel** (page/author/
  kind, click to jump).
- **Measure:** per-sheet scale calibration + length/area/count markups with
  values (engine-measure).
- **Company library:** ☁ panel with the takeoff pattern — share, "Copy to my
  projects" (new-vs-overwrite prompt), delete; **LIVE badge** on sets with an
  active session + Join button.
- **Live session UX:** "Go Live" button → session banner (name, roster,
  End/Leave), teammate markups appear live with author colors; reconnect
  banner on socket drop (REST + snapshot keep it recoverable).
- **Export:** pdf-lib flatten for download/print; markup summary CSV.

## Platform wiring (mirror the takeoff add-on)
Migration adds `companies.addon_planviewer`; stripe.js plans/status/checkout/
webhook + `ADDON_PRICES` + one-click add/remove; session + AuthContext flag;
superadmin toggle; BillingPanel card ("+ Plan Room add-on"); ToolsPage tab
hidden without add-on/trial/exempt.
**User actions:** Stripe product/prices (`STRIPE_PRICE_PLANVIEWER`, `_ANNUAL`)
in Render env; **R2 bucket CORS** when M4's presigned upload lands.

## Milestones (committable slices, all to `dev`, push after each)
- **M0** — shared-engine extraction (if roofing hasn't done it; see that plan).
- **M1 — viewer core (local-first):** open PDF, thumbnails/nav, projects,
  save/load file. Fully offline-capable from day one.
- **M2 — markups:** full toolset + markup list panel + undo, in project data.
- **M3 — measure:** calibration + measure markups.
- **M4 — company library:** takeoffs-route reuse w/ marker + the presigned
  upload upgrade (+ CORS, orphan sweep) so full-size sets share.
- **M5 — live sessions:** `live_sessions` + REST + ws + sweeper + Go
  Live/join/end UX. Generic layer, wired for `tool='planroom'` only.
- **M6 — export:** pdf-lib flatten + markup CSV; print.
- **M7 — platform:** add-on wiring end to end; tool goes live gated.
- **M-later:** "Go live" on sitework/roofing takeoffs (the generic layer's
  payoff), revision compare/overlay (port sitework ghost+align), text search,
  live cursors, external guest sessions (big auth surface, own decision).

## Verification
- **Offline:** full solo workflow (open/markup/measure/save) with the network
  cut; only ☁ and Go Live require connectivity.
- **Markups:** create/edit/delete each kind; reload → identical render.
- **Library:** 150 MB set shares via presigned PUT; copy-down prompt works;
  libraries stay separated per tool marker.
- **Sessions:** two browsers see each other's ops <1s; **kill the host** →
  others keep working, host rejoins and converges; server restart → room
  rebuilds from snapshot (bounded loss); idle sweep ends abandoned sessions;
  end-of-session prompts fire; no add-on → REST 403 + WS upgrade rejected.
- **Export:** flattened PDF renders markups correctly in an external viewer.
- **Perf:** 200-page set — lazy thumbnails, warm page switch under ~1s.

## Risks
- **Scope = Revu.** Non-goals at MVP: no OCR, no forms, no document
  folders/DMS, no 3D, no external guests, no persistent living master set.
- **Websocket-on-Render behavior** (idle timeouts, restarts): the
  snapshot-in-DB design bounds the damage to seconds; reconnect must be solid.
- **Snapshot-loss window:** a crash between snapshots drops the last few
  seconds of a session — document it, keep the interval small.
- **Two sharing modes confusing users** (cloud copy vs live session): the ☁
  panel presents both in one place (LIVE badge on the same rows) to keep one
  mental model.
- **Big-PDF performance:** render caching + lazy thumbnails from M1; test with
  a real 200-page set before M2, not after.
