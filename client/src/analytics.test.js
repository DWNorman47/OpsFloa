import { describe, expect, it } from 'vitest';
import { redactAnalyticsEvent } from './analytics';

describe('redactAnalyticsEvent', () => {
  it.each([
    ['/e/secret', '/e/[token]'],
    ['/i/secret', '/i/[token]'],
    ['/co/secret', '/co/[token]'],
    ['/lien-waiver-sign/secret', '/lien-waiver-sign/[token]'],
    ['/book/manage/secret', '/book/manage/[token]'],
    ['/r/customer-name', '/r/[slug]'],
    ['/companies/customer-name', '/companies/[slug]'],
    ['/book/customer-name/service-name', '/book/[company]/[type]'],
    ['/book/customer-name', '/book/[company]'],
    ['/work', '/work'],
  ])('normalizes %s to %s', (path, expected) => {
    const event = { type: 'pageview', url: `https://opsfloa.com${path}?code=secret#details` };
    const result = redactAnalyticsEvent(event);
    expect(new URL(result.url).pathname).toBe(expected);
    expect(new URL(result.url).search).toBe('');
    expect(new URL(result.url).hash).toBe('');
    expect(result.type).toBe('pageview');
  });
});
