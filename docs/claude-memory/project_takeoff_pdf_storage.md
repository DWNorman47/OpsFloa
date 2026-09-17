---
name: project_takeoff_pdf_storage
description: How company-shared takeoff PDFs are stored (R2) and the deferred presigned-upload decision
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
---

Company-shared sitework takeoffs store the plan PDF in **Cloudflare R2** (`server/r2.js`, key `takeoffs/<uuid>.pdf`). The `takeoff_projects` DB row holds only the R2 URL (`pdf_url`) plus the takeoff geometry JSON (`data`) — no PDF bytes in Postgres.

**Current approach (chosen 2026-07-10):** the browser base64-encodes the whole PDF into the JSON `POST /api/takeoffs` body; the server decodes and uploads to R2 via `uploadBase64`. Because base64 inflates ~+33% and the whole PDF passes through `express.json`, `/api/takeoffs` has a dedicated **64 MB** `express.json` parser in `server/index.js` (ahead of the 20 MB app-wide default; first parser wins). Hard ceiling: plans over ~48 MB raw still 413 (now with a clear "PDF too large" message in the Company modal, not a dead button). Download is proxied through the API (`getBytesByUrl`) so the browser never needs R2 CORS.

**Deferred alternative the user may switch to later:** presigned direct browser→R2 upload — `r2.js` already exports `getPresignedUploadUrl`. Flow: get presigned URL → browser PUTs PDF straight to R2 → POST only the small `data` JSON + URL. Removes the body-size ceiling and cuts server memory.

**Why kept the bandaid:** typical civil plan sets are ~5–30 MB, so 64 MB is plenty and far simpler. Presigned adds real cost: (1) must configure **R2 bucket CORS** for browser PUT (today CORS is avoided entirely); (2) **orphaned R2 objects** — the 3-step flow isn't atomic, so a failed/abandoned metadata POST leaks a stored PDF, needing an R2 lifecycle rule or sweep job; (3) server can't vet the bytes; (4) more failure modes / harder to test. It doesn't make the PDF smaller either.

**How to apply:** only reach for presigned if plans regularly approach/exceed ~48 MB or there's heavy concurrent sharing. If switching, do the orphan-cleanup piece carefully (lifecycle rule or sweep). Relates to [[project_storm_utility_module]] (the takeoff add-on) and [[project_infrastructure]].
