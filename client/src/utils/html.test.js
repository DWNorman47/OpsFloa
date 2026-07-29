import { describe, expect, test } from 'vitest';
import { escapeHtml } from './html';

describe('escapeHtml', () => {
  test('escapes text and attribute metacharacters used by print windows', () => {
    expect(escapeHtml(`<script data-x="1">alert('x') & go</script>`))
      .toBe('&lt;script data-x=&quot;1&quot;&gt;alert(&#39;x&#39;) &amp; go&lt;/script&gt;');
  });

  test('handles nullish values without leaking literal null', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
