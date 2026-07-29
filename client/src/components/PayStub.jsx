import React from 'react';
import { useT } from '../hooks/useT';
import { formatCurrency, fmtHours } from '../utils';

/**
 * One pay stub, rendered from a "check" (a row of the payroll run / the worker's
 * pay-stubs endpoint): pay date, period, earnings breakdown, itemized deductions
 * (figured on the group's combined gross minus the exempt), and net. Reused by the
 * admin register (expand a row) and the worker's self-service stub. `onPrint` opens
 * a clean print window built from the same numbers.
 */
export default function PayStub({ check, currency = 'USD', workerName }) {
  const t = useT();
  const money = v => formatCurrency(v || 0, currency);
  const h = check.hours || {};
  const c = check.cost || {};

  const earnings = [
    h.regular > 0 && { label: t.regularLabel, hrs: h.regular, amt: c.regular },
    h.overtime > 0 && { label: t.overtimeLabel, hrs: h.overtime, amt: c.overtime },
    h.prevailing > 0 && { label: t.prevailingLabel, hrs: h.prevailing, amt: c.prevailing },
    h.night > 0 && { label: t.nightDiffLabel, hrs: h.night, amt: c.night },
    h.sick > 0 && { label: t.pdfSickHours || 'Sick', hrs: h.sick, amt: c.sick },
    h.vacation > 0 && { label: t.pdfVacationHours || 'Vacation', hrs: h.vacation, amt: c.vacation },
    (c.guarantee || 0) > 0 && { label: t.stubGuarantee, hrs: null, amt: c.guarantee },
  ].filter(Boolean);
  const lines = check.deduction_lines || [];
  const combinedNote = check.deducts && check.combined_gross != null && Math.abs((check.combined_gross || 0) - (check.gross || 0)) > 0.005;

  return (
    <div style={s.stub}>
      <div style={s.head}>
        <div>
          <div style={s.who}>{workerName || check.worker_name}{check.role_name ? <span style={s.muted}> · {check.role_name}</span> : ''}</div>
          <div style={s.metaLine}>{t.pcrRunRuleset}: {check.ruleset_name || <span style={s.muted}>{t.pcrRunNoRule}</span>}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={s.metaLine}><strong>{t.pcrRunPayDate}:</strong> {check.pay_date}</div>
          <div style={s.metaLine}><strong>{t.pcrRunPeriod}:</strong> {check.period_start} – {check.period_end}</div>
        </div>
      </div>

      <div style={s.sec}>{t.stubEarnings}</div>
      {earnings.map((e, i) => (
        <div key={i} style={s.line}>
          <span>{e.label}{e.hrs != null ? <span style={s.muted}> · {fmtHours(e.hrs)}</span> : ''}</span>
          <span>{money(e.amt)}</span>
        </div>
      ))}
      <div style={{ ...s.line, ...s.subtotal }}><span>{t.stubGross}</span><span>{money(check.gross)}</span></div>

      <div style={s.sec}>{t.stubDeductions}</div>
      {combinedNote && (
        <div style={s.note}>
          {(t.stubCombinedNote || 'Figured on the group total {combined} − {exempt} exempt')
            .replace('{combined}', money(check.combined_gross)).replace('{exempt}', money(check.exempt))}
        </div>
      )}
      {lines.length === 0
        ? <div style={s.line}><span style={s.muted}>{t.stubNoDeductions}</span><span>—</span></div>
        : lines.map((l, i) => (
            <div key={i} style={s.line}><span>{l.name}</span><span style={s.neg}>−{money(l.amount)}</span></div>
          ))}
      <div style={{ ...s.line, ...s.subtotal }}><span>{t.stubDeductionTotal}</span><span style={s.neg}>{check.deduction_total > 0 ? `−${money(check.deduction_total)}` : '—'}</span></div>

      <div style={{ ...s.line, ...s.netLine }}><span>{t.stubNet}</span><span>{money(check.net)}</span></div>

      <button type="button" style={s.printBtn} onClick={() => printStub(check, workerName || check.worker_name, currency, t)}>{t.stubPrint}</button>
    </div>
  );
}

