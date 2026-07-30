/**
 * Returns today's date as "YYYY-MM-DD" in the user's LOCAL timezone.
 * Use this instead of new Date().toISOString().substring(0,10) which gives UTC date.
 */
export function localDateStr(d = new Date()) {
  return d.toLocaleDateString('en-CA'); // en-CA produces YYYY-MM-DD
}

/**
 * Preserve a database DATE as a calendar date instead of treating a serialized
 * UTC midnight as an instant that can move to the previous local day.
 */
export function dateOnlyStr(value) {
  if (value == null || value === '') return '';
  return String(value).substring(0, 10);
}

export function formatDateOnly(value, locale = 'en-US', opts) {
  const raw = dateOnlyStr(value);
  if (!raw) return '';
  const date = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(locale, opts);
}

// Maps ISO 4217 currency codes to a locale that produces the correct local symbol
const CURRENCY_LOCALES = {
  USD: 'en-US', CAD: 'en-CA', EUR: 'de-DE', GBP: 'en-GB',
  MXN: 'es-MX', HNL: 'es-HN', GTQ: 'es-GT', NIO: 'es-NI',
  BZD: 'en-BZ', CRC: 'es-CR', PAB: 'es-PA',
};

/**
 * The locale that renders a currency's LOCAL symbol. Intl takes the symbol from
 * the locale, not the currency code: en-US + HNL gives "HNL 1,234.50", while
 * es-HN + HNL gives "L 1,234.50". Any money formatter must pair the two.
 */
export function localeForCurrency(currency = 'USD') {
  return CURRENCY_LOCALES[currency] ?? 'en-US';
}

/**
 * Format a monetary amount using the given ISO 4217 currency code.
 * Uses a locale that produces the local symbol (e.g. "L" for HNL, "Q" for GTQ).
 */
export function formatCurrency(amount, currency = 'USD') {
  const locale = localeForCurrency(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `$${Number(amount).toFixed(2)}`;
  }
}

/**
 * Returns just the currency symbol for the given ISO 4217 code (e.g. "$", "L", "€").
 */
export function currencySymbol(currency = 'USD') {
  const locale = localeForCurrency(currency);
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0);
    return parts.find(p => p.type === 'currency')?.value ?? currency;
  } catch {
    return '$';
  }
}

/**
 * Format a UTC ISO timestamp in a given IANA timezone (falls back to browser locale).
 * opts: Intl.DateTimeFormat options (default: time only, 12-hour)
 */
export function formatInTz(isoStr, tz, opts = { hour: 'numeric', minute: '2-digit' }, locale = 'en-US') {
  try {
    return new Date(isoStr).toLocaleString(locale, { ...opts, ...(tz ? { timeZone: tz } : {}) });
  } catch {
    return new Date(isoStr).toLocaleString(locale, opts);
  }
}

/**
 * Maps OpsFloa language name to a BCP 47 locale string for Intl APIs.
 * Use this instead of hard-coding 'en-US' so Spanish users see localised dates.
 */
export function langToLocale(language) {
  return language === 'Spanish' ? 'es-MX' : 'en-US';
}

/**
 * Locale-aware date/time formatting driven by the OpsFloa language name.
 * Use these instead of a bare `.toLocaleDateString()` (which follows the
 * browser, not the user's chosen app language) so Spanish users see Spanish
 * dates. `value` may be a Date, an ISO string, or null/undefined (returns '').
 */
export function formatDate(value, language, opts) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(langToLocale(language), opts);
}

export function formatDateTime(value, language, opts) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(langToLocale(language), opts);
}

/**
 * Format decimal hours as "Xh Ym" (e.g. 1.5 → "1h 30m", 0.25 → "15m", 8 → "8h")
 */
export function fmtHours(h) {
  const totalMin = Math.round((h || 0) * 60);
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hrs === 0) return `${min}m`;
  if (min === 0) return `${hrs}h`;
  return `${hrs}h ${min}m`;
}
