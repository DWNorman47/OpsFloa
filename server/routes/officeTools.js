/**
 * Office AI tools (Tools module): Summarizer, Document Q&A, Email drafter.
 *
 * No request content is persisted — only a per-company monthly usage counter
 * (office_ai_usage) that caps the Claude-backed calls so a flat-priced pack
 * can't be run up. Mounted in index.js with requireAuth + requirePlan('business').
 * Needs ANTHROPIC_API_KEY (see services/anthropic.js); returns 503 when absent.
 */

const router = require('express').Router();
const pool = require('../db');
const anthropic = require('../services/anthropic');
const pdfParse = require('pdf-parse');

// ~120k chars ≈ 30k tokens: bounds the per-call cost so one huge input can't
// run up a bill. Longer input is clipped (the client warns when it trims).
const MAX_INPUT = 120000;

// base64 of a PDF must stay under the 20mb express.json cap; 15 MB raw is safe
const MAX_PDF_BYTES = 15 * 1024 * 1024;

// Monthly per-company ceiling on AI calls (summarize / ask / draft). Generous by
// default; override with OFFICE_AI_MONTHLY_LIMIT. Enforced via office_ai_usage.
const AI_MONTHLY_LIMIT = Math.max(1, parseInt(process.env.OFFICE_AI_MONTHLY_LIMIT, 10) || 300);

function aiReady(res) {
  if (anthropic.isConfigured()) return true;
  res.status(503).json({ error: 'AI features are not configured yet. Ask an admin to add ANTHROPIC_API_KEY.' });
  return false;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Atomically count one AI call for the company this month. Over the cap → rolls
// the increment back so the counter can't run away. Fails open on a DB hiccup —
// metering must never take the feature down.
async function reserveAiCall(companyId) {
  const period = currentPeriod();
  try {
    const { rows } = await pool.query(
      `INSERT INTO office_ai_usage (company_id, period, count, updated_at)
         VALUES ($1, $2, 1, now())
       ON CONFLICT (company_id, period)
         DO UPDATE SET count = office_ai_usage.count + 1, updated_at = now()
       RETURNING count`,
      [companyId, period],
    );
    if (rows[0].count > AI_MONTHLY_LIMIT) {
      await pool.query(
        'UPDATE office_ai_usage SET count = count - 1 WHERE company_id = $1 AND period = $2',
        [companyId, period],
      );
      return false;
    }
    return true;
  } catch (_) {
    return true; // don't block the tool if the counter is unavailable
  }
}

// Return a reserved slot when the AI call itself fails, so a failed request
// doesn't count against the customer.
async function refundAiCall(companyId) {
  try {
    await pool.query(
      'UPDATE office_ai_usage SET count = GREATEST(0, count - 1) WHERE company_id = $1 AND period = $2',
      [companyId, currentPeriod()],
    );
  } catch (_) { /* best effort */ }
}

function overLimit(res) {
  res.status(429).json({
    error: `You've reached this month's AI limit (${AI_MONTHLY_LIMIT} requests). It resets at the start of next month.`,
  });
}

// Wrap an AI endpoint with the config check + monthly gate + refund-on-failure.
// handler() does the work and returns the JSON body to send.
async function runAi(req, res, handler) {
  if (!aiReady(res)) return;
  if (!(await reserveAiCall(req.user.company_id))) return overLimit(res);
  try {
    res.json(await handler());
  } catch (err) {
    await refundAiCall(req.user.company_id);
    if (req.log && req.log.error) req.log.error({ err }, 'office AI request failed');
    res.status(502).json({ error: 'The AI request failed. Please try again in a moment.' });
  }
}

router.get('/usage', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT count FROM office_ai_usage WHERE company_id = $1 AND period = $2',
      [req.user.company_id, currentPeriod()],
    );
    res.json({ count: rows[0] ? rows[0].count : 0, limit: AI_MONTHLY_LIMIT });
  } catch (_) {
    res.json({ count: 0, limit: AI_MONTHLY_LIMIT });
  }
});

// --- Summarizer -----------------------------------------------------------

const SUMMARIZE_SYSTEM =
  'You are a concise assistant for a construction/trades office. You turn call ' +
  'transcripts, meeting notes, and message threads into a clear recap. Output ' +
  'GitHub-flavored markdown with these sections, omitting any that do not apply: ' +
  '"## Summary" (2-4 sentences), "## Key points" (bullets), and "## Action items" ' +
  '(bullets; if an owner is named, start the bullet with their name in bold, e.g. ' +
  '"**Mike:** order rebar Monday"). Be faithful to the source — never invent ' +
  'facts, names, dates, or numbers that are not present.';

router.post('/summarize', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (text.length < 20) {
    return res.status(400).json({ error: 'Paste some text to summarize (a transcript, notes, or a message thread).' });
  }
  await runAi(req, res, async () => ({
    result: await anthropic.generate({
      system: SUMMARIZE_SYSTEM,
      prompt: `Summarize the following:\n\n${text.slice(0, MAX_INPUT)}`,
      maxTokens: 1200,
    }),
    clipped: text.length > MAX_INPUT,
  }));
});

