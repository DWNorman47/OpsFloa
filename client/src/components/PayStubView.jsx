import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import { useMoney } from '../hooks/useMoney';

import { silentError } from '../errorReporter';
function fmtDate(str, locale = 'en-US') {
  const d = new Date(String(str).substring(0, 10) + 'T00:00:00');
  return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateShort(str, locale = 'en-US') {
  const d = new Date(String(str).substring(0, 10) + 'T00:00:00');
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(t) {
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`;
}

function fmtH(h) {
  const wh = Math.floor(h);
  const wm = Math.round((h - wh) * 60);
  return wm > 0 ? `${wh}h ${wm}m` : `${wh}h`;
}

function netHours(start, end, brk) {
  let ms = new Date(`1970-01-01T${end}`) - new Date(`1970-01-01T${start}`);
  if (ms < 0) ms += 86400000;
  return Math.max(0, ms / 3600000 - (brk || 0) / 60);
}

function InvoiceCard({ stub, user, settings, companyInfo, defaultOpen, t }) {
  const fmtMoney = useMoney();
  const locale = langToLocale(user?.language);
  const [open, setOpen] = useState(defaultOpen);

  const label = stub.label || `${fmtDateShort(stub.period_start, locale)} – ${fmtDateShort(stub.period_end, locale)}`;
  // All money is priced by the shared server engine now (was recomputed here from
  // a simplified formula that ignored per-project prevailing, OT tiers, night
  // premium, leave and deductions — so a tiered-OT company saw a different number
  // on the stub than on the invoice).
  const {
    regular_hours, overtime_hours, prevailing_hours, total_mileage,
    guarantee_shortfall_hours = 0, guarantee_min_hours = 0,
    sick_hours = 0, vacation_hours = 0,
    regular_cost = 0, overtime_cost = 0, prevailing_cost = 0, guarantee_cost = 0,
    sick_cost = 0, vacation_cost = 0, gross_wages = 0,
    deductions = [], net_pay = 0,
    rate: workerRate = 0, overtime_multiplier: otMult = 1.5,
    prevailing_wage_rate: prevRate = 0, sick_rate = 0, vacation_rate = 0,
  } = stub.summary;
  const totalHours = regular_hours + overtime_hours + prevailing_hours;
  const overtimeEnabled = settings?.feature_overtime !== false;
  const hasDeductions = Array.isArray(deductions) && deductions.length > 0;
  const showPay = gross_wages > 0;
  const billedHours = totalHours + guarantee_shortfall_hours + sick_hours + vacation_hours;

  const ci = companyInfo || {};
  const billToLines = [
    ci.name || user?.company_name || '',
    ci.address || '',
    ci.phone || '',
    ci.contact_email || '',
  ].filter(Boolean);

  return (
    <div style={s.card}>
      {/* Collapsible header */}
      <button style={s.cardHeader} onClick={() => setOpen(o => !o)}>
        <div style={s.cardHeaderLeft}>
          <span style={s.cardLabel}>{label}</span>
          <div style={s.chips}>
            <span style={s.chip}>{fmtH(billedHours)} {t.totalChip}</span>
            {prevailing_hours > 0 && <span style={{ ...s.chip, background: '#fef3c7', color: '#b45309' }}>{fmtH(prevailing_hours)} {t.prevailingLabel}</span>}
            {total_mileage > 0 && <span style={s.chip}>{total_mileage} {t.miChip}</span>}
            {showPay && <span style={{ ...s.chip, background: '#d1fae5', color: '#065f46' }}>{fmtMoney(gross_wages)}</span>}
          </div>
        </div>
        <span style={s.chevron}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={s.cardBody}>
          {/* Invoice header */}
          <div style={s.invHeader}>
            <div>
              {ci?.name && <div style={s.brand}>{ci.name}</div>}
              <div style={s.brandSub}>{t.employeeTimeInvoice}</div>
            </div>
            <div style={s.invRight}>
              <div style={s.invTitle}>{t.invoiceLabel}</div>
              <div style={s.invMeta}>
                <span style={s.metaLabel}>{t.payPeriod}</span>
                <span style={s.metaVal}>{label}</span>
              </div>
            </div>
          </div>

          {/* From / Bill To */}
          <div style={s.parties}>
            <div>
              <div style={s.partyLabel}>{t.from}</div>
              <div style={s.partyName}>{user?.invoice_name || user?.full_name || '—'}</div>
              {user?.email && <div style={s.partyDetail}>{user.email}</div>}
            </div>
            <div>
              <div style={s.partyLabel}>{t.billTo}</div>
              {billToLines.map((line, i) => (
                <div key={i} style={i === 0 ? s.partyName : s.partyDetail}>{line}</div>
              ))}
              {billToLines.length === 0 && <div style={s.partyDetail}>—</div>}
            </div>
          </div>

          {/* Entry table */}
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>{t.date}</th>
                  <th style={s.th}>{t.project}</th>
                  <th style={s.th}>{t.descriptionLabel}</th>
                  <th style={s.th}>{t.clockIn}</th>
                  <th style={s.th}>{t.clockOut}</th>
                  <th style={s.th}>{t.rateTypeLabel}</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>{t.hours}</th>
                </tr>
              </thead>
              <tbody>
                {stub.entries.map(e => {
                  const h = netHours(e.start_time, e.end_time, e.break_minutes);
                  const isPrev = e.wage_type === 'prevailing';
                  return (
                    <tr key={e.id} style={s.tr}>
                      <td style={s.td}>{fmtDate(e.work_date_str || e.work_date, locale)}</td>
                      <td style={s.td}>{e.project_name || '—'}</td>
                      <td style={{ ...s.td, color: '#6b7280' }}>{e.notes || ''}</td>
                      <td style={s.td}>
                        {e.raw_start_time && e.raw_start_time !== e.start_time && (
                          <span style={s.rawTime}>{fmtTime(e.raw_start_time)}</span>
                        )}
                        {fmtTime(e.start_time)}
                      </td>
                      <td style={s.td}>
                        {e.raw_end_time && e.raw_end_time !== e.end_time && (
                          <span style={s.rawTime}>{fmtTime(e.raw_end_time)}</span>
                        )}
                        {fmtTime(e.end_time)}
                      </td>
                      <td style={s.td}>
                        <span style={{ ...s.badge, background: isPrev ? '#d97706' : '#2563eb' }}>
                          {isPrev ? t.prevailing : t.regular}
                        </span>
                      </td>
                      <td style={{ ...s.td, textAlign: 'right', fontWeight: 600 }}>{fmtH(h)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Summary */}
          <div style={s.summaryWrap}>
            <div style={s.thankYou}>{t.thankYouInvoice}</div>
            <div style={s.sumTable}>
              {regular_hours > 0 && (
                <div style={s.sumRow}>
                  <span>{t.regularHours}</span>
                  <span>{fmtH(regular_hours)}</span>
                </div>
              )}
              {overtimeEnabled && overtime_hours > 0 && (
                <div style={s.sumRow}>
                  <span>{t.overtimeHours}</span>
                  <span>{fmtH(overtime_hours)}</span>
                </div>
              )}
              {prevailing_hours > 0 && (
                <div style={s.sumRow}>
                  <span>{t.prevailingHours}</span>
                  <span>{fmtH(prevailing_hours)}</span>
                </div>
              )}
              {guarantee_shortfall_hours > 0 && (
                <div style={{ ...s.sumRow, color: '#2563eb' }}>
                  <span>{t.minimumGuaranteeShortfall.replace('{hours}', fmtH(guarantee_min_hours))}</span>
                  <span>+{fmtH(guarantee_shortfall_hours)}</span>
                </div>
              )}
              {sick_hours > 0 && (
                <div style={s.sumRow}><span>{t.pdfSickHours}</span><span>{fmtH(sick_hours)}</span></div>
              )}
              {vacation_hours > 0 && (
                <div style={s.sumRow}><span>{t.pdfVacationHours}</span><span>{fmtH(vacation_hours)}</span></div>
              )}
              <div style={{ ...s.sumRow, borderTop: '1px solid #e5e7eb', fontWeight: 700 }}>
                <span>{t.totalHours}</span>
                <span>{fmtH(billedHours)}</span>
              </div>
              {showPay && (
                <>
                  {regular_hours > 0 && regular_cost > 0 && (
                    <div style={{ ...s.sumRow, borderTop: '1px solid #e5e7eb' }}>
                      <span>{t.regularPay} ({fmtMoney(workerRate)}/hr)</span>
                      <span>{fmtMoney(regular_cost)}</span>
                    </div>
                  )}
                  {overtimeEnabled && overtime_hours > 0 && overtime_cost > 0 && (
                    <div style={s.sumRow}>
                      <span>{t.overtimePay} ({otMult}×)</span>
                      <span>{fmtMoney(overtime_cost)}</span>
                    </div>
                  )}
                  {prevailing_hours > 0 && prevailing_cost > 0 && (
                    <div style={s.sumRow}>
                      <span>{t.prevailingPay} ({fmtMoney(prevRate)}/hr)</span>
                      <span>{fmtMoney(prevailing_cost)}</span>
                    </div>
                  )}
                  {guarantee_shortfall_hours > 0 && guarantee_cost > 0 && (
                    <div style={{ ...s.sumRow, color: '#2563eb' }}>
                      <span>{t.minimumGuaranteePay.replace('{hours}', fmtH(guarantee_shortfall_hours)).replace('{rate}', `${fmtMoney(workerRate)}/hr`)}</span>
                      <span>{fmtMoney(guarantee_cost)}</span>
                    </div>
                  )}
                  {sick_hours > 0 && sick_cost > 0 && (
                    <div style={s.sumRow}>
                      <span>{(t.pdfSickPayRate || 'Sick Pay ({rate}/hr)').replace('{rate}', fmtMoney(sick_rate))}</span>
                      <span>{fmtMoney(sick_cost)}</span>
                    </div>
                  )}
                  {vacation_hours > 0 && vacation_cost > 0 && (
                    <div style={s.sumRow}>
                      <span>{(t.pdfVacationPayRate || 'Vacation Pay ({rate}/hr)').replace('{rate}', fmtMoney(vacation_rate))}</span>
                      <span>{fmtMoney(vacation_cost)}</span>
                    </div>
                  )}
                  {hasDeductions ? (
                    <>
                      <div style={{ ...s.sumRow, borderTop: '1px solid #e5e7eb', fontWeight: 700 }}>
                        <span>{t.pdfGrossWages}</span>
                        <span>{fmtMoney(gross_wages)}</span>
                      </div>
                      {deductions.map((d, i) => (
                        <div key={i} style={{ ...s.sumRow, color: '#b91c1c' }}>
                          <span>{d.name}{d.kind === 'percent' ? ` (${d.value}%)` : ''}</span>
                          <span>−{fmtMoney(d.amount)}</span>
                        </div>
                      ))}
                      <div style={s.sumTotal}>
                        <span>{t.netPayCol}</span>
                        <span>{fmtMoney(net_pay)}</span>
                      </div>
                    </>
                  ) : (
                    <div style={s.sumTotal}>
                      <span>{t.totalDue}</span>
                      <span>{fmtMoney(gross_wages)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PayStubView({ user, settings, companyInfo }) {
  const t = useT();
  const [stubs, setStubs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/time-entries/pay-stubs')
      .then(r => setStubs(r.data))
      .catch(silentError('paystubview'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (stubs.length === 0) return (
    <div style={s.empty}>
      <div style={s.emptyTitle}>{t.payStubs}</div>
      <p style={s.emptyMsg}>{t.noPayPeriodsYet}</p>
    </div>
  );

  return (
    <div style={s.wrap}>
      <div style={s.heading}>{t.payStubs}</div>
      <div style={s.list}>
        {stubs.map((stub, i) => (
          <InvoiceCard
            key={stub.id}
            stub={stub}
            user={user}
            settings={settings}
            companyInfo={companyInfo}
            defaultOpen={i === 0}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 12 },
  heading: { fontSize: 17, fontWeight: 700, color: '#111827' },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  empty: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  emptyTitle: { fontSize: 17, fontWeight: 700, marginBottom: 8 },
  emptyMsg: { color: '#6b7280', fontSize: 14, textAlign: 'center', padding: '12px 0' },

  // Card shell
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardHeader: { width: '100%', background: '#f9fafb', border: 'none', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', textAlign: 'left' },
  cardHeaderLeft: { display: 'flex', flexDirection: 'column', gap: 6 },
  cardLabel: { fontSize: 15, fontWeight: 700, color: '#111827' },
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { fontSize: 11, fontWeight: 600, background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: 10 },
  chevron: { fontSize: 14, color: '#6b7280', flexShrink: 0 },
  cardBody: { padding: '24px 24px 20px', borderTop: '1px solid #e5e7eb' },

  // Invoice header
  invHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 },
  companyLogo: { height: 44, maxWidth: 180, objectFit: 'contain', display: 'block', marginBottom: 8 },
  brand: { fontSize: 20, fontWeight: 800, color: 'var(--ops-page-accent)' },
  brandSub: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  invRight: { textAlign: 'right' },
  invTitle: { fontSize: 26, fontWeight: 800, color: '#111827' },
  invMeta: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 },
  metaLabel: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' },
  metaVal: { fontSize: 13, fontWeight: 600, color: '#374151' },

  // Parties
  parties: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 20, paddingBottom: 20, borderBottom: '2px solid #e5e7eb' },
  partyLabel: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b7280', marginBottom: 6 },
  partyName: { fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 3 },
  partyDetail: { fontSize: 12, color: '#6b7280', lineHeight: 1.6 },

  // Table
  tableWrap: { overflowX: 'auto', marginBottom: 20 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { background: '#f9fafb', padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280', borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f3f4f6' },
  td: { padding: '9px 10px', color: '#374151', verticalAlign: 'middle' },
  // Actual punch shown (struck through) next to the paid/rounded time when the
  // company's hours rules adjusted it and transparency is on.
  rawTime: { textDecoration: 'line-through', color: '#9ca3af', fontSize: 11, marginRight: 6 },
  badge: { display: 'inline-block', color: '#fff', padding: '1px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700 },

  // Summary
  summaryWrap: { display: 'flex', gap: 24, justifyContent: 'flex-end', alignItems: 'flex-start', flexWrap: 'wrap' },
  thankYou: { fontSize: 12, color: '#6b7280', lineHeight: 1.8, flex: 1, minWidth: 180 },
  sumTable: { border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', minWidth: 280 },
  sumRow: { display: 'flex', justifyContent: 'space-between', padding: '8px 14px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f3f4f6' },
  sumTotal: { display: 'flex', justifyContent: 'space-between', padding: '10px 14px', fontSize: 14, fontWeight: 700, background: 'var(--ops-page-accent)', color: '#fff' },
};
