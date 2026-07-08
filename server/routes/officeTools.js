/**
 * Office AI tools (Tools module): Summarizer (and, coming next, Document Q&A).
 *
 * Stateless — text in, LLM out; nothing is persisted. Mounted in index.js with
 * requireAuth + requirePlan('business'). Needs ANTHROPIC_API_KEY (see
 * services/anthropic.js); returns 503 when it's absent.
 */

const router = require('express').Router();
const anthropic = require('../services/anthropic');

// ~120k chars ≈ 30k tokens: bounds the per-call cost so one huge paste can't
// run up a bill. Longer input is clipped (the client warns when it trims).
const MAX_INPUT = 120000;

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

module.exports = router;
