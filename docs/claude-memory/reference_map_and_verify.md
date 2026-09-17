---
name: reference_map_and_verify
description: "docs/MAP.md is the codebase jump-table; `npm run verify` runs the local checks — use both before grepping/committing"
metadata:
  type: reference
---

Two workflow aids added 2026-07-25 to speed navigation + verification:

- **`docs/MAP.md`** — the codebase map (stack, hash-tab navigation, the one pay
  engine `buildPayStatement` + its four renderer surfaces, settings, tool-apps,
  test commands, conventions). Check it before hunting for where a subsystem
  lives. Keep it current when something moves.
- **`npm run verify`** (repo root) — server `jest`, then client `eslint` +
  `vitest` (incl. i18n EN/ES parity) + `vite build`. Runs anywhere (jest mocks
  the DB). Also `verify:server` / `verify:client`. **Not** in it (CI-only,
  need services): `npm run lint:migrations` (scratch Postgres) and
  `npm audit --omit=dev --audit-level=high`.

The pay math for all four surfaces (invoice, overtime report, payroll CSV, pay
stubs) now lives in ONE place: `server/utils/payStatement.js` (`buildPayStatement`
pure + `workerStatement`/`companyStatements`/`workerPeriodStatements` loaders).
Change pay logic there, not in the routes. See [[project_feature_completion]].
