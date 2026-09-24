// PDF.js loader for the classic-script tool-apps. pdfjs-dist 4.x ships ES modules
// only (no UMD `pdfjsLib` global), so this module imports the LEGACY build (broadest
// browser support — polyfills Promise.withResolvers etc. for older iPad Safari),
// points it at the module worker, and republishes it as `window.pdfjsLib` — the
// global every tool-app (planroom, pdftools, engine-doc.js) reads at call time.
// Load it with <script type="module"> BEFORE the app script; module + deferred
// scripts execute in document order, so pdfjsLib is set before the app runs.
//
// Vendored from pdfjs-dist@4.10.38 legacy/build (CVE-2024-4367 fixed in ≥4.2.67;
// getDocument calls also pass isEvalSupported:false). The ?v= query is the cache key
// for the service worker's cache-first tool-apps-libs route — bump it with the lib.
import * as pdfjsLib from './pdf.min.mjs?v=4.10.38';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs?v=4.10.38', import.meta.url).href;
window.pdfjsLib = pdfjsLib;
