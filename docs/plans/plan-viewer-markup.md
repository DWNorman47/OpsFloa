# OpsFloa — Plan Room: viewer + markup + measure (paid add-on, real-time)

Status: **scoped, not started** (2026-07-11). Depends on the **M0 shared-engine
extraction** in `docs/plans/roofing-takeoff.md` — whichever plan builds first
does M0. File references name mechanisms, not line numbers.

## Context
The strongest horizontal "expensive-incumbent replacement" on the roadmap:
Bluebeam Revu (~$260–440/user/yr, per-seat) / PlanGrid / Fieldwire. Unlike the
takeoffs (one trade, one estimate), a plan viewer is a **daily-use tool for
anyone who works plan sets** — GCs, PMs, estimators, supers — which makes it the
stickiest surface OpsFloa can own. ~60% of the viewer core exists: the shared
engine (canvas/pan/zoom, pdf.js loading, measure math, storage/undo, UI) plus
pdf-lib already vendored in the PDF Toolkit app (global `PDFLib`) for
flatten/export.

## Decisions (locked with user, 2026-07-11)
1. **Own add-on SKU** — `addon_planviewer`, `STRIPE_PRICE_PLANVIEWER(_ANNUAL)`,
   mirroring the takeoff/roofing pattern end to end.
2. **Real-time multi-user markups** (chosen over the one-at-a-time library —
   this is the Bluebeam Studio play). Everyone in the company opens the *same*
   cloud-hosted set and sees each other's markups live, with presence.

## Architecture consequences (different from the takeoffs)
- **Cloud-first, not local-first.** A plan set lives on the server (PDF in R2,
  markups in Postgres); the tool opens it by id. No copy-down/version-conflict
  dance — the set IS the shared state. (Local-only "open a file without saving"
  stays possible as a scratch mode.)
- **Presigned R2 upload becomes REQUIRED.** Plan sets run 50–200 MB — far past
  any JSON body limit. Use the existing three-step presigned pattern
  (`server/routes/recordings.js` + `getPresignedUploadUrl` in `server/r2.js`).
  This pulls in the two caveats parked in memory (project_takeoff_pdf_storage):
  **R2 bucket CORS for browser PUT** (user/infra action) and **orphan cleanup**
  (R2 lifecycle rule or sweep job) — both land in this plan, M1.
- **Realtime is greenfield.** No websocket infra exists (chat polls). Add `ws`
  to the server on the same HTTP server (`upgrade` handler, path
  `/ws/planroom`, auth = `tc_token` on upgrade, rooms keyed by set id).
- **Sync model is simple on purpose:** markups are independent objects —
  create/update/delete ops, last-writer-wins per object, no CRDT/merge. REST is
  the source of truth; the socket is a live-notification layer. If the socket
  drops, the tool degrades to REST + refetch-on-reconnect, never data loss.

## Data model (migration — take the next free number at build time)
- **`plan_sets`**: id, `company_id UUID` (no FK, staging convention), name,
  `pdf_url` (R2), pdf_name, page_count, created_by, created_at, updated_at.
- **`plan_markups`**: `id UUID` (client-generated for offline-create), set_id FK
  ON DELETE CASCADE, page INTEGER, company_id, author user_id, **`kind`**
  (cloud|rect|ellipse|arrow|line|freehand|highlight|text|callout|
  measure_length|measure_area|count — CHECK + shared constant in
  `server/constants/` + **`docs/db-enums.md` row in the same change**, per
  CLAUDE.md), `data JSONB` (geometry, style, text, measured value), created_at,
  updated_at, deleted_at (soft delete → undo + attribution survive).
- Indexes: set_id+page, company_id.

## Server
- `server/routes/planroom.js` (mounted with requireAuth + the add-on gate —
  generalize the addon middleware to take a flag name): sets CRUD (create =
  presigned upload handshake, list, rename, delete → R2 cleanup), markup bulk
  fetch per set/page, markup create/update/delete (each writes then broadcasts).
- `server/ws.js`: `ws` server, room registry, presence (join/leave rosters),
  broadcast of markup ops; heartbeat/idle cleanup. Render supports websockets —
  verify idle-timeout behavior and add client auto-reconnect with full refetch.

