/**
 * Provider-pluggable vision generation for AI Jump Start.
 *
 * Jump Start is two jobs: READING the sheet (Claude's strength) and LOCALIZING
 * many symbols with coordinates (a grounding task where Gemini is a real
 * contender). No leaderboard covers "count symbols on a scanned civil plan," so
 * the winner is decided by A/B-ing on real sheets — which means the model call
 * has to be swappable. This is the one swap point; everything downstream
 * (parseJumpstart, the client) is provider-agnostic because both providers are
 * asked for the same JSON shape with normalized [0,1] coordinates.
 */

const axios = require('axios');
const anthropic = require('./anthropic');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-pro';

function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

// Gemini transport. Uses JSON response mode so the reply is bare JSON (fewer
// prose/fence wrappers than Anthropic) — though parseJumpstart handles both.
async function geminiGenerateVision({ system, prompt, image, maxTokens = 4096, model = GEMINI_MODEL }) {
  const { data } = await axios.post(
    `${GEMINI_URL}/${model}:generateContent?key=${geminiKey()}`,
    {
      system_instruction: { parts: [{ text: system }] },
      contents: [{
        parts: [
          { inline_data: { mime_type: image.mediaType || 'image/png', data: image.base64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
    },
    { headers: { 'content-type': 'application/json' }, timeout: 120000 },
  );
  const cand = (data.candidates || [])[0];
  return ((cand && cand.content && cand.content.parts) || [])
    .filter(p => typeof p.text === 'string')
    .map(p => p.text)
    .join('')
    .trim();
}

// The registry. Adding a provider is one entry — the route and client don't change.
const PROVIDERS = {
  anthropic: {
    isConfigured: () => anthropic.isConfigured(),
    model: () => anthropic.VISION_MODEL,
    generate: opts => anthropic.generateVision(opts),
  },
  gemini: {
    isConfigured: () => !!geminiKey(),
    model: () => GEMINI_MODEL,
    generate: opts => geminiGenerateVision(opts),
  },
};

const DEFAULT_PROVIDER = process.env.VISION_PROVIDER || 'anthropic';

/** Normalize a requested provider to a known one (default when absent/unknown). */
function pickProvider(requested) {
  const p = typeof requested === 'string' ? requested.toLowerCase() : '';
  return PROVIDERS[p] ? p : DEFAULT_PROVIDER;
}

function visionConfigured(provider) {
  const p = PROVIDERS[provider];
  return !!(p && p.isConfigured());
}

function visionModel(provider) {
  const p = PROVIDERS[provider];
  return p ? p.model() : null;
}

/** Dispatch to the chosen provider. Throws on transport/API errors (route maps to 502). */
async function visionGenerate({ provider, ...opts }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown vision provider: ${provider}`);
  return p.generate(opts);
}

module.exports = {
  PROVIDERS: Object.keys(PROVIDERS),
  DEFAULT_PROVIDER,
  pickProvider,
  visionConfigured,
  visionModel,
  visionGenerate,
  geminiGenerateVision, // exported for tests
};
