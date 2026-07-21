import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import CompanyLogoPdf from './CompanyLogoPdf';
import { formatCurrency, langToLocale } from '../utils';

const s = StyleSheet.create({
  page: { padding: '40 48', fontSize: 10, fontFamily: 'Helvetica', color: '#1a1a1a' },
  // Header
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 32 },
  companyBlock: { flex: 1 },
  companyLogo: { height: 44, maxWidth: 180, objectFit: 'contain', marginBottom: 8 },
  companyName: { fontSize: 20, fontWeight: 'bold', color: '#1a56db', marginBottom: 4 },
  companyMeta: { fontSize: 9, color: '#555', lineHeight: 1.5 },
  invoiceBlock: { alignItems: 'flex-end' },
  invoiceTitle: { fontSize: 28, fontWeight: 'bold', color: '#e5e7eb', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 },
  invoiceNumber: { fontSize: 10, color: '#374151', fontWeight: 'bold', marginBottom: 2 },
  invoiceDate: { fontSize: 9, color: '#6b7280' },
  // Bill-to / project
  infoRow: { flexDirection: 'row', gap: 32, marginBottom: 28 },
  infoBlock: { flex: 1 },
  infoLabel: { fontSize: 8, fontWeight: 'bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  infoValue: { fontSize: 10, color: '#111827', lineHeight: 1.5 },
  // Summary
  summaryBox: { backgroundColor: '#f0f4ff', borderRadius: 4, padding: '12 16', marginBottom: 20 },
  summaryRow: { flexDirection: 'row', gap: 0 },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryVal: { fontSize: 18, fontWeight: 'bold', color: '#111827' },
  summaryLabel: { fontSize: 8, color: '#6b7280', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  // Cost breakdown
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 9, fontWeight: 'bold', color: '#374151', textTransform: 'uppercase', letterSpacing: 1, borderBottom: '0.5pt solid #e5e7eb', paddingBottom: 4, marginBottom: 8 },
  costRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderBottom: '0.5pt solid #f3f4f6' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, marginTop: 2, borderTop: '1pt solid #374151' },
  totalLabel: { fontSize: 12, fontWeight: 'bold' },
  totalValue: { fontSize: 12, fontWeight: 'bold', color: '#1a56db' },
  // Entries table
  tableHeader: { flexDirection: 'row', backgroundColor: '#f8fafc', paddingVertical: 5, paddingHorizontal: 4, borderBottom: '0.5pt solid #e5e7eb' },
  tableRow: { flexDirection: 'row', paddingVertical: 4, paddingHorizontal: 4, borderBottom: '0.5pt solid #f3f4f6' },
  colWorker: { flex: 2.2, fontSize: 9 },
  colDate: { flex: 1.2, fontSize: 9 },
  colTime: { flex: 1, fontSize: 9 },
  colOt: { flex: 0.6, fontSize: 9, textAlign: 'right' },
  colHours: { flex: 0.7, fontSize: 9, textAlign: 'right' },
  colType: { flex: 0.8, fontSize: 9, textAlign: 'right' },
  headerText: { fontSize: 8, fontWeight: 'bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 },
  // Footer
  footer: { marginTop: 32, borderTop: '0.5pt solid #e5e7eb', paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: '#6b7280' },
});

