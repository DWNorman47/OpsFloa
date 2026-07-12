# OpsFloa — Plan Room platform: viewer base + takeoff layer

Status: **scoped, not started** (2026-07-11; revised twice same day — first from
cloud-first to local-first + live sessions, then restructured from sibling tools
into a **two-tier platform**: viewer base add-on + takeoff layer add-on). This is
now the **master plan** for the plan-tools product line; the roofing plan
(`docs/plans/roofing-takeoff.md`) is a trade pack under it. File references name
mechanisms, not line numbers.

## The product structure (locked with user, 2026-07-11)
- **Plan Room (base add-on, target $40/mo)** — `addon_planroom`,
  `STRIPE_PRICE_PLANROOM(_ANNUAL)`. Viewer + markup + **measure** (lengths/
  areas/counts with values — Bluebeam-Core-equivalent) + company library +
  live sessions + flatten/export.
- **Takeoff layer (add-on on the base, target $60/mo)** — reuses the existing
  **`addon_takeoff`** flag. Turns measurements into money: **all trade packs
  included** (sitework grading/cut-fill/trench, roofing pitch/squares, future
  drywall/paint…), price library, bid report, production log (sitework pack).
- **Stacked billing:** takeoff requires the base ($40 + $60 = $100 all-in).
  Checkout/one-click-add enforces it: adding takeoff without the base adds both
  items. Integrated takeoff features gate on BOTH flags.
- **Competitive frame:** Bluebeam Revu ~$22–37/mo (Studio collaboration costs
  more); PlanSwift ~$146/mo. "$100/mo for viewer + every-trade takeoff in one
  app" vs ~$170–180/mo for the incumbent pair.
- **Sitework fold-in with a user-confirmation gate:** the shipped standalone
  sitework tool keeps working unchanged (gated on `addon_takeoff` as today)
  until the user personally confirms the integrated sitework pack works; only
  then does the standalone tool redirect. Existing `addon_takeoff` holders are
  grandfathered — exact terms (gift the base? legacy price?) decided at
  cutover, not now.

## Architecture (carried from the local-first revision)
- **Local-first:** projects in IndexedDB, save/load file, offline solo work.
  Markups + takeoff objects live in the project JSON — no permanent per-object
  tables.
- **Company library:** the takeoff-sharing pattern (`takeoff_projects` route)
  with a `data.app` marker; "Copy to my projects" prompt (new-vs-overwrite).
- **Live sessions (generic layer):** host "goes live" on a local project;
  teammates join over ws (rooms, presence, LWW-per-object ops). Server keeps a
  rolling snapshot in **`live_sessions.state`** — sessions survive host drops
  and server restarts (bounded seconds of loss); idle sweep auto-ends; on end,
  participants get "Save a copy?", host gets "Share to cloud?". Generic =
  opaque JSON objects per tool, so takeoff objects ride the same rails
  ("go live on a bid" is an M-later flip, not a build).
- **Session PDF synergy:** already-shared projects reference their existing R2
  PDF — instant go-live; otherwise host uploads at start.
