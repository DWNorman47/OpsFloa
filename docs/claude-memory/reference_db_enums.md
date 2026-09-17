---
name: DB enum registry — fixed-value columns
description: docs/db-enums.md is the single source of truth for every DB column that holds a fixed set of values; read and update it whenever working with fixed-value fields
type: reference
originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
---
`docs/db-enums.md` in the OpsFloa repo is the canonical registry of every
column that holds a fixed set of values — statuses, types, roles, kinds,
priorities, plans, etc.

**Always read it before** writing or reviewing code that validates a
fixed-value field, decides what literal value to write into one, or adds
a new such column.

**Always update it in the same change** when adding a new fixed-value
column, changing the allowed values, or changing the DB enforcement
state. CLAUDE.md restates this rule.

The doc records, per column: allowed values, current DB enforcement
state (`enforced` via CHECK/ENUM vs `app-only`), where validation
lives in code, and a note on stakes. It also lists open follow-ups
(columns that need CHECK constraints added, Stripe webhook
sanitization, etc).

Background: the registry was created on 2026-04-30 after the
service-request → project conversion bug (`status='active'` written
where the edit form expected `planning|in_progress|on_hold|completed`)
showed how easily app-only validation drifts between write paths.
Commit: `0249ac4`. The doc is the durable countermeasure.
