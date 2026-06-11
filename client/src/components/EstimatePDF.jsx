// Estimate PDF renderer using @react-pdf/renderer — same house style as
// ProjectBillPDF (Helvetica, blue company name, light watermark title).
// Renders the full estimate a client would receive: letterhead, bill-to,
// line items grouped by category, the markup/tax cascade, exclusions /
// terms, and an acceptance signature block (or the captured acceptance
// if the estimate has already been accepted).
//
// Totals are recomputed locally via computeBreakdown so the printed
// numbers match the server-stored cascade to the cent — see estimateMath.

import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { computeBreakdown } from '../utils/estimateMath';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];
const CATEGORY_LABELS = {
  labor: 'Labor', materials: 'Materials', equipment: 'Equipment', subs: 'Subcontractors',
  overhead: 'Overhead', contingency: 'Contingency', other: 'Other',
};

const s = StyleSheet.create({
  page: { padding: '40 48', fontSize: 10, fontFamily: 'Helvetica', color: '#1a1a1a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  companyBlock: { flex: 1 },
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
  proseTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#374151', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, marginTop: 14 },
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

export default function EstimatePDF({ estimate, companyInfo = {} }) {
  const lines = estimate.lines || [];
  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of lines) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
    else (linesByCat.other = linesByCat.other || []).push(l);
  }

  const b = computeBreakdown({
    subtotalCents: estimate.subtotal_cents,
    overheadPct: estimate.overhead_pct,
    marginPct: estimate.margin_pct,
    contingencyPct: estimate.contingency_pct,
    taxPct: estimate.tax_pct,
  });

  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Document>
      <Page size="LETTER" style={s.page}>
        {/* Letterhead */}
        <View style={s.header}>
          <View style={s.companyBlock}>
            <Text style={s.companyName}>{companyInfo.name || 'OpsFloa'}</Text>
            {companyInfo.address && <Text style={s.companyMeta}>{companyInfo.address}</Text>}
            {companyInfo.phone && <Text style={s.companyMeta}>{companyInfo.phone}</Text>}
            {companyInfo.contact_email && <Text style={s.companyMeta}>{companyInfo.contact_email}</Text>}
          </View>
          <View style={s.docBlock}>
            <Text style={s.docTitle}>Estimate</Text>
            <Text style={s.docNumber}>{estimate.estimate_number}</Text>
            <Text style={s.docMeta}>Issued: {today}</Text>
            {estimate.valid_until && <Text style={s.docMeta}>Valid until: {fmtDate(estimate.valid_until)}</Text>}
          </View>
        </View>

        {/* Bill-to / project */}
        <View style={s.infoRow}>
          <View style={s.infoBlock}>
            <Text style={s.infoLabel}>Prepared For</Text>
            <Text style={s.infoValue}>{estimate.client_name_snapshot || '—'}</Text>
            {estimate.client_email && <Text style={[s.infoValue, { color: '#6b7280' }]}>{estimate.client_email}</Text>}
          </View>
          <View style={s.infoBlock}>
            <Text style={s.infoLabel}>Project</Text>
            <Text style={s.infoValue}>{estimate.project_name || '—'}</Text>
            {estimate.project_address && <Text style={[s.infoValue, { color: '#6b7280' }]}>{estimate.project_address}</Text>}
            <Text style={s.statusPill}>{(estimate.status || '').replace(/_/g, ' ')}</Text>
          </View>
        </View>

        {/* Scope summary */}
        {estimate.scope_summary ? (
          <View style={s.section}>
            <Text style={s.proseTitle}>Scope of Work</Text>
            <Text style={s.prose}>{estimate.scope_summary}</Text>
          </View>
        ) : null}

        {/* Line items by category */}
        <View style={s.section}>
          {CATEGORIES.filter(c => linesByCat[c] && linesByCat[c].length > 0).map(category => (
            <View key={category} wrap={false}>
              <Text style={s.catTitle}>{CATEGORY_LABELS[category] || category}</Text>
              {linesByCat[category].map((l, i) => (
                <View key={l.id || i} style={s.lineRow}>
                  <Text style={s.lineDesc}>{l.description}</Text>
                  <Text style={s.lineQty}>{l.qty} {l.unit || ''}</Text>
                  <Text style={s.lineAmt}>{fmtCents(l.total_cents)}</Text>
                </View>
              ))}
            </View>
          ))}

          {/* Totals cascade — only show markup rows that actually apply */}
          <View style={s.totalsBox}>
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>Subtotal</Text>
              <Text style={s.totalValue}>{fmtCents(b.subtotal)}</Text>
            </View>
            {estimate.overhead_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Overhead ({estimate.overhead_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(b.overhead)}</Text>
              </View>
            )}
            {estimate.margin_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Margin ({estimate.margin_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(b.margin)}</Text>
              </View>
            )}
            {estimate.contingency_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Contingency ({estimate.contingency_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(b.contingency)}</Text>
              </View>
            )}
            {estimate.tax_pct > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Tax ({estimate.tax_pct}%)</Text>
                <Text style={s.totalValue}>{fmtCents(b.tax)}</Text>
              </View>
            )}
            <View style={s.grandRow}>
              <Text style={s.grandLabel}>Total</Text>
              <Text style={s.grandValue}>{fmtCents(b.total)}</Text>
            </View>
          </View>
        </View>

        {/* Exclusions / terms */}
        {estimate.exclusions ? (
          <View wrap={false}>
            <Text style={s.proseTitle}>Exclusions</Text>
            <Text style={s.prose}>{estimate.exclusions}</Text>
          </View>
        ) : null}
        {estimate.terms ? (
          <View wrap={false}>
            <Text style={s.proseTitle}>Terms &amp; Conditions</Text>
            <Text style={s.prose}>{estimate.terms}</Text>
          </View>
        ) : null}

        {/* Acceptance — captured signature if accepted, else a sign line */}
        {estimate.accepted_signer_name ? (
          <View style={s.acceptedBox}>
            <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#065f46' }}>
              Accepted by {estimate.accepted_signer_name}
              {estimate.responded_at ? ` on ${fmtDate(estimate.responded_at)}` : ''}
            </Text>
          </View>
        ) : (
          <View style={s.signBlock} wrap={false}>
            <Text style={s.infoLabel}>Acceptance</Text>
            <Text style={[s.prose, { marginBottom: 4 }]}>
              Signing below authorizes the work described above at the total price shown.
            </Text>
            <View style={s.sigRow}>
              <View style={s.sigField} />
              <View style={s.sigDate} />
            </View>
            <View style={s.sigRow}>
              <Text style={[s.sigLabel, { flex: 2, marginRight: 16 }]}>Signature</Text>
              <Text style={[s.sigLabel, { flex: 1 }]}>Date</Text>
            </View>
          </View>
        )}

        <View style={s.footer} fixed>
          <Text style={s.footerText}>{companyInfo.name || 'OpsFloa'} — {estimate.estimate_number}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
