// Shared formatters for money + dates so every page renders the same
// way. Before this util, the new admin pages each had their own
// `formatCents` / `formatDate` definitions and they all diverged
// slightly — some showed $0, some $0.00, some dropped seconds, some
// kept them, etc. One place to change them now.

import { localeForCurrency } from '../utils';

const DEFAULT_LOCALE = 'en-US';
const DEFAULT_CURRENCY = 'USD';

// Format an amount in CENTS (integer) as currency. By default returns
// "$X" with no fractional digits — the right call for big-dollar
// project totals on a portfolio table. Pass { showCents: true } for
// line-item displays where the decimals matter.
//
// `locale` defaults to the one that renders `currency`'s LOCAL symbol, because
// Intl reads the symbol off the locale rather than the currency code — pinning
// en-US would print "HNL 1,234.50" where the rest of the app shows "L 1,234.50".
// Callers should pass the company currency (see the useCents hook); it is not
// read from a global, so a caller that forgets it still gets USD.
export function formatMoney(cents, opts = {}) {
  const { showCents = false, currency = DEFAULT_CURRENCY, locale = localeForCurrency(currency) } = opts;
  const n = (parseInt(cents, 10) || 0) / 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  }).format(n);
}

// Dollar amount → cents integer. Accepts "15", "15.5", "$15.50", " 15 ".
// Returns null when the input can't be parsed.
export function parseDollars(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

// Cents → dollar string for editing. Avoids the "1500" → "15.00"
// dance on every form. Empty cents → empty string so the input
// renders blank, not "0.00".
export function centsToDollarsField(cents) {
  if (cents == null || cents === '') return '';
  const n = parseInt(cents, 10);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '';  // start blank so user sees placeholder
  return (n / 100).toFixed(2);
}

// "Mar 5, 2026" — short date for tables.
export function formatDate(value, opts = {}) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(opts.locale || DEFAULT_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// "Mar 5, 2026 · 2:30 PM" — for activity rows / timestamps.
export function formatDateTime(value, opts = {}) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(opts.locale || DEFAULT_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// "2:30 PM" — used inside slot pickers and shift grids.
export function formatTime(value, opts = {}) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(opts.locale || DEFAULT_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
  });
}
