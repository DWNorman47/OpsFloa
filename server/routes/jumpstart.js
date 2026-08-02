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
const { pickProvider, visionConfigured, visionModel, visionGenerate } = require('../services/vision');
const { reserveAiCall, refundAiCall, overLimit } = require('../services/aiGate');

// Coordinates the model returns are normalized [0,1] of the image, so the client
// maps them to its own base-px page — stable across render scales.
const SYSTEM = `You are a senior construction estimator doing quantity takeoff from a single plan sheet image (usually a scan, so treat it as imperfect). Your job is to produce a careful FIRST DRAFT a human estimator will review — not a final takeoff. Be conservative: only mark what you can actually see with reasonable confidence, and say what you could not.

You are told which TRADE the estimator is working. Tailor your output to that trade — return the quantities that trade needs, and DO NOT pad the draft with items from other trades. If the sheet is the wrong kind for the trade (e.g. an earthwork cut/fill takeoff but this is an existing-conditions sheet with no proposed grade), say so plainly instead of inventing quantities.

Rules:
- All coordinates are NORMALIZED fractions of the image: x and y each between 0 and 1 (0,0 = top-left, 1,1 = bottom-right).
- COUNTS are your strongest output: locate each discrete repeated symbol and give a point for each occurrence. Group by symbol type. Keep opposite dispositions in SEPARATE groups (e.g. "to be removed" vs "to be protected" — never merge them), and do not also draw a region covering the same items.
- REGIONS are rough only: outline a large area as a coarse polygon and mark it low/medium confidence — you cannot trace precisely from a scan. Only include regions the trade actually needs.
- READING is reliable: the scale notation (e.g. 1"=30'), sheet number/title, legend meanings, and elevation/spot labels (e.g. FG 512.5) are text — read them carefully.
- Do NOT trace contour lines or precise property boundaries — those need exact geometry a raster can't give. Leave them out and note them.
- Never invent. If you are unsure, use low confidence or omit and explain in notes.
- Reply with ONLY a JSON object, no prose, no markdown fences.`;

// What each trade needs from a first-draft pass. Appended to the base schema so the
// model targets the right quantities instead of a generic "what's on this sheet" scan.
const TRADE_FOCUS = {
  dirt: `TRADE: EARTHWORK (cut / fill). Cut/fill is the difference between two surfaces (existing grade vs proposed/finished grade), so it is only computable when the sheet shows BOTH — or when a separate proposed-grade sheet exists. Do this, in priority order:
1. Fill "earthwork": does the sheet show EXISTING contours? PROPOSED (finished-grade) contours? If only existing is shown (e.g. an "EXISTING CONDITIONS" sheet), set cutFillComputable=false and explain in reason that there is no proposed grade to difference against — the estimator should run this on the grading/proposed sheet.
2. Read every SPOT ELEVATION into "spots": the numeric value (e.g. "FG 512.5" -> 512.5) and, if you can tell, the surface — existing is often dashed/lighter or tagged EG/EX/(parenthesized); proposed is bold or tagged FG/FF/FS/TC/TW/BW. Use surface "unknown" when unsure.
3. If a limits-of-disturbance / grading limit / clearing line is drawn, outline it as ONE region labeled "Limits of disturbance".
Do NOT trace contour polylines. Do NOT invent a clearing/landscape/"trees to be removed" blob or generic tree counts — that is not earthwork. Leave "counts" empty unless there are discrete earthwork structures (e.g. retaining-wall callouts).`,
  roofing: `TRADE: ROOFING. Outline each roof plane as a rough region; count penetrations (vents, stacks, curbs, skylights) as counts; read any pitch/slope notes (e.g. "6:12") into labels. Leave "spots"/"earthwork" empty.`,
  striping: `TRADE: PARKING / STRIPING. Count parking stalls, ADA stalls, arrows, and wheel stops as separate count groups; read stall dimensions into labels. Regions only for striped islands/no-park zones. Leave "spots"/"earthwork" empty.`,
  landscape: `TRADE: LANDSCAPE. Count trees and shrubs as SEPARATE groups by symbol; outline planting beds / sod areas as rough regions. Read plant-schedule keys into labels. Leave "spots"/"earthwork" empty.`,
  esc: `TRADE: EROSION & SEDIMENT CONTROL. Count inlet-protection symbols; outline disturbed/stabilized areas as rough regions; treat silt fence / construction fence as region edges you note in labels (you cannot measure line length precisely). Leave "spots"/"earthwork" empty.`,
  demo: `TRADE: DEMOLITION. Outline areas/structures to be demolished as rough regions and count discrete items to remove (keep "remove" separate from anything to "protect"). Leave "spots"/"earthwork" empty.`,
  fence: `TRADE: FENCING. Count gates and corner/end posts; note fence runs in labels (you cannot measure line length precisely on a raster). Leave "spots"/"earthwork" empty.`,
  drywall: `TRADE: DRYWALL. This is usually a floor plan: outline rooms as rough regions and count door/window openings. Leave "spots"/"earthwork" empty.`,
  flooring: `TRADE: FLOORING. Outline each room/floor area as a rough region grouped by finish if labeled. Leave "spots"/"earthwork" empty.`,
  framing: `TRADE: FRAMING. Outline wall runs / floor areas as rough regions and count openings. Leave "spots"/"earthwork" empty.`,
  siding: `TRADE: SIDING. This is usually an elevation: outline each wall face as a rough region and count openings (windows, doors). Leave "spots"/"earthwork" empty.`,
};
const GENERIC_FOCUS = `TRADE: general site takeoff. Focus on COUNTS of repeated symbols and rough area REGIONS relevant to site work. Leave "spots"/"earthwork" empty.`;