// A standalone print window with the same figures.
export function printStub(check, workerName, currency, t) {
  const money = v => formatCurrency(v || 0, currency);
  const h = check.hours || {}, c = check.cost || {};
  const earn = [];
  const add = (label, hrs, amt) => { if ((amt || 0) !== 0 || (hrs || 0) !== 0) earn.push(`<tr><td>${label}${hrs != null ? ` · ${fmtHours(hrs)}` : ''}</td><td class="r">${money(amt)}</td></tr>`); };
  add(t.regularLabel, h.regular, c.regular);
  add(t.overtimeLabel, h.overtime, c.overtime);
  add(t.prevailingLabel, h.prevailing, c.prevailing);
  add(t.nightDiffLabel, h.night, c.night);
  add(t.pdfSickHours || 'Sick', h.sick, c.sick);
  add(t.pdfVacationHours || 'Vacation', h.vacation, c.vacation);
  add(t.stubGuarantee, null, c.guarantee); // guarantee top-up — omitting it made printed earnings not foot to gross
  const dedRows = (check.deduction_lines || []).map(l => `<tr><td>${l.name}</td><td class="r neg">−${money(l.amount)}</td></tr>`).join('') || `<tr><td colspan="2" class="muted">${t.stubNoDeductions}</td></tr>`;
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t.stubTitle} — ${workerName} — ${check.pay_date}</title>
    <style>body{font-family:system-ui,sans-serif;margin:32px;color:#111;font-size:13px;max-width:560px}
    h1{font-size:18px;margin:0 0 2px}.meta{color:#555;margin:2px 0 18px}
    table{width:100%;border-collapse:collapse;margin-bottom:14px}td{padding:5px 2px;border-bottom:1px solid #eee}
    .r{text-align:right}.neg{color:#b91c1c}.muted{color:#9ca3af}.sec{font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.5px;color:#6b7280;margin:16px 0 4px}
    .tot td{font-weight:700;border-bottom:2px solid #111}.net{font-size:16px;font-weight:800;display:flex;justify-content:space-between;margin-top:12px}</style>
    </head><body>
    <h1>${t.stubTitle}</h1>
    <div class="meta">${workerName}${check.role_name ? ` · ${check.role_name}` : ''}<br>${t.pcrRunPayDate}: <b>${check.pay_date}</b> · ${t.pcrRunPeriod}: ${check.period_start} – ${check.period_end}</div>
    <div class="sec">${t.stubEarnings}</div>
    <table>${earn.join('')}<tr class="tot"><td>${t.stubGross}</td><td class="r">${money(check.gross)}</td></tr></table>
    <div class="sec">${t.stubDeductions}</div>
    <table>${dedRows}<tr class="tot"><td>${t.stubDeductionTotal}</td><td class="r neg">${check.deduction_total > 0 ? `−${money(check.deduction_total)}` : '—'}</td></tr></table>
    <div class="net"><span>${t.stubNet}</span><span>${money(check.net)}</span></div>
    </body></html>`);
  win.document.close();
  win.print();
}

const s = {
  stub: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 18, maxWidth: 480 },
  head: { display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 8 },
  who: { fontSize: 15, fontWeight: 700, color: '#111827' },
  metaLine: { fontSize: 12.5, color: '#374151', marginTop: 2 },
  muted: { color: '#9ca3af', fontWeight: 400 },
  sec: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#9ca3af', margin: '14px 0 4px' },
  line: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151', padding: '4px 0', borderBottom: '1px solid #f3f4f6' },
  subtotal: { fontWeight: 700, color: '#111827', borderBottom: '2px solid #e5e7eb' },
  neg: { color: '#b91c1c' },
  note: { fontSize: 12, color: '#6b7280', margin: '2px 0 6px', fontStyle: 'italic' },
  netLine: { fontSize: 16, fontWeight: 800, color: '#065f46', borderBottom: 'none', paddingTop: 10 },
  printBtn: { marginTop: 14, background: '#1f2937', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
};
