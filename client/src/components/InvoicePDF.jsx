// Native-invoice PDF renderer — same house style as EstimatePDF (Helvetica,
// blue company name, light watermark title). Renders the invoice a client
// receives: letterhead, bill-to, line items grouped by category, subtotal →
// tax → total, retainage held, and amount paid / balance due.
//
// Invoice math is simpler than an estimate (no overhead/margin/contingency
// cascade), so totals come straight off the server-stored cents.

import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import CompanyLogoPdf from './CompanyLogoPdf';
import { formatCurrency, langToLocale } from '../utils';
import { getT } from '../i18n';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];
const CATEGORY_LABEL_KEYS = {
  labor: 'pdfCatLabor', materials: 'pdfCatMaterials', equipment: 'pdfCatEquipment',
  subs: 'pdfCatSubs', overhead: 'pdfCatOverhead', contingency: 'pdfCatContingency', other: 'pdfCatOther',
};

const s = StyleSheet.create({
  page: { padding: '40 48', fontSize: 10, fontFamily: 'Helvetica', color: '#1a1a1a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  companyBlock: { flex: 1 },
  companyLogo: { height: 44, maxWidth: 180, objectFit: 'contain', marginBottom: 8 },
  companyName: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#1a56db', marginBottom: 4 },
  companyMeta: { fontSize: 9, color: '#555', lineHeight: 1.5 },
  docBlock: { alignItems: 'flex-end' },
  docTitle: { fontSize: 28, fontFamily: 'Helvetica-Bold', color: '#e5e7eb', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 },
  docNumber: { fontSize: 10, color: '#374151', fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  docMeta: { fontSize: 9, color: '#6b7280' },
  infoRow: { flexDirection: 'row', gap: 32, marginBottom: 26 },
  infoBlock: { flex: 1 },
  infoLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  infoValue: { fontSize: 10, color: '#111827', lineHeight: 1.5 },
  statusPill: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#1a56db', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  section: { marginBottom: 18 },
  catTitle: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginTop: 10, marginBottom: 4 },
  lineRow: { flexDirection: 'row', paddingVertical: 3, borderBottom: '0.5pt solid #f3f4f6' },
  lineDesc: { flex: 3, fontSize: 10 },
  lineQty: { flex: 1, fontSize: 9, color: '#6b7280', textAlign: 'right' },
  lineAmt: { flex: 1, fontSize: 10, textAlign: 'right' },
  totalsBox: { marginTop: 14, marginLeft: 'auto', width: 240 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  totalLabel: { fontSize: 10, color: '#374151' },
  totalValue: { fontSize: 10, textAlign: 'right' },
  grandRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, marginTop: 2, borderTop: '1pt solid #374151' },
  grandLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  grandValue: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#1a56db', textAlign: 'right' },
  balRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, marginTop: 4, backgroundColor: '#f0f4ff', paddingHorizontal: 8, borderRadius: 3 },
  balLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#111827' },
  balValue: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#059669', textAlign: 'right' },
  proseTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#374151', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, marginTop: 14 },
  prose: { fontSize: 9, color: '#374151', lineHeight: 1.5 },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, borderTop: '0.5pt solid #e5e7eb', paddingTop: 8, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: '#9ca3af' },
});

function fmtCents(cents, currency) {
  return formatCurrency((parseInt(cents, 10) || 0) / 100, currency);
}
function fmtDate(d, language) {
  if (!d) return '';
  return new Date(d.toString().substring(0, 10) + 'T00:00:00')
    .toLocaleDateString(langToLocale(language), { month: 'short', day: 'numeric', year: 'numeric' });
}

