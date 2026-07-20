import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { formatCurrency, langToLocale } from '../utils';

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

function netHours(start, end, brk) {
  let ms = new Date(`1970-01-01T${end}`) - new Date(`1970-01-01T${start}`);
  if (ms < 0) ms += 86400000;
  return Math.max(0, ms / 3600000 - (brk || 0) / 60);
}

function fmtH(h) {
  const wh = Math.floor(h);
  const wm = Math.round((h - wh) * 60);
  return wm > 0 ? `${wh}h ${wm}m` : `${wh}h`;
}

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica', color: '#222' },

  invHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  brand: { fontSize: 18, fontWeight: 'bold', color: '#1a56db' },
  brandSub: { fontSize: 9, color: '#6b7280', marginTop: 2 },
  invRight: { alignItems: 'flex-end' },
  invTitle: { fontSize: 22, fontWeight: 'bold', color: '#111' },
  metaLabel: { fontSize: 8, fontWeight: 'bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  metaVal: { fontSize: 10, color: '#374151' },

  parties: { flexDirection: 'row', marginBottom: 16, paddingBottom: 16, borderBottomWidth: 1.5, borderBottomColor: '#e5e7eb', borderBottomStyle: 'solid' },
  partyBlock: { flex: 1 },
  partyLabel: { fontSize: 8, fontWeight: 'bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  partyName: { fontSize: 12, fontWeight: 'bold', color: '#111', marginBottom: 2 },
  partyDetail: { fontSize: 9, color: '#6b7280', lineHeight: 1.5 },

  tableHeader: { flexDirection: 'row', backgroundColor: '#f9fafb', paddingVertical: 6, paddingHorizontal: 4, borderBottomWidth: 1.5, borderBottomColor: '#e5e7eb', borderBottomStyle: 'solid' },
  th: { fontSize: 8, fontWeight: 'bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 },
  tableRow: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 4, borderBottomWidth: 0.5, borderBottomColor: '#f3f4f6', borderBottomStyle: 'solid' },
  td: { fontSize: 9, color: '#374151' },

  summaryWrap: { flexDirection: 'row', marginTop: 20 },
  thankYou: { flex: 1, fontSize: 9, color: '#6b7280', lineHeight: 1.8, marginRight: 20 },
  sumTable: { width: 230, borderWidth: 1, borderColor: '#e5e7eb', borderStyle: 'solid', borderRadius: 6, overflow: 'hidden' },
  sumRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, paddingHorizontal: 10, borderBottomWidth: 0.5, borderBottomColor: '#f3f4f6', borderBottomStyle: 'solid' },
  sumLabel: { fontSize: 10, color: '#374151' },
  sumVal: { fontSize: 10, color: '#374151' },
  sumDivider: { borderTopWidth: 1, borderTopColor: '#e5e7eb', borderTopStyle: 'solid' },
  sumBold: { fontWeight: 'bold' },
  sumTotal: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 10, backgroundColor: '#1a56db' },
  sumTotalText: { fontSize: 11, fontWeight: 'bold', color: '#fff' },
  reimbSection: { marginTop: 16 },
  reimbHeader: { flexDirection: 'row', backgroundColor: '#f5f3ff', paddingVertical: 6, paddingHorizontal: 4, borderBottomWidth: 1.5, borderBottomColor: '#e5e7eb', borderBottomStyle: 'solid' },
  reimbRow: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 0.5, borderBottomColor: '#f3f4f6', borderBottomStyle: 'solid' },
});

