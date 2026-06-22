// Change-order PDF renderer — mirrors EstimatePDF's house style. A CO is
// a mid-project scope/price adjustment, so the document leads with the
// change description and the project it amends, then the priced line
// items and the markup/tax cascade (COs carry no separate contingency).
//
// Totals recomputed locally via computeBreakdown so the printed numbers
// match the server-stored cascade to the cent.

import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { computeBreakdown } from '../utils/estimateMath';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];
const CATEGORY_LABEL_KEYS = {
  labor: 'pdfCatLabor', materials: 'pdfCatMaterials', equipment: 'pdfCatEquipment',
  subs: 'pdfCatSubs', overhead: 'pdfCatOverhead', contingency: 'pdfCatContingency', other: 'pdfCatOther',
};

const s = StyleSheet.create({
  page: { padding: '40 48', fontSize: 10, fontFamily: 'Helvetica', color: '#1a1a1a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  companyBlock: { flex: 1 },
  companyName: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#1a56db', marginBottom: 4 },
  companyMeta: { fontSize: 9, color: '#555', lineHeight: 1.5 },
  docBlock: { alignItems: 'flex-end' },
  docTitle: { fontSize: 24, fontFamily: 'Helvetica-Bold', color: '#e5e7eb', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 },
  docNumber: { fontSize: 10, color: '#374151', fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  docMeta: { fontSize: 9, color: '#6b7280' },
  infoRow: { flexDirection: 'row', gap: 32, marginBottom: 20 },
  infoBlock: { flex: 1 },
  infoLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  infoValue: { fontSize: 10, color: '#111827', lineHeight: 1.5 },
  statusPill: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#1a56db', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  descBox: { padding: 12, backgroundColor: '#f9fafb', borderLeft: '2pt solid #1a56db', marginBottom: 22 },
  descLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  descText: { fontSize: 11, color: '#111827', lineHeight: 1.4 },
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
  prose: { fontSize: 9, color: '#374151', lineHeight: 1.5 },
  signBlock: { marginTop: 30, borderTop: '0.5pt solid #1a1a1a', paddingTop: 16 },
  sigRow: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 10 },
  sigField: { flex: 2, borderBottom: '0.5pt solid #6b7280', height: 26, marginRight: 16 },
  sigDate: { flex: 1, borderBottom: '0.5pt solid #6b7280', height: 26 },
  sigLabel: { fontSize: 8, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 3 },
  acceptedBox: { marginTop: 24, padding: 12, backgroundColor: '#ecfdf5', border: '0.5pt solid #6ee7b7' },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, borderTop: '0.5pt solid #e5e7eb', paddingTop: 8, flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 8, color: '#9ca3af' },
});

