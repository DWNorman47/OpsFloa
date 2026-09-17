---
name: project_feature_completion
description: "OpsFloa is large and nearly everything is already built — how to check what exists before building it, and the load-bearing facts that are easy to get wrong"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
---

**The app is big and mature. Assume a thing exists until you've checked.** Verified 2026-07-16 at migration **0141** (141 migrations), 39 pages, ~39 API mounts.

⚠️ **This file used to be a 130-line hand-copied inventory of every route, page and component. It rotted in 99 days into something actively wrong** — it claimed Inventory wasn't built (it is), listed migrations "0001–0034" (now 0141), named `module_projects`/`module_field` (both gone), and said email was SendGrid (it's Resend — [[project_email_resend]]). It contradicted itself in two places. **So it is now pointers, not a copy.** Do not turn it back into an inventory; check the source instead. Same lesson as [[project_tool_roadmap]], which cost real time when a GC plan turned up three of its own six "standouts" already built.

## Where the truth actually lives — read these, don't trust memory
- **Modules / feature flags** → `server/settingsDefaults.js` (`FEATURE_KEYS`, `SETTINGS_DEFAULTS`) and `client/src/components/AppSwitcher.jsx` for gating.
- **API surface** → the `app.use('/api/…')` mounts in `server/index.js`. ⚠️ **Order matters** — literal routes must precede `:param` routes or they get shadowed (this has caused a real 500; `GET /subcontractors/compliance` carries a NOTE comment about it).
- **Pages** → `client/src/pages/` (39 files). **Tabs** → the `TABS` const near the top of each page.
- **Fixed-value columns** → `docs/db-enums.md`, the single source of truth. Read *and* update it in the same change — see [[reference_db_enums]].
- **What's parked / what's owed** → `docs/BACKLOG.md` ([[project_backlog_doc]]). **What was done and why** → `docs/WORKLOG.md` ([[feedback_worklog]]). **Plans** → `docs/plans/`.

## Load-bearing facts that are easy to get wrong
- **The module flag names do not match the UI names.** This is the single easiest thing to get wrong:

  | Flag | Default | UI name | Note |
  |---|---|---|---|
  | `module_timeclock` | true | Time Clock | gates *tabs*, not the app — the switcher uses `canSeeTimeclockApp()` |
  | `module_team` | true | **Directory** | |
  | `module_work` | true | **Work** | ⚠️ its AppSwitcher **app id is `projects`** and path is `/work` |
  | `module_field` | false | Field | label overridable via `label_field` |
  | `module_inventory` | false | Inventory | |
  | `module_tools` | false | Tools | |
  | `module_financial_reports` | false | **Reports** | hidden only if `module_analytics` is *also* false |
  | `module_analytics` | false | — | no app of its own; it's the Performance tab of Reports |

  **There is no `module_projects`.** Verify against `server/settingsDefaults.js` before relying on any of this.
- **`module_sales` and `module_subs` exist in the DB but are wired to nothing** — backfilled by `0118`, never added to `FEATURE_KEYS`, recorded in `db-enums.md` as orphaned. Both features became **tabs of existing modules**. **The codebase has already run the "should this be a module?" experiment and the answer was no.** Relevant every time a new surface is proposed.
- **Add-ons are separate from modules** — boolean columns on `companies`, flipped by the Stripe webhook. **That's the pattern for anything sold separately**, not a new module flag. `addon_planroom`, `addon_takeoff`, `addon_storm` (**not sellable** — `STORM_SELLABLE=false`, [[project_storm_utility_module]]), `addon_qbo`, `addon_certified_payroll` (**no Stripe path at all** — SuperAdmin-provisioned only).
- ⚠️ **Add-on prices are NOT in the code** — they're fetched live from Stripe at request time. Only QBO is hardcoded ($25/mo, $250/yr, `stripe.js`). So "Takeoff is $60/mo" is a *pricing decision*, not something you can confirm by reading the repo — **check Stripe before repeating a price.** (A `ToolsPage.jsx` comment says "$40 base tier" for Plan Room; comments are not prices.) Plans themselves: starter $20/mo, business $35 base + $2/worker.
- **Email is Resend**, not SendGrid ([[project_email_resend]]). The live bounce feed is `/api/resend-events`; `/api/sendgrid-events` survives, deprecated. ⚠️ Needs `RESEND_WEBHOOK_SECRET` on Render or it records nothing.
- **`project_invoices` is a QuickBooks *mirror*, not a native invoice.** Only `routes/qbo.js` writes it, so a company without QBO has **zero rows**. This is not a detail — it blocks pay-apps and already breaks closeout. Open decision in `BACKLOG.md`.
- **Storage** is Cloudflare R2; **payments** Stripe; **DB** Neon Postgres ([[project_infrastructure]]).
- **Static tool-apps** live in `client/public/tool-apps/`: `sitework` (⚠️ never touch — [[feedback_never_break_sitework]]), `planroom` (11 trade packs), `pdftools`, `shared`. These are plain JS served statically, **not** part of the Vite build, and need a `?v=N` cache-bust bumped on **both** the `styles.css` link and the `app.js` script.

## What is genuinely NOT built
Very little. The honest list is in [[project_tool_roadmap]] (kept current) and `docs/BACKLOG.md`. The biggest un-built things as of 2026-07-16: a **native invoice/AR concept** (see above), a **branded proposal generator**, **bid leveling**, and a **selection/allowance tracker**.

## Testing
GitHub Actions runs server Jest (`server/tests/`) + client Vitest on push/PR. `client/src/i18n.test.js` **fails the build on EN/ES key mismatch** — add every new key to both blocks. `client/src/pages/Tests.jsx` is an in-browser suite against the live API.
