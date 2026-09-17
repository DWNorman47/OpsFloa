---
name: project_media_tools_2026-09
description: "Sep 2026 media/tool-app work — Field Work photo/video downloads, the on-device video converter, and the tool-apps on-demand-caching (precache trim + PDF dedup)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 85776767-90bb-4223-b040-db72b6b6edd9
  modified: 2026-09-03T17:53:35.748Z
---

Session of 2026-09-02/03 (dev). Three related things shipped:

**1. Field Work photo/video downloads.** Field Work > Notes had no in-app way to save media
(plain `<img>` on direct R2 URLs). Added a per-item **Download** in both lightboxes
(`FieldDayLog` notes + admin `PhotoGallery`) + an admin **"Download all (ZIP)"** wired to the
already-built `/admin/projects/:id/media-zip`. Downloads go through a proxy endpoint
`GET /field-reports/photos/:id/download` (streams via new `r2.getObjectStreamByUrl`,
`Content-Disposition: attachment`), fetched as a blob so the JWT rides along — no dependence on
R2 CORS. Scoped like viewing (worker=own, admin=company).

**2. On-device video converter** (`client/public/tool-apps/videoconvert/`). Static tool-app
running **multithreaded ffmpeg.wasm** (self-hosted `@ffmpeg/core-mt`, a **~32MB wasm vendored
into the repo**). Converts iPhone/QuickTime `.mov` etc. entirely in the browser. Key design:
cross-origin isolation (COOP:same-origin + COEP:require-corp) is scoped **only** to
`/tool-apps/videoconvert/(.*)` in `client/vercel.json` so the main app (Stripe/embeds) is
untouched — it's opened as its **own tab** (an iframe can't be isolated under a non-isolated
parent). Launched from the video lightbox "Convert" button via an **IndexedDB blob handoff**
(`client/src/utils/videoConvert.js`). It **ffprobes and auto-remuxes H.264** (`-c copy`,
instant) and only re-encodes when the source is truly non-H.264 (HEVC), with ultrafast +
explicit stream mapping. Has Cancel + live elapsed + "this can take a while" messaging.

**3. Tool-apps are now cached ON DEMAND, not precached (durable architectural fact).** ALL
`/tool-apps/**` (Plan Room, PDF Tools, Video Converter) are excluded from the Workbox precache
(`client/vite.config.js` globIgnores `**/tool-apps/**`) and cached at RUNTIME by `client/src/sw.js`
(cache-first for stable vendored libs incl. the 32MB wasm; network-first for each tool's
html/app/css). Also **deduped** the PDF.js worker / pdf-lib / pdf.min that were shipped twice
(pdftools now loads them from `../shared/`). Net: the shared SW precache dropped from ~2.0MB
gzip / ~6.6MB stored to ~0.62MB / ~2.0MB — a user who never opens a tool downloads none of it,
and Workbox auto-evicts the old entries from existing users on the next SW activation.
**When touching the SW / precache / tool-apps, keep this on-demand split** — don't re-precache
tool-apps. All details are in `docs/WORKLOG.md` (2026-09-02/03). Related: [[reference_map_and_verify]].
