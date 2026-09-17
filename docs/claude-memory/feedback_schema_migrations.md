---
name: Schema migration approach
description: All SQL schema changes must use numbered migration files in server/migrations/, never ad-hoc SQL
type: feedback
---

Always apply SQL schema changes via numbered migration files in `server/migrations/`, tracked by the `schema_migrations` table and run by `server/migrate.js`.

**Why:** User explicitly requested this pattern for safe promotion of schema changes across dev → staging → production in Neon. Running migrations as part of server startup ensures every environment stays in sync automatically on deploy.

**How to apply:**
- New columns, tables, indexes, or constraints → create a new `NNNN_description.sql` file in `server/migrations/`
- Always use `IF NOT EXISTS` / `IF EXISTS` guards so files are safe to re-run
- Never instruct the user to run raw SQL in the Neon console for schema changes
- The `start` script in `server/package.json` chains `node migrate.js && node index.js` so migrations run on every deploy automatically

**Bootstrapping a new environment (one-time only):**
- The user runs `node migrate.js` manually from `server/` once to initialize the `schema_migrations` table
- Their `server/.env` must have the correct non-pooler `DATABASE_URL` for that Neon branch (get it from Neon console → branch → Overview → Connect)
- Neon connection strings include `/neondb?sslmode=require&channel_binding=require` — keep the full string
- After bootstrapping, all future migrations run automatically on Render deploy — no manual steps needed
- Production bootstraps itself on first deploy (Render runs `node migrate.js` before starting the server)

**IMPORTANT — never tell the user to run migrations manually:**
- Do not tell the user to run SQL in the Neon console
- Do not tell the user to run `psql` commands
- Do not say "you'll need to run this migration"
- Simply write the migration file, commit, and push — it runs automatically on the next Render deploy
- The user corrected this mistake: migrations are fully automated, no user action required