// `language` is the recipient's language name; the PDF renders outside the React
// tree, so it resolves its own dictionary via getT(language). `statusLabel` is
// the already-translated status. All strings fall back to English.
export default function InvoicePDF({ invoice, currency = 'USD', companyInfo = {}, language, statusLabel }) {
  const t = getT(language);
  const tr = (k, fallback) => t[k] || fallback;
  const lines = invoice.lines || [];
  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of lines) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
    else (linesByCat.other = linesByCat.other || []).push(l);
  }

  const paid = parseInt(invoice.amount_paid_cents, 10) || 0;
  const total = parseInt(invoice.total_cents, 10) || 0;
  const balance = Math.max(0, total - paid);
  const today = new Date().toLocaleDateString(langToLocale(language), { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Document>
      <Page size="LETTER" style={s.page}>
        {/* Letterhead */}
        <View style={s.header}>
          <View style={s.companyBlock}>
            <CompanyLogoPdf src={companyInfo.logo_url} style={s.companyLogo} />
            <Text style={s.companyName}>{companyInfo.name || 'OpsFloa'}</Text>
            {companyInfo.address && <Text style={s.companyMeta}>{companyInfo.address}</Text>}
            {companyInfo.phone && <Text style={s.companyMeta}>{companyInfo.phone}</Text>}
            {companyInfo.contact_email && <Text style={s.companyMeta}>{companyInfo.contact_email}</Text>}
          </View>
          <View style={s.docBlock}>
            <Text style={s.docTitle}>{tr('pdfInvoiceWord', 'Invoice')}</Text>
            <Text style={s.docNumber}>{invoice.invoice_number}</Text>
            <Text style={s.docMeta}>{tr('pdfIssued', 'Issued:')} {invoice.issue_date ? fmtDate(invoice.issue_date, language) : today}</Text>
            {invoice.due_date && <Text style={s.docMeta}>{tr('pdfDueLabel', 'Due:')} {fmtDate(invoice.due_date, language)}</Text>}
          </View>
        </View>

        {/* Bill-to / project */}
        <View style={s.infoRow}>
          <View style={s.infoBlock}>
            <Text style={s.infoLabel}>{tr('billTo', 'Bill To')}</Text>
            <Text style={s.infoValue}>{invoice.client_name_snapshot || '—'}</Text>
            {invoice.client_email && <Text style={[s.infoValue, { color: '#6b7280' }]}>{invoice.client_email}</Text>}
          </View>
          <View style={s.infoBlock}>
            <Text style={s.infoLabel}>{tr('pdfProject', 'Project')}</Text>
            <Text style={s.infoValue}>{invoice.project_name || '—'}</Text>
            {invoice.project_address && <Text style={[s.infoValue, { color: '#6b7280' }]}>{invoice.project_address}</Text>}
            <Text style={s.statusPill}>{statusLabel || (invoice.status || '').replace(/_/g, ' ')}</Text>
          </View>
        </View>

        {/* Line items by category */}
        <View style={s.section}>
          {CATEGORIES.filter(c => linesByCat[c] && linesByCat[c].length > 0).map(category => (
            <View key={category} wrap={false}>
              <Text style={s.catTitle}>{tr(CATEGORY_LABEL_KEYS[category], category)}</Text>
              {linesByCat[category].map((l, i) => (
                <View key={l.id || i} style={s.lineRow}>
                  <Text style={s.lineDesc}>{l.description}</Text>
                  <Text style={s.lineQty}>{l.qty} {l.unit || ''}</Text>
                  <Text style={s.lineAmt}>{fmtCents(l.total_cents, currency)}</Text>
                </View>
              ))}
            </View>
          ))}

          <View style={s.totalsBox}>
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>{tr('pdfSubtotal', 'Subtotal')}</Text>
              <Text style={s.totalValue}>{fmtCents(invoice.subtotal_cents, currency)}</Text>
            </View>
            {invoice.tax_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>{tr('pdfTax', 'Tax')} ({invoice.tax_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(invoice.tax_cents, currency)}</Text>
              </View>
            )}
            <View style={s.grandRow}>
              <Text style={s.grandLabel}>{tr('pdfTotal', 'Total')}</Text>
              <Text style={s.grandValue}>{fmtCents(invoice.total_cents, currency)}</Text>
            </View>
            {invoice.retainage_held_cents > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>{tr('invRetainageHeld', 'Retainage held')} ({invoice.retainage_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(invoice.retainage_held_cents, currency)}</Text>
              </View>
            )}
            {paid > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>{tr('invAmountPaid', 'Amount paid')}</Text>
                <Text style={s.totalValue}>-{fmtCents(paid, currency)}</Text>
              </View>
            )}
            <View style={s.balRow}>
              <Text style={s.balLabel}>{tr('invBalanceDue', 'Balance due')}</Text>
              <Text style={s.balValue}>{fmtCents(balance, currency)}</Text>
            </View>
          </View>
        </View>

        {/* Terms */}
        {invoice.terms ? (
          <View wrap={false}>
            <Text style={s.proseTitle}>{tr('pdfTerms', 'Terms & Conditions')}</Text>
            <Text style={s.prose}>{invoice.terms}</Text>
          </View>
        ) : null}

        <View style={s.footer} fixed>
          <Text style={s.footerText}>{companyInfo.name || 'OpsFloa'} — {invoice.invoice_number}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `${tr('pdfPage', 'Page')} ${pageNumber} ${tr('pdfOf', 'of')} ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
