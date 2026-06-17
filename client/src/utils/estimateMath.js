// Client-side mirror of server/constants/projectMoneyEnums.js
// `computeEstimateTotals`. Used by the estimate / change-order PDF
// renderers so the printed breakdown matches the server-stored totals
// to the cent. Keep the cascade IN LOCKSTEP with the server function —
// the order of operations (overhead → margin → contingency → tax, each
// compounding on the running base) is the legally-meaningful part.
//
// All inputs and outputs are in integer CENTS / percent floats.

export function computeBreakdown({
  subtotalCents = 0,
  overheadPct = 0,
  marginPct = 0,
  contingencyPct = 0,
  taxPct = 0,
}) {
  const subtotal = Math.max(0, Math.round(parseInt(subtotalCents, 10) || 0));
  const oh = parseFloat(overheadPct) || 0;
  const mg = parseFloat(marginPct) || 0;
  const ct = parseFloat(contingencyPct) || 0;
  const tx = parseFloat(taxPct) || 0;

  const overhead    = Math.round(subtotal * (oh / 100));
  const marginBase  = subtotal + overhead;
  const margin      = Math.round(marginBase * (mg / 100));
  const preCont     = marginBase + margin;
  const contingency = Math.round(preCont * (ct / 100));
  const preTax      = preCont + contingency;
  const tax         = Math.round(preTax * (tx / 100));
  const total       = preTax + tax;

  return { subtotal, overhead, margin, contingency, tax, total };
}