function fmtDate(d, locale = 'en-US') {
  if (!d) return '';
  return new Date(d.toString().substring(0, 10) + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}

function calcHours(start, end) {
  if (!start || !end) return '—';
  const s = new Date(`1970-01-01T${start}`);
  const e = new Date(`1970-01-01T${end}`);
  return ((e - s) / 3600000).toFixed(2);
}

function invoiceNumber(projectId, period) {
  const date = period?.to || new Date().toISOString().substring(0, 10);
  const ym = date.substring(0, 7).replace('-', '');
  return `INV-${String(projectId).padStart(4, '0')}-${ym}`;
}

export default function ProjectBillPDF({ data, currency = 'USD', companyInfo = {}, project: projectMeta = {}, t = {}, language, settings = null }) {
  const locale = langToLocale(language);
  const { project, entries, summary, period } = data;
  // Per-day OT column: on when overtime is enabled and the company setting is on
  // (default on — undefined settings still shows it).
  const showOtCol = settings?.feature_overtime !== false && settings?.report_daily_ot_column !== false;
  const workerLabel = settings?.label_worker || t.pdfWorkerCol || 'Team Member';
  const periodStr = period?.from || period?.to
    ? `${period.from ? fmtDate(period.from, locale) : (t.pdfBeginning || 'Beginning')} – ${period.to ? fmtDate(period.to, locale) : (t.pdfPresent || 'Present')}`
    : 'All Time';
  const today = new Date().toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
  const invNum = invoiceNumber(project?.id || projectMeta?.id, period);

  // Due date: NET 30
  const dueDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
  })();

  const clientName = projectMeta?.client_name || project?.client_name || '';
  const clientAddress = projectMeta?.address || project?.address || '';

  return (
    <Document>
      <Page size="A4" style={s.page}>

        {/* Header */}
        <View style={s.header}>
          <View style={s.companyBlock}>
            <CompanyLogoPdf src={companyInfo.logo_url} style={s.companyLogo} />
            <Text style={s.companyName}>{companyInfo.name || 'OpsFloa'}</Text>
            {companyInfo.address && <Text style={s.companyMeta}>{companyInfo.address}</Text>}
            {companyInfo.phone && <Text style={s.companyMeta}>{companyInfo.phone}</Text>}
            {companyInfo.contact_email && <Text style={s.companyMeta}>{companyInfo.contact_email}</Text>}
          </View>
          <View style={s.invoiceBlock}>
            <Text style={s.invoiceTitle}>{t.pdfInvoiceWord || 'Invoice'}</Text>
            <Text style={s.invoiceNumber}>{invNum}</Text>
            <Text style={s.invoiceDate}>{t.pdfIssuedLabel || 'Issued:'} {today}</Text>
            <Text style={s.invoiceDate}>{t.pdfDueLabel || 'Due:'} {dueDate} {t.pdfNet30 || '(NET 30)'}</Text>
          </View>
        </View>

        {/* Bill To / Project */}
        <View style={s.infoRow}>
          {(clientName || clientAddress) && (
            <View style={s.infoBlock}>
              <Text style={s.infoLabel}>{t.billTo || 'Bill To'}</Text>
              {clientName && <Text style={s.infoValue}>{clientName}</Text>}
              {clientAddress && <Text style={[s.infoValue, { color: '#6b7280' }]}>{clientAddress}</Text>}
            </View>
          )}
          <View style={s.infoBlock}>
            <Text style={s.infoLabel}>Project</Text>
            <Text style={s.infoValue}>{project?.name || projectMeta?.name || '—'}</Text>
            {(projectMeta?.job_number || project?.job_number) && (
              <Text style={[s.infoValue, { color: '#6b7280' }]}>{t.pdfJobNum || 'Job #'}{projectMeta?.job_number || project?.job_number}</Text>
            )}
            <Text style={[s.infoValue, { color: '#6b7280', marginTop: 2 }]}>{periodStr}</Text>
          </View>
        </View>

        {/* Summary row */}
        <View style={s.summaryBox} wrap={false}>
          <View style={s.summaryRow}>
            <View style={s.summaryItem}>
              <Text style={s.summaryVal}>{(summary.total_hours || 0).toFixed(2)}h</Text>
              <Text style={s.summaryLabel}>{t.totalHours || 'Total Hours'}</Text>
            </View>
            {summary.regular_hours > 0 && (
              <View style={s.summaryItem}>
                <Text style={[s.summaryVal, { color: '#2563eb' }]}>{summary.regular_hours.toFixed(2)}h</Text>
                <Text style={s.summaryLabel}>{t.regularLabel || 'Regular'}</Text>
              </View>
            )}
            {summary.overtime_hours > 0 && (
              <View style={s.summaryItem}>
                <Text style={[s.summaryVal, { color: '#dc2626' }]}>{summary.overtime_hours.toFixed(2)}h</Text>
                <Text style={s.summaryLabel}>{t.overtimeLabel || 'Overtime'}</Text>
              </View>
            )}
            {summary.prevailing_hours > 0 && (
              <View style={s.summaryItem}>
                <Text style={[s.summaryVal, { color: '#d97706' }]}>{summary.prevailing_hours.toFixed(2)}h</Text>
                <Text style={s.summaryLabel}>{t.prevailingLabel || 'Prevailing'}</Text>
              </View>
            )}
            <View style={s.summaryItem}>
              <Text style={[s.summaryVal, { color: '#059669' }]}>{formatCurrency(summary.total_cost, currency)}</Text>
              <Text style={s.summaryLabel}>{t.pdfAmountDue || 'Amount Due'}</Text>
            </View>
          </View>
        </View>

        {/* Cost breakdown — keep the breakdown + Total Due together */}
        <View style={s.section} wrap={false}>
          <Text style={s.sectionTitle}>{t.pdfCostBreakdown || 'Cost Breakdown'}</Text>
          {summary.regular_hours > 0 && (
            <View style={s.costRow}>
              <Text style={{ color: '#374151' }}>{(t.pdfRegularLabor || 'Regular labor — {hrs} hrs').replace('{hrs}', summary.regular_hours.toFixed(2))}</Text>
              <Text style={{ color: '#2563eb', fontWeight: 'bold' }}>{formatCurrency(summary.regular_cost, currency)}</Text>
            </View>
          )}
          {summary.overtime_hours > 0 && (
            <View style={s.costRow}>
              <Text style={{ color: '#374151' }}>{(t.pdfOvertimeLabor || 'Overtime — {hrs} hrs × {mult}x').replace('{hrs}', summary.overtime_hours.toFixed(2)).replace('{mult}', summary.overtime_multiplier)}</Text>
              <Text style={{ color: '#dc2626', fontWeight: 'bold' }}>{formatCurrency(summary.overtime_cost, currency)}</Text>
            </View>
          )}
          {summary.prevailing_hours > 0 && (
            <View style={s.costRow}>
              <Text style={{ color: '#374151' }}>{(t.pdfPrevailingWage || 'Prevailing wage — {hrs} hrs @ {rate}/hr').replace('{hrs}', summary.prevailing_hours.toFixed(2)).replace('{rate}', formatCurrency(summary.prevailing_wage_rate, currency))}</Text>
              <Text style={{ color: '#d97706', fontWeight: 'bold' }}>{formatCurrency(summary.prevailing_cost, currency)}</Text>
            </View>
          )}
          <View style={s.totalRow}>
            <Text style={s.totalLabel}>{t.totalDue || 'Total Due'}</Text>
            <Text style={s.totalValue}>{formatCurrency(summary.total_cost, currency)}</Text>
          </View>
        </View>

        {/* Time entries */}
        {entries?.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>{(t.pdfTimeEntries || 'Time Entries ({n})').replace('{n}', entries.length)}</Text>
            <View style={s.tableHeader}>
              <Text style={[s.colWorker, s.headerText]}>{workerLabel}</Text>
              <Text style={[s.colDate, s.headerText]}>{t.pdfDateCol || 'Date'}</Text>
              <Text style={[s.colTime, s.headerText]}>{t.pdfStartCol || 'Start'}</Text>
              <Text style={[s.colTime, s.headerText]}>{t.pdfEndCol || 'End'}</Text>
              {showOtCol && <Text style={[s.colOt, s.headerText]}>{t.pdfOvertimeCol || 'OT'}</Text>}
              <Text style={[s.colHours, s.headerText]}>{t.pdfHoursCol || 'Hours'}</Text>
              <Text style={[s.colType, s.headerText]}>{t.pdfTypeCol || 'Type'}</Text>
            </View>
            {entries.map(e => (
              <View key={e.id} style={s.tableRow} wrap={false}>
                <Text style={s.colWorker}>{e.invoice_name || e.worker_name}</Text>
                <Text style={s.colDate}>{fmtDate(e.work_date, locale)}</Text>
                <Text style={s.colTime}>{fmtTime(e.start_time)}</Text>
                <Text style={s.colTime}>{fmtTime(e.end_time)}</Text>
                {showOtCol && <Text style={[s.colOt, e.overtime_hours > 0 ? {} : { color: '#9ca3af' }]}>{e.overtime_hours > 0 ? Number(e.overtime_hours).toFixed(2) : '—'}</Text>}
                <Text style={s.colHours}>{calcHours(e.start_time, e.end_time)}</Text>
                <Text style={s.colType}>{e.wage_type}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Footer */}
        <View style={s.footer} wrap={false}>
          <Text style={s.footerText}>{invNum}</Text>
          <Text style={s.footerText}>{t.pdfThankYouBusiness || 'Thank you for your business.'}</Text>
        </View>

      </Page>
    </Document>
  );
}
