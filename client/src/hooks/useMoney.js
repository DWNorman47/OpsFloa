import { useCallback } from 'react';
import { useCurrency } from '../contexts/SettingsContext';
import { formatMoney } from '../utils/format';

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
