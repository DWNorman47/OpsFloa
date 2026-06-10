// Verifies the redactTokenInUrl helper used by the pino-http serializer.
// The function isn't exported from server/index.js; we re-create the
// regex set here and assert their behavior. This is the kind of test
// where the test itself doubles as documentation for the security
// invariant.

const TOKENIZED_URL_PATTERNS = [
  /^(\/api)?\/public\/book\/manage\/([^/?]+)/,
  /^(\/api)?\/public\/estimates\/(view|accept|decline)\/([^/?]+)/,
  /^(\/api)?\/public\/change-orders\/(view|accept|decline)\/([^/?]+)/,
  /^(\/api)?\/public\/lien-waivers\/sign\/([^/?]+)/,
  /^\/e\/([^/?]+)/,
  /^\/co\/([^/?]+)/,
  /^\/lien-waiver-sign\/([^/?]+)/,
  /^\/book\/manage\/([^/?]+)/,
];

function redactTokenInUrl(url) {
  if (!url) return url;
  for (const re of TOKENIZED_URL_PATTERNS) {
    const m = url.match(re);
    if (m) {
      const tokenIndex = m.length - 1;
      return url.replace(m[tokenIndex], '[redacted]');
    }
  }
  return url;
}

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

  test('returns falsy input untouched', () => {
    expect(redactTokenInUrl(undefined)).toBeUndefined();
    expect(redactTokenInUrl(null)).toBeNull();
  });
});
