// Verifies the redactTokenInUrl helper used by the pino-http serializer
// (index.js → utils/redactUrl.js). The test doubles as documentation for the
// security invariant: no replayable credential reaches the log stream.
const { redactTokenInUrl } = require('../utils/redactUrl');

describe('redactTokenInUrl', () => {
  test.each([
    ['/api/public/book/manage/abc123xyz', '/api/public/book/manage/[redacted]'],
    ['/api/public/estimates/view/secret-token', '/api/public/estimates/view/[redacted]'],
    ['/api/public/estimates/accept/secret-token', '/api/public/estimates/accept/[redacted]'],
    ['/api/public/estimates/decline/secret-token', '/api/public/estimates/decline/[redacted]'],
    ['/api/public/change-orders/view/co-token', '/api/public/change-orders/view/[redacted]'],
    ['/api/public/change-orders/accept/co-token', '/api/public/change-orders/accept/[redacted]'],
    ['/api/public/lien-waivers/sign/lw-token', '/api/public/lien-waivers/sign/[redacted]'],
    ['/e/raw-estimate-token', '/e/[redacted]'],
    ['/co/raw-co-token', '/co/[redacted]'],
    ['/lien-waiver-sign/raw-waiver-token', '/lien-waiver-sign/[redacted]'],
    ['/book/manage/raw-mgmt-token', '/book/manage/[redacted]'],
  ])('redacts %s', (input, expected) => {
    expect(redactTokenInUrl(input)).toBe(expected);
  });

  test('preserves query string parameters (which don\'t carry tokens in our routes)', () => {
    // No query strings carry tokens today; the redaction only touches the
    // path-segment match.
    const result = redactTokenInUrl('/api/public/estimates/view/secret?utm=email');
    expect(result).toContain('[redacted]');
    expect(result).toContain('utm=email');
  });

  test.each([
    '/api/admin/projects/42',          // numeric path param, not a token
    '/api/admin/workers/123/archive',  // structured path
    '/timeclock#schedule',              // hash route
    '/projects',                         // module index
    '/',                                  // root
    '',                                   // empty
  ])('leaves non-token URL %s alone', (input) => {
    expect(redactTokenInUrl(input)).toBe(input);
  });

  test.each([
    ['/api/live/12/stream?ticket=abc.def', '/api/live/12/stream?ticket=[redacted]'],
    ['/api/live/12/stream?token=eyJhbGciOi.x.y&client=c1', '/api/live/12/stream?token=[redacted]&client=c1'],
    ['/api/live/12/stream?client=c1&ticket=t1', '/api/live/12/stream?client=c1&ticket=[redacted]'],
    ['/api/anything?access_token=zzz#frag', '/api/anything?access_token=[redacted]#frag'],
    ['/api/x?TOKEN=Upper', '/api/x?TOKEN=[redacted]'],
    ['/api/public/estimates/view/secret?token=again', '/api/public/estimates/view/[redacted]?token=[redacted]'],
  ])('redacts credential query params on any path: %s', (input, expected) => {
    expect(redactTokenInUrl(input)).toBe(expected);
  });

  test('does not touch params that merely contain the word', () => {
    expect(redactTokenInUrl('/api/x?tokens_used=5&ticketing=on')).toBe('/api/x?tokens_used=5&ticketing=on');
  });

  test('returns falsy input untouched', () => {
    expect(redactTokenInUrl(undefined)).toBeUndefined();
    expect(redactTokenInUrl(null)).toBeNull();
  });
});
