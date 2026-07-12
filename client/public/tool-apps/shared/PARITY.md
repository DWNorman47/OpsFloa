# Shared engine — parity ledger

The modules in this directory are **copies derived from**
`../sitework/app.js`. The sitework tool is deliberately NOT wired to them —
it keeps running its own monolith untouched until the user-gated
consolidation (see `docs/plans/plan-viewer-markup.md`, M0 note).

**Until then: a bug fix to any function listed below must be applied in BOTH
places.** Keep this ledger current when copying more code.

| Shared module | Function(s) | Copied from sitework/app.js | Changes vs original |
|---|---|---|---|
| engine-measure.js | `dist`, `pointSegDist`, `distToPolyline`, `pointInPolygon`, `polygonAreaFt2`, `polygonPerimeterFt`, `catmullRomSpline` | Utilities section | verbatim |
| engine-measure.js | `simplifyPts` | vector-wand section | verbatim |
| engine-measure.js | `polyLengthFt` | wall-dig section | takes `ftPerPx` as a parameter (original reads `state.calibration`) |
| engine-measure.js | `alignIdentity`, `alignIsIdentity`, `alignApply`, `alignInvert` | Utilities section | verbatim |
| engine-store.js | `idb` + `files*`/`proj*` helpers | IndexedDB section | wrapped in `createStore(dbName)` — each tool gets its own DB (sitework's is `'ebc'` v2) |
| engine-store.js | `randId`, `hashBytes` | Utilities/IndexedDB sections | verbatim |
| engine-doc.js | `bytesToBase64`, `base64ToBytes` | PDF-loading section | verbatim |
| engine-doc.js | pdf.js open/render pattern (`openDoc`/`renderPage`) | `openPdfBytes`/`renderSheet` | generalized to a uniform doc handle; raster-image support is NEW (no sitework counterpart) |
