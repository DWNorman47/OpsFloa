/**
 * AI Jump Start — vision-model first-draft takeoff for the current Plan Room page.
 *
 * The client renders the current page to a PNG and POSTs it; the best vision
 * model reads the sheet and returns a STRUCTURED draft (counts, rough regions,
 * the scale/legend/labels it can read). The client places those as a reviewable
 * "Jump Start" layer the estimator accepts/edits/rejects — never authoritative.
 *
 * Scan-first by design: precise geometry is unreliable on a raster, so v1's
 * reliable output is counts + reading the sheet; regions are low-confidence
 * candidates; contours are deliberately out (see docs/plans/ai-jump-start.md).
 *
 * Metered through the existing runAi gate for now. Jump Start is far more
 * expensive than a text call, so a credit/token wallet is its own milestone —
 * this just keeps the prototype from being abused.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const anthropic = require('../services/anthropic');
const { runAi } = require('../services/aiGate');

// Coordinates the model returns are normalized [0,1] of the image, so the client
// maps them to its own base-px page — stable across render scales.
const SYSTEM = `You are a senior construction estimator doing quantity takeoff from a single plan sheet image (usually a scan, so treat it as imperfect). Your job is to produce a careful FIRST DRAFT a human estimator will review — not a final takeoff. Be conservative: only mark what you can actually see with reasonable confidence, and say what you could not.

Rules:
- All coordinates are NORMALIZED fractions of the image: x and y each between 0 and 1 (0,0 = top-left, 1,1 = bottom-right).
- COUNTS are your strongest output: locate each discrete repeated symbol (storm inlets/manholes, parking stalls, trees/shrubs, light poles, fixtures, etc.) and give a point for each occurrence. Group by symbol type.
- REGIONS are rough only: outline large areas (parking, building pad, pond/basin, landscape) as a coarse polygon. Mark these low/medium confidence — you cannot trace precisely from a scan.
- Do NOT attempt contour lines, precise property boundaries, or anything requiring exact geometry. Leave those out and note them.
- READ the sheet: the scale notation (e.g. 1"=30'), sheet number/title, legend meanings, and any elevation/spot labels (e.g. FG 512.5).
- Never invent. If you are unsure, use low confidence or omit and explain in notes.
- Reply with ONLY a JSON object, no prose, no markdown fences.`;

const USER_PROMPT = `Analyze this plan sheet and return ONLY this JSON shape:
{
  "sheet": { "type": "grading|utility|paving|site|landscape|other|unknown", "title": "", "number": "" },
  "scale": { "found": true, "text": "1\\"=30'", "feetPerInch": 30, "note": "read from sheet text | not found" },
  "counts": [ { "label": "Storm inlet", "unit": "EA", "confidence": "high|medium|low", "points": [ {"x":0.0,"y":0.0} ] } ],
  "regions": [ { "label": "Parking", "kind": "area", "confidence": "low|medium", "polygon": [ {"x":0.0,"y":0.0} ] } ],
  "labels": [ { "text": "FG 512.5", "kind": "elevation|note|callout|scale", "at": {"x":0.0,"y":0.0} } ],
  "notes": "what you could not do confidently, and why"
}`;

// ── Defensive parsing ─────────────────────────────────────────────────────────
// The model is instructed to return bare JSON but sometimes wraps it in prose or
// ```json fences. Extract, validate, and DROP malformed entries — never throw,
// and never let a bad shape reach the client as authoritative geometry.

function extractJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();
  // strip a leading ```json / ``` fence if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  // last resort: the outermost { ... }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { /* give up */ } }
  return null;
}

const clamp01 = n => { const v = Number(n); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null; };
function normPoint(p) {
  const x = clamp01(p && p.x), y = clamp01(p && p.y);
  return (x == null || y == null) ? null : { x, y };
}
function normPoints(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normPoint).filter(Boolean).slice(0, max);
}
const CONF = new Set(['high', 'medium', 'low']);
const conf = c => (CONF.has(c) ? c : 'low');
const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : '');

// Caps so one runaway response can't flood the review layer.
const MAX_GROUPS = 40, MAX_POINTS = 1000, MAX_REGIONS = 40, MAX_VERTS = 200, MAX_LABELS = 200;

function parseJumpstart(text) {
  const raw = extractJsonObject(text) || {};

  const sheet = raw.sheet && typeof raw.sheet === 'object' ? raw.sheet : {};
  const scale = raw.scale && typeof raw.scale === 'object' ? raw.scale : {};
  const fpi = Number(scale.feetPerInch);
  const scaleFpi = Number.isFinite(fpi) && fpi > 0 ? fpi : null;
  const scaleText = str(scale.text, 40);

  const counts = (Array.isArray(raw.counts) ? raw.counts : [])
    .slice(0, MAX_GROUPS)
    .map(c => ({
      label: str(c && c.label) || 'Item',
      unit: str(c && c.unit, 12) || 'EA',
      confidence: conf(c && c.confidence),
      points: normPoints(c && c.points, MAX_POINTS),
    }))
    .filter(c => c.points.length > 0);

  const regions = (Array.isArray(raw.regions) ? raw.regions : [])
    .slice(0, MAX_REGIONS)
    .map(r => ({
      label: str(r && r.label) || 'Area',
      kind: 'area',
      confidence: conf(r && r.confidence),
      polygon: normPoints(r && r.polygon, MAX_VERTS),
    }))
    .filter(r => r.polygon.length >= 3);

  const labels = (Array.isArray(raw.labels) ? raw.labels : [])
    .slice(0, MAX_LABELS)
    .map(l => ({ text: str(l && l.text, 120), kind: str(l && l.kind, 20) || 'note', at: normPoint(l && l.at) }))
    .filter(l => l.text && l.at);

  return {
    sheet: { type: str(sheet.type, 20) || 'unknown', title: str(sheet.title, 120), number: str(sheet.number, 40) },
    scale: {
      // "found" means we actually have something usable — a positive
      // feet-per-inch or scale text — not merely the model's say-so.
      found: !!(scaleFpi || scaleText),
      text: scaleText,
      feetPerInch: scaleFpi,
      note: str(scale.note, 200),
    },
    counts, regions, labels,
    notes: str(raw.notes, 1000),
    // Totals for the client summary — "found 34 inlets, 120 stalls, 2 regions".
    summary: {
      countGroups: counts.length,
      countPoints: counts.reduce((n, c) => n + c.points.length, 0),
      regions: regions.length,
      labels: labels.length,
    },
  };
}

// POST /api/jumpstart/page  — { imageBase64, mediaType? }
router.post('/page', requireAuth, async (req, res) => {
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  // Guardrail on payload size (base64 of the page PNG). The mount caps the body
  // too; this gives a clean message instead of a parser error.
  if (imageBase64.length > 14_000_000) {
    return res.status(413).json({ error: 'Page image is too large. Try a lower render resolution.' });
  }
  await runAi(req, res, async () => {
    const text = await anthropic.generateVision({
      system: SYSTEM,
      prompt: USER_PROMPT,
      image: { base64: imageBase64, mediaType: mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png' },
      maxTokens: 4096,
    });
    return { result: parseJumpstart(text) };
  });
});

module.exports = router;
module.exports.parseJumpstart = parseJumpstart;
module.exports.extractJsonObject = extractJsonObject;
