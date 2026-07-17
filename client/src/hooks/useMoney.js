import { useCallback } from 'react';
import { useCurrency } from '../contexts/SettingsContext';
import { formatMoney } from '../utils/format';
import { formatCurrency } from '../utils';

/**
 * formatCurrency bound to the company's currency. Takes DOLLARS (a number) —
 * the counterpart to useCents(), which takes cents. Replaces the hand-rolled
 * `` `$${v.toFixed(2)}` `` helpers that several components defined at module
 * scope, which could never honour a non-USD company.
 *
 * Amounts additionally pick up thousands separators ($1,234.50 rather than
 * $1234.50), matching how the rest of the app already renders money.
 */
export function useMoney() {
  const currency = useCurrency();
  return useCallback(v => formatCurrency(Number(v) || 0, currency), [currency]);
}

/**
 * formatMoney bound to the company's configured currency.
 *
 * Why this exists: `formatMoney` takes a `currency` option that defaults to
 * 'USD', and for a long time no caller passed one — so a company set to, say,
 * HNL saw dollar signs on every page that used it. Binding the currency here
 * means pages can't forget it.
 *
 * A module-level "current currency" global would be simpler but wrong: settings
 * load asynchronously, and mutating a module variable doesn't re-render a page
 * that already painted, so early renders would keep their dollar signs. Reading
 * through context makes the amounts update when settings arrive.
 *
 * Takes CENTS (integer), like formatMoney. `showCents` defaults to true, which
 * is what line-item displays want; pass { showCents: false } for rounded totals.
 *
 * Not usable from @react-pdf documents — they mount outside the provider tree
 * via pdf(createElement(...)), so those take `currency` as a prop instead.
 */
export function useCents({ showCents = true } = {}) {
  const currency = useCurrency();
  return useCallback(cents => formatMoney(cents, { showCents, currency }), [currency, showCents]);
}
