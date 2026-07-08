/**
 * Thin Anthropic (Claude) client for the Office AI tools (Summarizer, Doc Q&A).
 *
 * ANTHROPIC_API_KEY is intentionally NOT in REQUIRED_ENV (same pattern as
 * ASSEMBLYAI_API_KEY / RESEND_API_KEY): a partially-configured environment
 * still boots, and the office routes return a clear 503 when the key is absent.
 *
 * Uses the cheap Haiku model — plenty for summaries and document Q&A, and keeps
 * per-call cost in cents (see the Office-pack unit economics).
 */

const axios = require('axios');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * One-shot text generation. Returns the concatenated text of the response.
 * Throws on transport/API errors (callers map to a 502).
 */
async function generate({ system, prompt, maxTokens = 1024, model = MODEL }) {
  const { data } = await axios.post(
    API_URL,
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 60000,
    },
  );
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

module.exports = { isConfigured, generate, MODEL };