function buildUserPrompt(trade) {
  const focus = TRADE_FOCUS[trade] || GENERIC_FOCUS;
  return `${focus}

Return ONLY this JSON shape (omit "spots"/"earthwork" unless the trade above asked for them):
{
  "sheet": { "type": "grading|existing-conditions|utility|paving|site|landscape|other|unknown", "title": "", "number": "" },
  "scale": { "found": true, "text": "1\\"=30'", "feetPerInch": 30, "note": "read from sheet text | not found" },
  "counts": [ { "label": "Storm inlet", "unit": "EA", "confidence": "high|medium|low", "points": [ {"x":0.0,"y":0.0} ] } ],
  "regions": [ { "label": "Parking", "kind": "area", "confidence": "low|medium", "polygon": [ {"x":0.0,"y":0.0} ] } ],
  "spots": [ { "label": "FG 512.5", "elev": 512.5, "surface": "existing|proposed|unknown", "at": {"x":0.0,"y":0.0} } ],
  "earthwork": { "existingContours": false, "proposedContours": false, "contourInterval": "", "cutFillComputable": false, "reason": "" },
  "labels": [ { "text": "note text", "kind": "elevation|note|callout|scale", "at": {"x":0.0,"y":0.0} } ],
  "notes": "what you could not do confidently, and why"
}`;
}

// Trades the client may send; anything else falls back to the generic pass.
const TRADES = new Set(['', 'roofing', 'dirt', 'drywall', 'flooring', 'framing', 'esc', 'striping', 'siding', 'demo', 'fence', 'landscape']);
const normTrade = t => (TRADES.has(t) ? t : '');

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
const SURFACES = new Set(['existing', 'proposed', 'unknown']);
const surf = s => (SURFACES.has(s) ? s : 'unknown');
const bool = v => v === true;
const finiteNum = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Caps so one runaway response can't flood the review layer.
const MAX_GROUPS = 40, MAX_POINTS = 1000, MAX_REGIONS = 40, MAX_VERTS = 200, MAX_LABELS = 200, MAX_SPOTS = 500;

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

  // Earthwork spot elevations — a point + a numeric elevation + best-guess surface.
  // Only kept when we have both a placeable point and a finite elevation.
  const spots = (Array.isArray(raw.spots) ? raw.spots : [])
    .slice(0, MAX_SPOTS)
    .map(s => ({ label: str(s && s.label, 40), elev: finiteNum(s && s.elev), surface: surf(s && s.surface), at: normPoint(s && s.at) }))
    .filter(s => s.at && s.elev != null);

  // Earthwork feasibility verdict (only meaningful for the dirt trade).
  const ew = raw.earthwork && typeof raw.earthwork === 'object' ? raw.earthwork : null;
  const earthwork = ew ? {
    existingContours: bool(ew.existingContours),
    proposedContours: bool(ew.proposedContours),
    contourInterval: str(ew.contourInterval, 40),
    // Only "computable" when the model both says so AND actually saw a proposed surface.
    cutFillComputable: bool(ew.cutFillComputable) && bool(ew.proposedContours),
    reason: str(ew.reason, 300),
  } : null;

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
    counts, regions, labels, spots, earthwork,
    notes: str(raw.notes, 1000),
    // Totals for the client summary — "found 34 inlets, 120 stalls, 2 regions".
    summary: {
      countGroups: counts.length,
      countPoints: counts.reduce((n, c) => n + c.points.length, 0),
      regions: regions.length,
      labels: labels.length,
      spots: spots.length,
    },
  };
}

// POST /api/jumpstart/page  — { imageBase64, mediaType?, provider? }
//
// Metering is composed by hand (reserve/refund) rather than runAi, because
// runAi's config check is Anthropic-specific and Jump Start is provider-pluggable
// — a Gemini request must check Gemini's key, not Anthropic's.
router.post('/page', requireAuth, async (req, res) => {
  const { imageBase64, mediaType, provider: requestedProvider, trade: requestedTrade } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  const trade = normTrade(requestedTrade);
  // Guardrail on payload size (base64 of the page PNG). The mount caps the body
  // too; this gives a clean message instead of a parser error.
  if (imageBase64.length > 14_000_000) {
    return res.status(413).json({ error: 'Page image is too large. Try a lower render resolution.' });
  }

  const provider = pickProvider(requestedProvider);
  if (!visionConfigured(provider)) {
    return res.status(503).json({ error: `AI Jump Start isn't configured for ${provider}. Ask an admin to set the API key.` });
  }

  if (!(await reserveAiCall(req.user.company_id))) return overLimit(res);
  try {
    const text = await visionGenerate({
      provider,
      system: SYSTEM,
      prompt: buildUserPrompt(trade),
      image: { base64: imageBase64, mediaType: mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png' },
      maxTokens: 4096,
    });
    res.json({ result: parseJumpstart(text), provider, model: visionModel(provider), trade });
  } catch (err) {
    await refundAiCall(req.user.company_id); // a failed call shouldn't cost them
    if (req.log && req.log.error) req.log.error({ err, provider }, 'jumpstart failed');
    res.status(502).json({ error: 'The AI request failed. Please try again in a moment.' });
  }
});

module.exports = router;
module.exports.parseJumpstart = parseJumpstart;
module.exports.extractJsonObject = extractJsonObject;
