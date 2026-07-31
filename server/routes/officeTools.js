/**
 * Office AI tools (Tools module): Summarizer, Document Q&A, Contract red-flag
 * scanner, Email drafter.
 *
 * No request content is persisted by THESE routes — they're paste-in, read-out.
 * (Meeting minutes in routes/recordings.js does persist, because it's attached
 * to a recording that already stores its transcript.) Metering is shared via
 * services/aiGate.js. Mounted in index.js with requireAuth +
 * requirePlan('business'). Needs ANTHROPIC_API_KEY (see services/anthropic.js);
 * returns 503 when absent.
 */

const router = require('express').Router();
const anthropic = require('../services/anthropic');
const pdfParse = require('pdf-parse');

// The AI gate (config check, monthly quota, refund-on-failure, 503/429/502)
// lives in services/aiGate.js — recordings.js needs the same counter for
// meeting minutes, and two copies would mean two counters disagreeing about
// one company's limit. MAX_INPUT (~120k chars ≈ 30k tokens) bounds the
// per-call cost; longer input is clipped and the client warns.
const { runAi, usageFor, MAX_INPUT } = require('../services/aiGate');

// base64 of a PDF must stay under the 20mb express.json cap; 15 MB raw is safe
const MAX_PDF_BYTES = 15 * 1024 * 1024;

router.get('/usage', async (req, res) => {
  res.json(await usageFor(req.user.company_id));
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

// --- Bilingual crew task cards -------------------------------------------

// "Speak English. Your crew reads Spanish." A foreman jots the day's tasks in
// English; the crew gets a clean Spanish task card. Default is bilingual so the
// foreman can eyeball the translation against what they wrote — that trust is
// the whole reason they'll use it instead of guessing at Spanish themselves.
const CREW_CARD_SYSTEM =
  "You create clear task cards for a construction crew, translating a foreman's " +
  'English notes into simple, plain worksite Spanish — neutral Latin American ' +
  'Spanish, the way a crew lead actually talks: clear, direct, respectful, not ' +
  'formal textbook Spanish. Use short imperative instructions. Use trade terms a ' +
  'working crew recognizes; when a term is regional, choose the most widely ' +
  'understood one. Do NOT invent tasks, quantities, measurements, names, ' +
  'addresses, or times that are not in the notes — when a specific is missing ' +
  'but clearly needed, leave a bracketed placeholder like [cantidad] or [hora] ' +
  'rather than making one up.\n\n' +
  'Output GitHub-flavored markdown using ONLY these shapes: "## " headings, ' +
  '"- " bullets, and **bold**. Structure the card as:\n' +
  '- A "## " title line — use the job/site name if one is given, otherwise ' +
  '"Tareas del día".\n' +
  '- "## Tareas" — one bullet per task, in the order given.\n' +
  '- "## Materiales y herramientas" — ONLY if materials or tools are mentioned.\n' +
  '- "## Seguridad" — ONLY if a safety point is mentioned or a task plainly ' +
  'requires one (e.g. arnés for work at height); keep it to a line or two.\n\n' +
  'Keep the card to what the crew needs to do the work — no greeting, no ' +
  'preamble, no closing remarks. Headings stay in Spanish as shown above.';

router.post('/crew-card', async (req, res) => {
  const tasks = String((req.body && req.body.tasks) || '').trim();
  const job = String((req.body && req.body.job) || '').trim().slice(0, 120);
  // Default to bilingual — only false when the client explicitly asks for
  // Spanish-only.
  const bilingual = !(req.body && req.body.bilingual === false);
  if (tasks.length < 5) {
    return res.status(400).json({ error: 'Add the tasks or notes you want on the crew card.' });
  }
  const jobLine = job ? `Job / site name: ${job}\n` : '';
  const mode = bilingual
    ? 'Make the card BILINGUAL: for every title, task, and note, write the ' +
      'Spanish first and then the English in parentheses on the same line, e.g. ' +
      '"- Instalar la manta de control de erosión (Install the erosion-control blanket)". ' +
      'Section headings stay Spanish-only.'
    : 'Make the card SPANISH ONLY — do not include the English.';
  await runAi(req, res, async () => ({
    result: await anthropic.generate({
      system: CREW_CARD_SYSTEM,
      prompt: `${jobLine}${mode}\n\nForeman's tasks / notes (English):\n\n${tasks.slice(0, MAX_INPUT)}`,
      maxTokens: 1200,
    }),
    clipped: tasks.length > MAX_INPUT,
  }));
});

module.exports = router;