## Client — `client/public/tool-apps/planroom/` (on the shared engine + pdf-lib)
- **Viewer:** open a company set (or local scratch file); fast page navigation —
  thumbnail strip (lazily rendered, cached), page jump, rotate, fit/zoom.
- **Markups:** cloud (the signature construction markup), rect/ellipse,
  arrow/line, freehand, highlighter, text, callout (leader + note). Select /
  move / resize / delete; color + line-weight; author + timestamp attribution.
  Text entry via DOM overlay input (not canvas-native editing).
- **Measure:** per-sheet scale calibration (engine-measure), then
  length/area/count as first-class markups that display their values.
- **Markup list panel:** filterable by page/author/kind — the "punch the clouds"
  workflow; click to jump.
- **Realtime UX:** live markup appearance, presence roster ("3 viewing"),
  subtle author colors. No live cursors at MVP (later polish).
- **Export:** flatten markups into the PDF via pdf-lib for download/print;
  markup summary CSV (page, author, kind, text) — Bluebeam's markup report.

## Platform wiring (mirror the takeoff add-on)
Migration adds `companies.addon_planviewer`; stripe.js plans/status/checkout/
webhook + `ADDON_PRICES` + one-click add/remove; session + AuthContext flag;
superadmin toggle; BillingPanel card ("+ Plan Room add-on"); ToolsPage tab
hidden without add-on/trial/exempt.
**User actions:** Stripe product/prices (`STRIPE_PRICE_PLANVIEWER`, `_ANNUAL`)
in Render env; **R2 bucket CORS** config for presigned browser PUTs.

## Milestones (committable slices, all to `dev`, push after each)
- **M0** — shared-engine extraction (if roofing hasn't done it yet; see that plan).
- **M1 — cloud sets:** migration, presigned upload flow (+ R2 CORS + orphan
  sweep), sets CRUD, viewer opens a set with thumbnail navigation.
- **M2 — markups (REST):** all markup tools, per-page persistence, markup list
  panel, soft delete/undo. Solo-usable tool at this point.
- **M3 — measure:** calibration + length/area/count markups.
- **M4 — realtime:** `ws` layer, live ops broadcast, presence, reconnect+refetch.
- **M5 — export:** pdf-lib flatten + markup summary CSV; print.
- **M6 — platform:** add-on wiring end to end; tool goes live gated.
- **M-later:** revision compare/overlay (port sitework ghost+align), text
  search, live cursors, external guest sessions (share a set outside the
  company — Bluebeam Studio's killer feature, big auth surface, own decision).

## Verification
- **Upload:** 150 MB set uploads via presigned PUT; abandoned upload gets swept
  (orphan rule); delete removes the R2 object.
- **Markups:** create/edit/delete each kind; reload → identical render;
  attribution correct; soft-deleted excluded but recoverable.
- **Realtime:** two browsers — markup appears in <1s on the other; kill the
  socket → tool keeps working via REST; reconnect → full state converges;
  presence roster accurate through joins/leaves/timeouts.
- **Export:** flattened PDF renders markups correctly in an external viewer.
- **Gating:** no add-on → tab hidden, REST 403, WS upgrade rejected.
- **Perf:** 200-page set — thumbnails lazy, page switch under ~1s warm.

## Risks
- **Scope = Revu.** The non-goals list is the plan's most important section: no
  OCR, no forms, no document folders/DMS, no 3D, no external guests at MVP.
- **Websockets on Render:** idle timeouts / instance restarts drop sockets —
  the REST-source-of-truth design makes this survivable; reconnect must be solid.
- **Big-PDF performance:** render caching + lazy thumbnails from day one; test
  with a real 200-page set early (M1), not after markups land.
- **Presigned/CORS dependency:** an infra step outside code; if misconfigured,
  M1 blocks — do it first, verify with a curl PUT before building UI on it.
- **Realtime write conflicts:** LWW per object is acceptable (two people rarely
  edit the *same* cloud); document it and move on — no merge engine.