// --- Document Q&A ---------------------------------------------------------
// /extract pulls the text out of an uploaded PDF once (no AI key, not metered);
// the client caches it and sends it back with each question to /ask.

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
  const context = String((req.body && req.body.context) || '').trim();
  const question = String((req.body && req.body.question) || '').trim();
  if (!context) return res.status(400).json({ error: 'Open a PDF first.' });
  if (question.length < 2) return res.status(400).json({ error: 'Type a question about the document.' });
  await runAi(req, res, async () => ({
    result: await anthropic.generate({
      system: ASK_SYSTEM,
      prompt: `Document:\n"""\n${context.slice(0, MAX_INPUT)}\n"""\n\nQuestion: ${question}`,
      maxTokens: 1000,
    }),
    clipped: context.length > MAX_INPUT,
  }));
});

// --- Contract red-flag scanner -------------------------------------------

// The value here is knowing WHAT to look for. A sub is handed a 40-page
// subcontract and signs it because reading it costs a day they don't have; the
// clauses that actually cost them money are a known, finite list, so the prompt
// names them rather than asking for "anything concerning" and hoping.
//
// Grounding rules mirror ASK_SYSTEM: quote the document, never invent. A
// hallucinated clause here is worse than a miss — someone would negotiate over
// language that isn't in their contract.
const RED_FLAG_SYSTEM =
  'You review construction contracts (subcontracts, purchase orders, specs) for a ' +
  'subcontractor or trade contractor and flag the terms that carry real money or ' +
  'risk. Use ONLY the document text provided. Quote the actual language — never ' +
  'invent, paraphrase into something stronger than the text, or add outside ' +
  'knowledge. If a term is absent, its absence can itself be a flag (say so ' +
  'plainly, e.g. no stated payment window), but never claim the document says ' +
  'something it does not.\n\n' +
  'Look specifically for: pay-if-paid / pay-when-paid; retainage amount and ' +
  'release conditions; payment timing and any missing payment window; notice ' +
  'windows for claims, delays and changes (short deadlines that waive rights are ' +
  'the single most common way a sub loses money); no-damage-for-delay; ' +
  'liquidated damages; broad-form or unlimited indemnity; defense obligations; ' +
  'termination for convenience; scope language that is open-ended ("as directed", ' +
  '"means and methods", "reasonably inferable", work implied but not shown); ' +
  'change-order procedure and whether extra work needs written authorization ' +
  'first; warranty duration and start; backcharge rights; consequential-damages ' +
  'waivers that run one way; insurance limits, additional-insured and waiver of ' +
  'subrogation; lien-waiver conditions and whether waivers are required before ' +
  'payment; dispute venue, arbitration and attorney-fee shifting; schedule ' +
  'obligations and float ownership.\n\n' +
  'Rank by how much it could actually cost, worst first. For each finding use ' +
  'EXACTLY this shape:\n\n' +
  '## HIGH — <short name> (<section ref if the document gives one>)\n' +
  '- **Says:** "<short exact quote from the document>"\n' +
  '- **Why it matters:** <one or two plain sentences, no legalese>\n' +
  '- **Ask for:** <the specific edit to negotiate>\n\n' +
  'Use HIGH, MEDIUM or LOW as the severity word. Open with a one-line ' +
  '"## Bottom line" paragraph naming the single worst term. If the document is ' +
  'clean or is not a contract at all, say so plainly rather than inventing ' +
  'findings. Close with a "## Not legal advice" note saying this is a reading ' +
  'aid and a lawyer should review anything material. Output only the markdown ' +
  'shapes above: ## headings, - bullets, **bold**. No tables, no code blocks.';

router.post('/scan-contract', async (req, res) => {
  const context = String((req.body && req.body.context) || '').trim();
  if (!context) return res.status(400).json({ error: 'Open a contract PDF first.' });
  await runAi(req, res, async () => ({
    result: await anthropic.generate({
      system: RED_FLAG_SYSTEM,
      prompt: `Contract:\n"""\n${context.slice(0, MAX_INPUT)}\n"""\n\nReview this contract and flag the terms that carry real money or risk for the subcontractor.`,
      // Higher than /ask (1000) because this returns many findings rather than
      // one answer, but held at 2000 to stay clear of the 60s client timeout in
      // services/anthropic.js on a full-length MAX_INPUT contract.
      maxTokens: 2000,
    }),
    clipped: context.length > MAX_INPUT,
  }));
});

// --- Email / message drafter ---------------------------------------------

const DRAFT_SYSTEM =
  'You draft short, professional messages (email or text) for a construction/' +
  'trades business. From a few notes or bullet points, write a clear, courteous, ' +
  'ready-to-send message in the requested tone. Keep it concise. Do not invent ' +
  'specifics (names, prices, dates, addresses) that are not provided — use ' +
  'bracketed placeholders like [name] or [date] when needed. Output only the ' +
  'message; include a short "Subject:" line first only when it is clearly an ' +
  'email and a subject helps.';

router.post('/draft-email', async (req, res) => {
  const points = String((req.body && req.body.points) || '').trim();
  const tone = String((req.body && req.body.tone) || 'professional').trim().slice(0, 30) || 'professional';
  if (points.length < 5) {
    return res.status(400).json({ error: 'Add a few notes about what the message should say.' });
  }
  await runAi(req, res, async () => ({
    result: await anthropic.generate({
      system: DRAFT_SYSTEM,
      prompt: `Tone: ${tone}\nWrite a message that covers:\n\n${points.slice(0, MAX_INPUT)}`,
      maxTokens: 800,
    }),
  }));
});

module.exports = router;
