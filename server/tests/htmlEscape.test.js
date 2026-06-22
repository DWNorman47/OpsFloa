const { escapeHtml } = require('../utils/htmlEscape');

describe('escapeHtml', () => {
  test('escapes the 5 HTML-significant chars', () => {
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
  test('& goes first to avoid double-encoding', () => {
    expect(escapeHtml('Tom & Jerry < Bob')).toBe('Tom &amp; Jerry &lt; Bob');
  });
  test("' becomes &#39; (HTML attribute safe)", () => {
    expect(escapeHtml("O'Brien")).toBe('O&#39;Brien');
  });
  test('returns empty string on null / undefined (defensive)', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  test('coerces non-strings via String()', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(true)).toBe('true');
  });
  test('plain text passes through unchanged', () => {
    expect(escapeHtml('Hi Jane, your booking is confirmed.')).toBe('Hi Jane, your booking is confirmed.');
  });
});