function fmtCents(cents) {
  const n = (parseInt(cents, 10) || 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d.toString().substring(0, 10) + 'T00:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// `t` is the resolved translation dictionary passed from the detail page
// (the PDF renders outside the React tree). `statusLabel` is the already-
// translated status string. Both fall back to English.
export default function ChangeOrderPDF({ changeOrder, companyInfo = {}, t = {}, statusLabel }) {
  const tr = (k, fallback) => t[k] || fallback;
  const co = changeOrder;
  const lines = co.lines || [];
  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of lines) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
    else (linesByCat.other = linesByCat.other || []).push(l);
  }

  const b = computeBreakdown({
    subtotalCents: co.subtotal_cents,
    overheadPct: co.overhead_pct,
    marginPct: co.margin_pct,
    contingencyPct: 0, // COs don't carry a separate contingency
    taxPct: co.tax_pct,
  });

  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Document>
      <Page size="LETTER" style={s.page}>
        <View style={s.header}>
          <View style={s.companyBlock}>
            <Text style={s.companyName}>{companyInfo.name || 'OpsFloa'}</Text>
            {companyInfo.address && <Text style={s.companyMeta}>{companyInfo.address}</Text>}
            {companyInfo.phone && <Text style={s.companyMeta}>{companyInfo.phone}</Text>}
            {companyInfo.contact_email && <Text style={s.companyMeta}>{companyInfo.contact_email}</Text>}
          </View>
          <View style={s.docBlock}>
            <Text style={s.docTitle}>{tr('pdfChangeOrder', 'Change Order')}</Text>
            <Text style={s.docNumber}>{co.co_number}</Text>
            <Text style={s.docMeta}>{tr('pdfIssued', 'Issued:')} {today}</Text>
          </View>
        </View>

        <View style={s.infoRow}>
          <View style={s.infoBlock}>
            <Text style={s.infoLabel}>{tr('pdfProject', 'Project')}</Text>
            <Text style={s.infoValue}>{co.project_name || '—'}</Text>
            <Text style={s.statusPill}>{statusLabel || (co.status || '').replace(/_/g, ' ')}</Text>
          </View>
        </View>

        {co.description ? (
          <View style={s.descBox}>
            <Text style={s.descLabel}>{tr('pdfChangeDescription', 'Change Description')}</Text>
            <Text style={s.descText}>{co.description}</Text>
          </View>
        ) : null}

        <View style={s.section}>
          {CATEGORIES.filter(c => linesByCat[c] && linesByCat[c].length > 0).map(category => (
            <View key={category} wrap={false}>
              <Text style={s.catTitle}>{tr(CATEGORY_LABEL_KEYS[category], category)}</Text>
              {linesByCat[category].map((l, i) => (
                <View key={l.id || i} style={s.lineRow}>
                  <Text style={s.lineDesc}>{l.description}</Text>
                  <Text style={s.lineQty}>{l.qty} {l.unit || ''}</Text>
                  <Text style={s.lineAmt}>{fmtCents(l.total_cents)}</Text>
                </View>
              ))}
            </View>
          ))}

          <View style={s.totalsBox}>
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>{tr('pdfSubtotal', 'Subtotal')}</Text>
              <Text style={s.totalValue}>{fmtCents(b.subtotal)}</Text>
            </View>
            {co.overhead_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>{tr('pdfOverhead', 'Overhead')} ({co.overhead_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(b.overhead)}</Text>
              </View>
            )}
            {co.margin_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>{tr('pdfMargin', 'Margin')} ({co.margin_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(b.margin)}</Text>
              </View>
            )}
            {co.tax_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>{tr('pdfTax', 'Tax')} ({co.tax_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(b.tax)}</Text>
              </View>
            )}
            <View style={s.grandRow}>
              <Text style={s.grandLabel}>{tr('pdfChangeTotal', 'Change Total')}</Text>
              <Text style={s.grandValue}>{fmtCents(b.total)}</Text>
            </View>
          </View>
        </View>

        {co.notes ? (
          <View wrap={false}>
            <Text style={s.descLabel}>{tr('pdfNotes', 'Notes')}</Text>
            <Text style={s.prose}>{co.notes}</Text>
          </View>
        ) : null}

        {co.accepted_signer_name ? (
          <View style={s.acceptedBox}>
            <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#065f46' }}>
              {tr('pdfAcceptedBy', 'Accepted by')} {co.accepted_signer_name}
              {co.responded_at ? ` ${tr('pdfOn', 'on')} ${fmtDate(co.responded_at)}` : ''}
            </Text>
          </View>
        ) : (
          <View style={s.signBlock} wrap={false}>
            <Text style={s.infoLabel}>{tr('pdfAcceptance', 'Acceptance')}</Text>
            <Text style={[s.prose, { marginBottom: 4 }]}>
              {tr('pdfCoAcceptText', 'Signing below authorizes this change to the contract scope and adjusts the contract price accordingly.')}
            </Text>
            <View style={s.sigRow}>
              <View style={s.sigField} />
              <View style={s.sigDate} />
            </View>
            <View style={s.sigRow}>
              <Text style={[s.sigLabel, { flex: 2, marginRight: 16 }]}>{tr('pdfSignature', 'Signature')}</Text>
              <Text style={[s.sigLabel, { flex: 1 }]}>{tr('pdfDate', 'Date')}</Text>
            </View>
          </View>
        )}

        <View style={s.footer} fixed>
          <Text style={s.footerText}>{companyInfo.name || 'OpsFloa'} — {co.co_number}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `${tr('pdfPage', 'Page')} ${pageNumber} ${tr('pdfOf', 'of')} ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
