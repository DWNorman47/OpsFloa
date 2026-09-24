// The public web-app origin used to build links in emails / redirects
// (`${getAppUrl()}/reset-password?token=…`). One place so every link agrees:
//   - production: APP_URL MUST be set — this module throws at load (i.e. at boot,
//     since the auth routes require it) rather than mail out "undefined/reset-…"
//     links or silently point customers at the wrong host;
//   - elsewhere (dev / test): falls back to DEV_FALLBACK, the same host every
//     other fallback in the codebase used (not the stray app.opsfloa.com).
// Trailing slashes are trimmed so callers can always append "/path".

const DEV_FALLBACK = 'https://opsfloa.com';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getAppUrl() {
  const raw = (process.env.APP_URL || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  if (isProduction()) {
    throw new Error('APP_URL is not set — refusing to build app links in production');
  }
  return DEV_FALLBACK;
}

// Boot check: loud failure in production when unset.
if (isProduction() && !(process.env.APP_URL || '').trim()) {
  throw new Error('APP_URL environment variable is required in production (used for every emailed link).');
}

module.exports = { getAppUrl, DEV_FALLBACK };