export default function BillPDF({ data, currency = 'USD', companyInfo = {}, overtimeEnabled = true, showProject = true, showRateType = true, t = {}, language, settings = null }) {
  const locale = langToLocale(language);
  // Render money in the company's configured currency (e.g. "L" for HNL), the
  // same way the on-screen figures do — this used to hardcode "$", so the PDF
  // disagreed with the screen it was printed from.
  const fmtMoney = v => formatCurrency(v, currency);
  const { worker, entries, reimbursements = [], summary, period } = data;

  const periodStr = period.from || period.to
    ? `${period.from ? fmtDateShort(period.from, locale) : (t.pdfBeginning || 'Beginning')} – ${period.to ? fmtDateShort(period.to, locale) : (t.pdfPresent || 'Present')}`
    : 'All Time';

  const invoiceDate = new Date().toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  const invoiceNum = `INV-${(period.from || '').replace(/-/g, '') || 'ALL'}-${worker.id}`;

  const ci = companyInfo || {};
  const billToLines = [ci.name, ci.address, ci.phone, ci.contact_email].filter(Boolean);

  // Build column widths dynamically based on what's shown
  // Base: Date 13%, Desc 20%, In 11%, Out 11%, Hours 13% = 68% used
  // Show a per-day OT column when overtime is on AND the company setting is on
  // (default on — undefined settings still shows it).
  const showOtCol = overtimeEnabled && settings?.report_daily_ot_column !== false;
  // Project: 18%, RateType: 14%
  const extraPct = (!showProject ? 18 : 0) + (!showRateType ? 14 : 0);
  const otPct = showOtCol ? 10 : 0;
  // Distribute extra space to Description; the OT column comes out of Description too
  const colDesc  = `${20 + extraPct - otPct}%`;
  const colDate  = '13%';
  const colIn    = '11%';
  const colOut   = '11%';
  const colHours = '13%';
  const colOt    = `${otPct}%`;
  const colProject = '18%';
  const colType  = '14%';

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Invoice header */}
        <View style={s.invHeader}>
          <View>
            <Text style={s.brand}>{worker.invoice_name || worker.full_name || '—'}</Text>
            <Text style={s.brandSub}>{t.pdfEmployeeTimeInvoice || 'Employee Time Invoice'}</Text>
          </View>
          <View style={s.invRight}>
            <Text style={s.invTitle}>{t.pdfInvoiceTitle || 'INVOICE'}</Text>
            <Text style={s.metaLabel}>{t.pdfInvoiceNum || 'Invoice #'}</Text>
            <Text style={s.metaVal}>{invoiceNum}</Text>
            <Text style={s.metaLabel}>{t.pdfInvoiceDate || 'Invoice Date'}</Text>
            <Text style={s.metaVal}>{invoiceDate}</Text>
            <Text style={s.metaLabel}>{t.pdfPayPeriod || 'Pay Period'}</Text>
            <Text style={s.metaVal}>{periodStr}</Text>
          </View>
        </View>

        {/* From / Bill To */}
        <View style={s.parties}>
          <View style={s.partyBlock}>
            <Text style={s.partyLabel}>{t.pdfFrom || 'From'}</Text>
            <Text style={s.partyName}>{worker.invoice_name || worker.full_name || '—'}</Text>
            {worker.email ? <Text style={s.partyDetail}>{worker.email}</Text> : null}
          </View>
          <View style={s.partyBlock}>
            <Text style={s.partyLabel}>{t.billTo || 'Bill To'}</Text>
            {billToLines.length > 0
              ? billToLines.map((line, i) => (
                  <Text key={i} style={i === 0 ? s.partyName : s.partyDetail}>{line}</Text>
                ))
              : <Text style={s.partyDetail}>—</Text>
            }
          </View>
        </View>

        {/* Entry table */}
        <View style={s.tableHeader}>
          <Text style={[s.th, { width: colDate }]}>{t.pdfDateCol || 'Date'}</Text>
          {showProject && <Text style={[s.th, { width: colProject }]}>Project</Text>}
          <Text style={[s.th, { width: colDesc }]}>{t.pdfDescCol || 'Description'}</Text>
          <Text style={[s.th, { width: colIn }]}>{t.pdfClockIn || 'Clock In'}</Text>
          <Text style={[s.th, { width: colOut }]}>{t.pdfClockOut || 'Clock Out'}</Text>
          {showRateType && <Text style={[s.th, { width: colType }]}>{t.pdfRateType || 'Rate Type'}</Text>}
          {showOtCol && <Text style={[s.th, { width: colOt, textAlign: 'right' }]}>{t.pdfOvertimeCol || 'OT'}</Text>}
          <Text style={[s.th, { width: colHours, textAlign: 'right' }]}>{t.pdfHoursCol || 'Hours'}</Text>
        </View>
        {entries.map(e => {
          const h = netHours(e.start_time, e.end_time, e.break_minutes);
          const isPrev = e.wage_type === 'prevailing';
          return (
            <View key={e.id} style={s.tableRow} wrap={false}>
              <Text style={[s.td, { width: colDate }]}>{fmtDate(e.work_date_str || e.work_date, locale)}</Text>
              {showProject && <Text style={[s.td, { width: colProject }]}>{e.project_name || '—'}</Text>}
              <Text style={[s.td, { width: colDesc, color: '#6b7280' }]}>{e.notes || ''}</Text>
              <Text style={[s.td, { width: colIn }]}>{fmtTime(e.start_time)}</Text>
              <Text style={[s.td, { width: colOut }]}>{fmtTime(e.end_time)}</Text>
              {showRateType && (
                <Text style={[s.td, { width: colType, color: isPrev ? '#d97706' : '#2563eb', fontWeight: 'bold' }]}>
                  {isPrev ? (t.prevailingLabel || 'Prevailing') : (t.regularLabel || 'Regular')}
                </Text>
              )}
              {showOtCol && (
                <Text style={[s.td, { width: colOt, textAlign: 'right' }, e.overtime_hours > 0 ? {} : { color: '#9ca3af' }]}>
                  {e.overtime_hours > 0 ? fmtH(e.overtime_hours) : '—'}
                </Text>
              )}
              <Text style={[s.td, { width: colHours, textAlign: 'right', fontWeight: 'bold' }]}>{fmtH(h)}</Text>
            </View>
          );
        })}

        {/* Reimbursements table */}
        {reimbursements.length > 0 && (
          <View style={s.reimbSection}>
            <View style={s.reimbHeader}>
              <Text style={[s.th, { width: '18%' }]}>{t.pdfDateCol || 'Date'}</Text>
              <Text style={[s.th, { width: '22%' }]}>{t.pdfCategory || 'Category'}</Text>
              <Text style={[s.th, { flex: 1 }]}>{t.pdfDescCol || 'Description'}</Text>
              {showProject && <Text style={[s.th, { width: '20%' }]}>Project</Text>}
              <Text style={[s.th, { width: '16%', textAlign: 'right' }]}>{t.pdfAmount || 'Amount'}</Text>
            </View>
            {reimbursements.map(r => (
              <View key={r.id} style={s.reimbRow} wrap={false}>
                <Text style={[s.td, { width: '18%' }]}>{fmtDateShort(r.expense_date, locale)}</Text>
                <Text style={[s.td, { width: '22%' }]}>{r.category || '—'}</Text>
                <Text style={[s.td, { flex: 1, color: '#6b7280' }]}>{r.description || ''}</Text>
                {showProject && <Text style={[s.td, { width: '20%' }]}>{r.project_name || '—'}</Text>}
                <Text style={[s.td, { width: '16%', textAlign: 'right', fontWeight: 'bold', color: '#7c3aed' }]}>{fmtMoney(r.amount)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Summary — keep the whole totals block together across page breaks */}
        <View style={s.summaryWrap} wrap={false}>
          <Text style={s.thankYou}>
            {t.pdfThankYouInvoice || 'Thank you for reviewing this invoice.\nPlease process payment at your earliest convenience.'}
          </Text>
          <View style={s.sumTable}>
            {summary.regular_hours > 0 && (
              <View style={s.sumRow}>
                <Text style={s.sumLabel}>{t.regularHours || 'Regular Hours'}</Text>
                <Text style={s.sumVal}>{fmtH(summary.regular_hours)}</Text>
              </View>
            )}
            {overtimeEnabled && summary.overtime_hours > 0 && (
              <View style={s.sumRow}>
                <Text style={s.sumLabel}>{t.overtimeHours || 'Overtime Hours'}</Text>
                <Text style={s.sumVal}>{fmtH(summary.overtime_hours)}</Text>
              </View>
            )}
            {summary.prevailing_hours > 0 && (
              <View style={s.sumRow}>
                <Text style={s.sumLabel}>{t.prevailingHours || 'Prevailing Hours'}</Text>
                <Text style={s.sumVal}>{fmtH(summary.prevailing_hours)}</Text>
              </View>
            )}
            {summary.guarantee_shortfall_hours > 0 && (
              <View style={s.sumRow}>
                <Text style={[s.sumLabel, { color: '#2563eb' }]}>
                  {(t.pdfMinGuarantee || 'Minimum Guarantee ({n}/period shortfall)').replace('{n}', fmtH(summary.guarantee_min_hours))}
                </Text>
                <Text style={[s.sumVal, { color: '#2563eb' }]}>+{fmtH(summary.guarantee_shortfall_hours)}</Text>
              </View>
            )}
            <View style={[s.sumRow, s.sumDivider]}>
              <Text style={[s.sumLabel, s.sumBold]}>{t.totalHours || 'Total Hours'}</Text>
              <Text style={[s.sumVal, s.sumBold]}>{fmtH((summary.total_hours || 0) + (summary.guarantee_shortfall_hours || 0))}</Text>
            </View>
            {summary.rate > 0 && summary.regular_hours > 0 && (
              <View style={[s.sumRow, s.sumDivider]}>
                <Text style={s.sumLabel}>{(t.pdfRegularPayRate || 'Regular Pay ({rate}/hr)').replace('{rate}', fmtMoney(summary.rate))}</Text>
                <Text style={s.sumVal}>{fmtMoney(summary.regular_cost)}</Text>
              </View>
            )}
            {overtimeEnabled && summary.overtime_hours > 0 && summary.rate > 0 && (
              <View style={s.sumRow}>
                <Text style={s.sumLabel}>{(t.pdfOvertimePayMult || 'Overtime Pay ({mult}×)').replace('{mult}', summary.overtime_multiplier)}</Text>
                <Text style={s.sumVal}>{fmtMoney(summary.overtime_cost)}</Text>
              </View>
            )}
            {summary.prevailing_hours > 0 && summary.prevailing_wage_rate > 0 && (
              <View style={s.sumRow}>
                <Text style={s.sumLabel}>{(t.pdfPrevailingPayRate || 'Prevailing Pay ({rate}/hr)').replace('{rate}', fmtMoney(summary.prevailing_wage_rate))}</Text>
                <Text style={s.sumVal}>{fmtMoney(summary.prevailing_cost)}</Text>
              </View>
            )}
            {summary.guarantee_shortfall_hours > 0 && summary.rate > 0 && (
              <View style={s.sumRow}>
                <Text style={[s.sumLabel, { color: '#2563eb' }]}>
                  {(t.pdfMinGuaranteePay || 'Minimum Guarantee ({hrs} @ {rate}/hr)').replace('{hrs}', fmtH(summary.guarantee_shortfall_hours)).replace('{rate}', fmtMoney(summary.rate))}
                </Text>
                <Text style={[s.sumVal, { color: '#2563eb' }]}>{fmtMoney(summary.guarantee_cost || 0)}</Text>
              </View>
            )}
            {(summary.reimbursement_total || 0) > 0 && (
              <View style={s.sumRow}>
                <Text style={[s.sumLabel, { color: '#7c3aed' }]}>{t.expenseReimbursements || 'Expense Reimbursements'}</Text>
                <Text style={[s.sumVal, { color: '#7c3aed' }]}>{fmtMoney(summary.reimbursement_total)}</Text>
              </View>
            )}
            <View style={s.sumTotal}>
              <Text style={s.sumTotalText}>{t.totalDue || 'Total Due'}</Text>
              <Text style={s.sumTotalText}>{fmtMoney(summary.total_cost)}</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}
