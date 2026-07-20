/**
 * The vision provider dispatcher — the one swap point that lets Jump Start
 * A/B Opus vs Gemini on real sheets. Pins provider selection, per-provider
 * config gating, and the Gemini request/response shaping (mocked transport).
 */

const mockPost = jest.fn();
jest.mock('axios', () => ({ post: (...a) => mockPost(...a) }));

// Anthropic is a real module here but we only exercise its config/model surface.
process.env.ANTHROPIC_VISION_MODEL = 'claude-opus-test';
process.env.GEMINI_VISION_MODEL = 'gemini-test-pro';

beforeEach(() => {
  mockPost.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.VISION_PROVIDER;
  jest.resetModules();
});

function load() {
  return require('../services/vision');
}

describe('pickProvider', () => {
  test('known provider passes through; unknown/absent falls back to the default', () => {
    const v = load();
    expect(v.pickProvider('gemini')).toBe('gemini');
    expect(v.pickProvider('anthropic')).toBe('anthropic');
    expect(v.pickProvider('GEMINI')).toBe('gemini');   // case-insensitive
    expect(v.pickProvider('bogus')).toBe('anthropic');  // default
    expect(v.pickProvider(undefined)).toBe('anthropic');
  });

  test('VISION_PROVIDER changes the default', () => {
    process.env.VISION_PROVIDER = 'gemini';
    const v = load();
    expect(v.pickProvider('bogus')).toBe('gemini');
  });
});

describe('per-provider config gating', () => {
  test('each provider is configured only when ITS key is set', () => {
    const v1 = load();
    expect(v1.visionConfigured('anthropic')).toBe(false);
    expect(v1.visionConfigured('gemini')).toBe(false);

    jest.resetModules();
    process.env.GEMINI_API_KEY = 'g-key';
    const v2 = load();
    expect(v2.visionConfigured('gemini')).toBe(true);
    expect(v2.visionConfigured('anthropic')).toBe(false); // anthropic still unset

    jest.resetModules();
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'g-key-2'; // GOOGLE_API_KEY also works
    expect(load().visionConfigured('gemini')).toBe(true);
  });

  test('visionModel reports the configured model per provider', () => {
    const v = load();
    expect(v.visionModel('anthropic')).toBe('claude-opus-test');
    expect(v.visionModel('gemini')).toBe('gemini-test-pro');
    expect(v.visionModel('bogus')).toBeNull();
  });
});

describe('gemini transport shaping', () => {
  test('builds an inline-image + JSON-mode request and reads candidate text', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    const v = load();
    mockPost.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: '{"counts":[]}' }] } }] } });

    const out = await v.geminiGenerateVision({
      system: 'SYS', prompt: 'DO IT',
      image: { base64: 'aGVsbG8=', mediaType: 'image/png' },
    });

    expect(out).toBe('{"counts":[]}');
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toContain('gemini-test-pro:generateContent');
    expect(url).toContain('key=g-key');
    expect(body.system_instruction.parts[0].text).toBe('SYS');
    expect(body.contents[0].parts[0].inline_data).toEqual({ mime_type: 'image/png', data: 'aGVsbG8=' });
    expect(body.contents[0].parts[1].text).toBe('DO IT');
    expect(body.generationConfig.responseMimeType).toBe('application/json'); // JSON mode
  });

  test('dispatch routes to the gemini transport for provider gemini', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    const v = load();
    mockPost.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } });
    const out = await v.visionGenerate({ provider: 'gemini', system: 's', prompt: 'p', image: { base64: 'x' } });
    expect(out).toBe('ok');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('dispatch throws on an unknown provider rather than silently no-op', async () => {
    const v = load();
    await expect(v.visionGenerate({ provider: 'nope', image: { base64: 'x' } })).rejects.toThrow(/unknown vision provider/);
  });
});
