// Server-side money formatting.
//
// The client has the same logic in client/src/utils.js (formatCurrency /
// localeForCurrency). The two bundles can't share a module, so this is a
// deliberate mirror — keep CURRENCY_LOCALES in sync with the client's copy and
// with the ManageRates dropdown that decides which codes a company can pick.
//
// Anything the server renders for a human (report emails, PO emails) must go
// through here rather than hardcoding 'en-US' + 'USD', or a company set to a
// non-USD currency gets dollar amounts in its email while the app shows the
// right ones.

const pool = require('./db');

// ISO 4217 code → a locale that renders that currency's LOCAL symbol. The
// symbol comes from the LOCALE, not the currency code: en-US + HNL yields
// "HNL 1,234.50", while es-HN + HNL yields "L 1,234.50".
const CURRENCY_LOCALES = {
  USD: 'en-US', CAD: 'en-CA', EUR: 'de-DE', GBP: 'en-GB',
  MXN: 'es-MX', HNL: 'es-HN', GTQ: 'es-GT', NIO: 'es-NI',
  BZD: 'en-BZ', CRC: 'es-CR', PAB: 'es-PA',
};

const DEFAULT_CURRENCY = 'USD'; // mirrors settingsDefaults.js

function localeForCurrency(currency = DEFAULT_CURRENCY) {
  return CURRENCY_LOCALES[currency] || 'en-US';
}

/**
 * Format `amount` (a number, in major units) in the given ISO 4217 currency.
 * Falls back to a plain fixed-decimal string if Intl rejects the code, so a bad
 * setting can never throw inside a cron job or an email send.
 */
function formatCurrency(amount, currency = DEFAULT_CURRENCY) {
  const n = parseFloat(amount || 0);
  try {
    return new Intl.NumberFormat(localeForCurrency(currency), {
      style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/**
 * The company's configured currency code, or 'USD' when unset. Reads the same
 * settings row the client gets from GET /api/settings.
 */
async function companyCurrency(companyId) {
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE company_id = $1 AND key = 'currency'`,
      [companyId]
    );
    return r.rows[0]?.value || DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY; // never let a settings read break an email
  }
}

module.exports = { formatCurrency, localeForCurrency, companyCurrency, CURRENCY_LOCALES, DEFAULT_CURRENCY };