- **Why local-first won (recorded so it isn't relitigated):** cloud-first
  meant no offline on jobsites, a load-bearing server for daily work, holding
  every customer's confidential sets (liability + unbounded storage), data
  hostage to a lapsed subscription, and no private drafts. Live sessions are
  inherently online; solo work never is. Given up: a persistent "living master
  set" — sessions + published snapshots + re-publish discipline instead.

## Data model (migration — take the next free number at build time)
- `companies.addon_planroom BOOLEAN NOT NULL DEFAULT false` (addon_takeoff
  exists).
- **`live_sessions`**: id, `company_id UUID` (no FK, staging convention),
  **`tool`** (`planroom` now; `sitework|roofing` reserved — CHECK + shared
  constant + `docs/db-enums.md` row), host_user_id, name, `pdf_url`,
  `state JSONB`, **`status`** (`active|ended` — CHECK + constant + db-enums
  row), created_at, last_activity_at, ended_at. Index company_id+status.

## Server
- `server/routes/liveSessions.js`: start / list-active / join (snapshot +
  pdf ref) / end / heartbeat. Gate = the hosting tool's add-on flag(s).
- `server/ws.js`: `ws` on the same HTTP server (`upgrade`, `tc_token` auth),
  rooms per session, presence, op broadcast, periodic snapshot write; idle
  sweeper. (Greenfield — chat polls; no ws exists today.)
- Library route gate generalized: "has any plan-tools add-on", lists filtered
  by `data.app`.
- Stripe: `addon_planroom` product/prices; webhook mapping; `ADDON_PRICES`;
  one-click add/remove **with the takeoff-requires-base rule**; session +
  AuthContext + superadmin toggles + BillingPanel cards ("+ Plan Room",
  "+ Takeoff (requires Plan Room)").

## Client — `client/public/tool-apps/planroom/` (one integrated app)
Built on the **M0 shared engine** (see roofing plan — whichever builds first
does M0; the sitework monolith's leftovers become the sitework trade pack).
- **Base tier UI:** viewer (lazy thumbnail strip, page nav, rotate, fit/zoom),
  markup toolset (cloud, rect/ellipse, arrow/line, freehand, highlight, text,
  callout; select/move/resize; DOM-overlay text entry), filterable markup list
  panel, per-sheet scale + measure (length/area/count with values), ☁ library
  with LIVE badges + Join, Go Live UX (banner, roster, End/Leave, reconnect),
  pdf-lib flatten + markup CSV. PDF **and raster image** input (engine-doc).
- **Takeoff tier UI (gated on both flags):** trade-pack picker, priced
  quantities (the measure objects gain material/pricing configs), price
  library, bid report, production log. Packs:
  - **Sitework pack** = today's sitework domain (contours/grading/cut-fill,
    trench/line/count presets, walls) ported onto the integrated app
    (unscheduled — the standalone tool serves in the interim; see milestones).
  - **Roofing pack** = `docs/plans/roofing-takeoff.md` domain spec.
  - Future: drywall/paint, others from the roadmap.

## Milestones (committable slices, all to `dev`, push after each)
Sequenced **money-first** (revised 2026-07-11 with user): the base tier goes on
sale before the websocket build; the roofing pack (new revenue) ships before
the sitework port (consolidation, zero new revenue); live sessions land after
both.
- **M0 — shared engine extraction** (from the sitework monolith; sitework tool
  stays green throughout — see roofing plan for the module list and rules).
- **M1 — viewer core (local-first):** open PDF/image, thumbnails/nav,
  projects, save/load. Offline-capable from day one.
- **M2 — markups:** toolset + list panel + undo.
- **M3 — measure:** calibration + length/area/count with values (base tier).
- **M4 — company library:** route reuse w/ marker + **presigned upload**
  (+ R2 CORS, orphan sweep) for full-size sets (50–200 MB).
- **M5 — export:** pdf-lib flatten + markup CSV; print. (A viewer without
  print/flatten isn't a viewer — must precede going on sale.)
- **M6 — platform: base tier on sale.** `addon_planroom` wiring end to end +
  stacked-billing rule. **Visible-but-locked** in ToolsPage (locked card with
  preview + an "add it / ask your admin" path) — unlike the takeoff's
  hidden-entirely gating: a horizontal daily-use tool has to be discoverable
  by the whole company to sell seats.
- **M7 — takeoff layer, roofing first:** bid/price engine integration + the
  **roofing pack** (`docs/plans/roofing-takeoff.md` domain spec). New market
  on sale. The standalone sitework tool continues untouched as the interim
  sitework "pack" — a $100 customer gets roofing inside Plan Room + sitework
  standalone, linked from ToolsPage as today.
- **M8 — live sessions:** table + REST + ws + sweeper + Go Live/join/end UX.
  Generic layer, wired for `tool='planroom'` only. Deliberately off the
  revenue-critical path — a websocket rabbit hole can't delay a sale.
- **Sitework consolidation (unscheduled — when it earns it):** port the
  sitework domain (grading/cut-fill, trench, walls) into Plan Room only after
  roofing has proven the integrated takeoff UX and one-app consolidation is
  worth the cost. Parity checklist → **user personally confirms** →
  standalone tool redirects; grandfathering terms decided then. Nothing else
  waits on this.
- **M-later:** drywall/paint pack, "go live" enabled for takeoff objects,
  revision compare/overlay (port ghost+align), text search, live cursors,
  external guest sessions (big auth surface, own decision).

## User actions
- Stripe: create Plan Room product/prices (`STRIPE_PRICE_PLANROOM`,
  `_ANNUAL`, ~$40/mo) — and at M7, decide whether the existing takeoff Stripe
  product's price moves to $60 (new price IDs; existing subscribers stay on
  their legacy price automatically).
- R2 bucket CORS when M4's presigned upload lands.
- The sitework-consolidation cutover confirmation is explicitly yours
  (unscheduled — nothing waits on it).

## Verification
- **Offline:** full solo workflow with the network cut; only ☁/Go Live need it.
- **Tiering:** base-only company sees no takeoff UI and gets 403 on takeoff
  surfaces; adding takeoff without base adds both items; both-flags company
  sees packs. Superadmin overrides work per flag.
- **Sessions:** two browsers <1s op propagation; host kill → others continue,
  host rejoin converges; server restart → snapshot rebuild; idle sweep; end
  prompts; gating on ws upgrade.
- **Library:** 150 MB presigned share; copy-down; per-tool list separation.
- **Sitework parity (consolidation gate, unscheduled):** a real project
  produces identical quantities and bid totals in both tools before any
  redirect.
- **Perf:** 200-page set — lazy thumbnails, warm page switch under ~1s.

## Risks
- **Scope = Revu.** Non-goals at MVP: no OCR, forms, DMS folders, 3D, guests,
  persistent living master set.
- **The sitework port is the big lift** — grading/cut-fill is the hardest code
  in the product, which is exactly why it's unscheduled: it must not start
  until M0's boundaries have proven themselves AND roofing has shipped and
  validated the integrated takeoff UX.
- **Transition trust:** your own company uses the standalone tool — the
  consolidation's user-confirmation gate exists so the fold-in can never
  strand active work.
- **Websocket-on-Render** restarts/timeouts: snapshot design bounds loss;
  reconnect must be solid.
- **Two sharing modes** (cloud copy vs live session): one ☁ panel with LIVE
  badges keeps a single mental model.
- **Price anchoring:** $40 sits at Revu-Complete level — the collaboration
  (sessions, library) and platform integration are the justification; revisit
  after first sales.
