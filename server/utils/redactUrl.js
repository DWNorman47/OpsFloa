// URL redaction for the pino-http request serializer (index.js). Anyone with
// log access could otherwise replay a logged credential.

// Path patterns that end in a tokenized last segment. Conservative — only the
// patterns we know carry tokens get scrubbed, so e.g. `/admin/workers/42`
// keeps the id.
const TOKENIZED_URL_PATTERNS = [
  /^(\/api)?\/public\/book\/manage\/([^/?]+)/,
  /^(\/api)?\/public\/estimates\/(view|accept|decline)\/([^/?]+)/,
  /^(\/api)?\/public\/invoices\/view\/([^/?]+)/,
  /^(\/api)?\/public\/change-orders\/(view|accept|decline)\/([^/?]+)/,
  /^(\/api)?\/public\/lien-waivers\/sign\/([^/?]+)/,
  /^\/e\/([^/?]+)/,
  /^\/i\/([^/?]+)/,
  /^\/co\/([^/?]+)/,
  /^\/lien-waiver-sign\/([^/?]+)/,
  /^\/book\/manage\/([^/?]+)/,
];

// Credential-bearing query parameters, on ANY path: `ticket` (live-session SSE
// stream tickets), `token` (legacy ?token=<JWT> on the stream, EventSource
// can't send headers) and any `*_token` (access_token, refresh_token, ...).
const TOKEN_QUERY_PARAM = /([?&](?:[a-z0-9_-]*_token|token|ticket)=)[^&#]*/gi;

function redactTokenInUrl(url) {
  if (!url) return url;
  let out = url;
  for (const re of TOKENIZED_URL_PATTERNS) {
    const m = out.match(re);
    if (m) {
      // Replace the last capture group (the token) with [redacted].
      const tokenIndex = m.length - 1;
      out = out.replace(m[tokenIndex], '[redacted]');
      break;
    }
  }
  return out.replace(TOKEN_QUERY_PARAM, '$1[redacted]');
}

module.exports = { redactTokenInUrl, TOKENIZED_URL_PATTERNS };
