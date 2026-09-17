---
name: Infrastructure — database and build commands
description: Hosting stack details so Claude gives accurate deployment instructions
type: project
---

Database is hosted on **Neon** (not Render). Do not tell the user to find a database on Render or use Render's PSQL shell.

Neon has three branches:
- **Production** — live database
- **Stage** — staging environment
- **Dev** — development environment

Build/start commands use **npm**, not yarn:
- Backend build: `npm install`
- Backend start: `node index.js`
- Frontend build: `npm install && npm run build`

**Why:** User was confused when given yarn commands and Render database instructions — neither matches their actual setup.

**How to apply:** Any time deployment, migration, or build commands come up, use npm and reference Neon for the database.
