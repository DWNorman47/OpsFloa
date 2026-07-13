/**
 * engine-doc.js — document loading for the plan tools: PDF (via pdf.js) and
 * raster images (PNG/JPG as a 1-page doc), plus base64 <-> bytes helpers for
 * self-contained save files.
 *
 * Part of the shared plan-tools engine (see docs/plans/plan-viewer-markup.md).
 * COPY-derived from sitework/app.js (base64 + pdf.js render pattern) — the
 * sitework tool still runs its own monolith and is NOT wired to this module;
 * see shared/PARITY.md. Raster-image support is new to the shared engine.
 *
 * Requires the pdf.js classic script (pdf.min.js) loaded first — it reads the
 * `pdfjsLib` global at call time, like every tool-app already does.
 *
 * The uniform doc handle:
 *   { kind: 'pdf'|'image', numPages, raw,
 *     baseSize(pageNum) -> Promise<{width, height}>   // at scale 1
 *     renderPage(pageNum, scale) -> Promise<canvas> } // offscreen canvas
 */

// Base64 <-> bytes for embedding a document in an exported project file.
export function bytesToBase64(bufOrView) {
  const bytes = bufOrView instanceof Uint8Array ? bufOrView : new Uint8Array(bufOrView);
  let bin = '';
  const chunk = 0x8000; // avoid arg-count limits on fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// PDFs must start with %PDF within the first 1 KB (some writers prepend junk).
export function looksLikePdf(bytes) {
  const n = Math.min(bytes.length - 3, 1024);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

// Render-scale heuristic: sharp enough to zoom into, capped for memory.
export function defaultRenderScale(baseWidth, { maxScale = 3, targetWidth = 2800 } = {}) {
  return Math.min(maxScale, targetWidth / baseWidth);
}

/**
 * Open a document from bytes — PDF or raster image, sniffed by content (or
 * forced via opts.type). NOTE: pdf.js DETACHES the buffer it is given — pass
 * a copy if you need to keep the bytes (for IndexedDB, export, etc.).
 */
export async function openDoc(data, opts = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if ((opts.type || '').includes('pdf') || looksLikePdf(bytes)) return openPdfDoc(bytes);
  return openImageDoc(bytes, opts.type);
}

async function openPdfDoc(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  return {
    kind: 'pdf',
    numPages: pdf.numPages,
    raw: pdf,
    async baseSize(pageNum) {
      const page = await pdf.getPage(pageNum);
      const vp = page.getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    },
    async renderPage(pageNum, scale) {
      const page = await pdf.getPage(pageNum);
      const vp = page.getViewport({ scale });
      const off = document.createElement('canvas');
      off.width = Math.ceil(vp.width);
      off.height = Math.ceil(vp.height);
      await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      return off;
    },
  };
}

async function openImageDoc(bytes, type) {
  const blob = new Blob([bytes], { type: type || 'image/png' });
  const bmp = await createImageBitmap(blob); // throws on non-image → caller surfaces it
  return {
    kind: 'image',
    numPages: 1,
    raw: bmp,
    async baseSize() { return { width: bmp.width, height: bmp.height }; },
    async renderPage(_pageNum, scale) {
      const off = document.createElement('canvas');
      off.width = Math.ceil(bmp.width * scale);
      off.height = Math.ceil(bmp.height * scale);
      const ctx = off.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, off.width, off.height);
      return off;
    },
  };
}
