/**
 * Office AI tools (Tools module): Summarizer (and, coming next, Document Q&A).
 *
 * Stateless — text in, LLM out; nothing is persisted. Mounted in index.js with
 * requireAuth + requirePlan('business'). Needs ANTHROPIC_API_KEY (see
 * services/anthropic.js); returns 503 when it's absent.
 */

const router = require('express').Router();
const anthropic = require('../services/anthropic');
const pdfParse = require('pdf-parse');

// ~120k chars ≈ 30k tokens: bounds the per-call cost so one huge paste can't
// run up a bill. Longer input is clipped (the client warns when it trims).
const MAX_INPUT = 120000;

// base64 of a PDF must stay under the 20mb express.json cap; 15 MB raw is safe
const MAX_PDF_BYTES = 15 * 1024 * 1024;

function aiReady(res) {
  if (anthropic.isConfigured()) return true;
  res.status(503).json({ error: 'AI features are not configured yet. Ask an admin to add ANTHROPIC_API_KEY.' });
  return false;
}

const SUMMARIZE_SYSTEM =
  'You are a concise assistant for a construction/trades office. You turn call ' +
  'transcripts, meeting notes, and message threads into a clear recap. Output ' +
  'GitHub-flavored markdown with these sections, omitting any that do not apply: ' +
  '"## Summary" (2-4 sentences), "## Key points" (bullets), and "## Action items" ' +
  '(bullets; if an owner is named, start the bullet with their name in bold, e.g. ' +
  '"**Mike:** order rebar Monday"). Be faithful to the source — never invent ' +
  'facts, names, dates, or numbers that are not present.';

router.post('/summarize', async (req, res) => {
  if (!aiReady(res)) return;
  const text = String((req.body && req.body.text) || '').trim();
  if (text.length < 20) {
    return res.status(400).json({ error: 'Paste some text to summarize (a transcript, notes, or a message thread).' });
  }
  try {
    const result = await anthropic.generate({
      system: SUMMARIZE_SYSTEM,
      prompt: `Summarize the following:\n\n${text.slice(0, MAX_INPUT)}`,
      maxTokens: 1200,
    });
    res.json({ result, clipped: text.length > MAX_INPUT });
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'office summarize failed');
    res.status(502).json({ error: 'The AI request failed. Please try again in a moment.' });
  }
});

// --- Document Q&A ---------------------------------------------------------
// /extract pulls the text out of an uploaded PDF once (no AI key needed); the
// client caches that text and sends it back with each question to /ask, so a
// document is parsed once and can be asked many things.

router.post('/extract', async (req, res) => {
  const b64 = String((req.body && req.body.pdfBase64) || '');
  if (!b64) return res.status(400).json({ error: 'No PDF provided.' });
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return res.status(400).json({ error: 'Could not read the PDF.' }); }
  if (!buf.length) return res.status(400).json({ error: 'That PDF appears to be empty.' });
  if (buf.length > MAX_PDF_BYTES) return res.status(413).json({ error: 'That PDF is too large (15 MB max).' });
  try {
    const data = await pdfParse(buf);
    const text = String(data.text || '').trim();
    if (text.length < 10) {
      return res.status(422).json({ error: 'No selectable text found — this looks like a scanned PDF. Doc Q&A needs a text-based PDF.' });
    }
    res.json({ text, pages: data.numpages, chars: text.length });
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'office extract failed');
    res.status(422).json({ error: 'Could not read text from that PDF.' });
  }
});

const ASK_SYSTEM =
  'You answer questions about a single document for a construction/trades office ' +
  'user. Use ONLY the document text provided. If the answer is not in the ' +
  'document, say you could not find it in the document — never guess or add ' +
  'outside knowledge. Be concise and specific, quoting the relevant clause, date, ' +
  'or figure when it helps. If asked to summarize, give a short plain-English ' +
  'summary. Output plain text or light markdown.';

router.post('/ask', async (req, res) => {
  if (!aiReady(res)) return;
  const context = String((req.body && req.body.context) || '').trim();
  const question = String((req.body && req.body.question) || '').trim();
  if (!context) return res.status(400).json({ error: 'Open a PDF first.' });
  if (question.length < 2) return res.status(400).json({ error: 'Type a question about the document.' });
  try {
    const result = await anthropic.generate({
      system: ASK_SYSTEM,
      prompt: `Document:\n"""\n${context.slice(0, MAX_INPUT)}\n"""\n\nQuestion: ${question}`,
      maxTokens: 1000,
    });
    res.json({ result, clipped: context.length > MAX_INPUT });
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'office ask failed');
    res.status(502).json({ error: 'The AI request failed. Please try again in a moment.' });
  }
});

module.exports = router;
