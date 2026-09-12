const privatePathPatterns = [
  [/^\/(e|i|co)\/[^/]+\/?$/, '/$1/[token]'],
  [/^\/lien-waiver-sign\/[^/]+\/?$/, '/lien-waiver-sign/[token]'],
  [/^\/book\/manage\/[^/]+\/?$/, '/book/manage/[token]'],
  [/^\/(r|companies)\/[^/]+\/?$/, '/$1/[slug]'],
  [/^\/book\/[^/]+\/[^/]+\/?$/, '/book/[company]/[type]'],
  [/^\/book\/[^/]+\/?$/, '/book/[company]'],
];

export function redactAnalyticsEvent(event) {
  const url = new URL(event.url);
  const match = privatePathPatterns.find(([pattern]) => pattern.test(url.pathname));
  if (match) url.pathname = url.pathname.replace(...match);
  url.search = '';
  url.hash = '';
  return { ...event, url: url.toString() };
}
