# Memory Index

## Feedback
- [Always push after committing](feedback_always_push.md) — run `git push` immediately after every `git commit`
- [Schema migration approach](feedback_schema_migrations.md) — all SQL changes go in server/migrations/ numbered files, never ad-hoc
- [Auto-approve tool calls](feedback_auto_approve.md) — proceed without confirmation prompts; never open files in the IDE on user's behalf
- [Only touch dev](feedback_only_touch_dev.md) — only ever work on the dev branch; never push/merge/deploy stage or prod without explicit per-case permission
- [Never break sitework](feedback_never_break_sitework.md) — **RETIRED 2026-07-25: sitework fully removed** (tool + refs gone, box deleted). Recoverable from git history (commit `e859f05`). Frozen rule moot unless restored
- [Notes are dormant](feedback_notes_dormant.md) — items in the ## Notes section surface ONLY when David explicitly asks for notes; never raise them proactively
- [Don't assume he remembers](feedback_no_memory_assumption.md) — David knows his app but not last week's asks; define your own shorthand, never explain his app back to him, keep it short
- [Write task reports to the worklog](feedback_worklog.md) — after each task, append the report to `docs/WORKLOG.md`: findings + judgment calls, not a second git log
- [Everything traceable](feedback_traceability.md) — in Team Member Reports, every hour/dollar must trace to a row + the rule behind it; never fold derived amounts (guarantee, leave) into a summary total
- [Don't mention deploys](feedback_no_deploy_mentions.md) — never raise Render redeploys or whether server fixes are "live yet"; David handles deploys, it's noise to him

## Notes
- [Takeoff & Bidding marketing framing](note_takeoff_bidding_marketing.md) — dormant; do not surface unless David asks for notes

## Project
- [App name & domain](project_app_name.md) — the app is **OpsFloa** (opsfloa.com), renamed from Time Crunch; the `TimeCrunch_Claude` folder name is just the local path
- [Native invoices decision](project_native_invoices_decision.md) — SHIPPED (all 5 phases + email-on-send): OpsFloa's own invoices/AR, QBO unified onto it. **Online-pay (Stripe Connect) IN PROGRESS — Phase 1 done, 2–4 paused** (see [[project_native_invoices_decision]] + `docs/plans/invoice-online-pay.md`; blocked on David enabling Connect). Also open: prod smoke-test + drop dormant `project_invoices`
- [Backlog & leftovers doc](project_backlog_doc.md) — parked bugs/flaws/ideas/todos live in `docs/BACKLOG.md`; file items there by section (stale project-list bug is section 1, don't raise unless it recurs)
- [Payroll review — open decisions](project_payroll_review_decisions.md) — deep pay-engine/WH-347 review (batches 3–8, dev) done; **decisions David still owes** (fringe 4a/4b/4c election blocks build, deduction-save concurrency, bilingual errors, grouped-payroll edges)
- [Field Work audit — open decisions](project_field_audit_decisions.md) — 2 owed: clock-out reader cutover (money-critical; interim long-shift flag shipped) + whether `visible_to_user_ids` is an access boundary or just declutter
- [Product vision — operations base + tool add-ons](project_product_vision.md) — started as time clock+invoicing; it's an operations platform; service calls go in the base, specialized tools (takeoff) are extra-cost add-ons
- [Service-call gap analysis](project_service_call_gaps.md) — what's missing to serve HVAC/plumbing-style service businesses; base-app gaps, not add-ons (work-order completion flow is the keystone)
- [Infrastructure — database and build commands](project_infrastructure.md) — Neon for DB, npm for build commands
- [Email via Resend](project_email_resend.md) — email moved off SendGrid to Resend; needs RESEND_API_KEY + verified EMAIL_FROM domain + NODE_ENV=production to send
- [Feature completion map](project_feature_completion.md) — **the app is big; assume a thing exists until you've checked.** Where the truth lives + the facts that are easy to get wrong (module flag names ≠ UI names; add-on prices are in Stripe, not code)
- [Tool roadmap — full idea backlog](project_tool_roadmap.md) — every Tools-module tool suggested (built + roadmap); **move a tool to "Already built" the same day it ships — this list going stale has cost real time**
- [Storm/Utility takeoff module (built)](project_storm_utility_module.md) — invert-driven storm-drain takeoff, separate $20/mo upsell (addon_storm) on top of Takeoff, built in Plan Room; M1–M5 all shipped, purchase HIDDEN (STORM_SELLABLE=false) until math verified — flip to sell
- [Takeoff PDF storage — R2 + base64 bandaid](project_takeoff_pdf_storage.md) — shared takeoff PDFs go to R2; base64-through-API with a 64MB /api/takeoffs limit (deferred: presigned direct upload, with CORS + orphan-cleanup caveats)
- [Pay-rule windows principle](project_pay_rule_windows.md) — every pay rule evaluates against ITS OWN required window (week/month), independent of the from/to pulled; display + paid stay scoped to range. Guarantee week-gate + preview grouping still owe this
- [Neon compute bill — cause + fixes](project_neon_compute.md) — ~$80/mo was always-on `stage`+`main` branches never suspending (Render $7 always-on server → its 24/7 crons keep the DB awake); fixes shipped, **David still must set `DISABLE_BACKGROUND_JOBS=true` on the stage Render service** + verify on Neon Branches
- [Media/tool-app work Sep 2026](project_media_tools_2026-09.md) — Field Work photo/video downloads (proxy endpoint), on-device multithreaded video converter (isolated tool-app, 32MB wasm vendored), and **tool-apps now cached on-demand not precached** (don't re-precache them)

## Reference
- [DB enum registry — fixed-value columns](reference_db_enums.md) — `docs/db-enums.md` is the single source of truth; read + update whenever working with fixed-value fields
- [Codebase map & verify script](reference_map_and_verify.md) — check `docs/MAP.md` before grepping; run `npm run verify`; all pay math lives in `server/utils/payStatement.js`
