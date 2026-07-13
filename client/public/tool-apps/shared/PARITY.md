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
| engine-view.js | `resizeCanvas`, `fitView`, `panBy`, wheel zoom-at-cursor, rAF-coalesced `draw`, `paint` transform setup, nav-pads zoom heuristic | View/canvas + Tools&input sections | reworked into `createViewport(...)` factory (originals read `state.view`/`cv`/`els`); the math is verbatim |
| engine-ui.js | `fmt`, `money`, `esc` | Utilities section | verbatim |
| engine-ui.js | `askModal`, `closeModal`, `readModalValue`, `askNumber`, `askText`, stepper + Enter/Escape wiring | Modal section | reworked into `createModals(...)` factory taking the modal DOM nodes; logic verbatim |
| planroom/app.js | `makeInterpolator` | Surface-interpolation section | verbatim |
| planroom/app.js | cut/fill grid loop (`calculate` core: bbox, 60k-cell coarsen, `zp−ze`, chunked rows) | Cut/fill section | verbatim math; adapted to per-page geometry — proposed surface + boundary map into existing space via the align transform at compute time |
| planroom/app.js | export math (`fillBank = fill/(1−shrink)`, `net = cut − fillBank`, export hauls `×(1+swell)`, loads) | `renderResults` | verbatim |
| planroom/app.js | align solve (1 pair = shift; 2 pairs: `a=(dq·dp)/|dq|²`, `b=(dq×dp)/|dq|²`, 20px too-close guard) | Tools&input align branch | verbatim math; page-jump flow instead of sheet-switch; raw page coords (no world-space `alignInvert` on input) |
| planroom/app.js | `drawHeat` cut/fill heat overlay | `drawHeatmap` | verbatim (red cut / blue fill, 0.02 dead-band) |
| planroom/app.js | `elevColor` | Utilities section | verbatim (proposed lightness 52 vs 55) |
| planroom/app.js | Area takeoff: `AREA_PRESETS`, `AREA_MODE_COLORS`, `autoAreaColor`, `REBAR`, `rebarQuantity`, `areaQuantity`, `computeAreaResult`, `areaResultRows`, `readAreaCfg`, `syncAreaMode`, `askAreaConfig` | Area-takeoff section | verbatim math; `areaColorHex` takes cfg directly; a qarea markup stores the cfg + polygon (area/perimeter recompute from geometry × sheet scale) instead of sitework's `state.takeoffs` |
| planroom/app.js | Line takeoff: `wallSectionAreaSf`, `LINE_PRESETS`, `autoLineColor`, `lineColorHex`, `computeLineResult`, `lineResultRows`, `readLineCfg`, `syncLineTrench`, `askLineConfig` | Linear-takeoff section | verbatim math; qline markup stores cfg + polyline (length recomputes from geometry × scale); `defaultNewLineColor` reads the selected qline instead of `state.selTake` |
