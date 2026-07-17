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

// Jump Start is the premium, pay-per-use feature, so it defaults to the best
// model (Opus) — reading a plan sheet is exactly what a small model is worst at.
// Set ANTHROPIC_VISION_MODEL to dial it down (e.g. claude-sonnet-5) for cost.
const VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL || 'claude-opus-4-8';

/**
 * One-shot vision generation: one image + a text prompt → the response text.
 * `image` is { base64, mediaType } (mediaType e.g. 'image/png'). Same in-band
 * error posture as generate() — throws on transport/API errors.
 */
async function generateVision({ system, prompt, image, maxTokens = 2048, model = VISION_MODEL }) {
  const { data } = await axios.post(
    API_URL,
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType || 'image/png', data: image.base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 120000, // vision + a large sheet image is slower than a text call
    },
  );
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

module.exports = { isConfigured, generate, generateVision, MODEL, VISION_MODEL };
