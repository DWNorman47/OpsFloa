// Lien waiver PDF renderer using @react-pdf/renderer — same pattern as
// ProjectBillPDF. v1 ships ONE template (generic statutory form) that
// covers the common case across most US jurisdictions. State-specific
// statutory forms (CA Civ Code §8132 et seq., TX Prop Code §53.281
// et seq., FL §713.20, NY Lien Law §34) are a real follow-up — the
// data model has the `state` column and the registry pattern is here,
// so adding them is a template-library exercise rather than a redesign.
//
// The header gracefully distinguishes the 4 type quadrants
// (conditional/unconditional × progress/final), and the body language
// reflects the conditional vs unconditional distinction since that's
// the binding legal difference.

import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

const TYPE_TITLES = {
  conditional_progress:   'Conditional Waiver and Release on Progress Payment',
  unconditional_progress: 'Unconditional Waiver and Release on Progress Payment',
  conditional_final:      'Conditional Waiver and Release on Final Payment',
  unconditional_final:    'Unconditional Waiver and Release on Final Payment',
};

const s = StyleSheet.create({
  page: {
    padding: '50 56',
    fontSize: 11,
    fontFamily: 'Times-Roman',
    color: '#1a1a1a',
    lineHeight: 1.5,
  },
  header: { textAlign: 'center', marginBottom: 18, borderBottom: '1pt solid #1a1a1a', paddingBottom: 12 },
  title: { fontSize: 16, fontFamily: 'Times-Bold', textTransform: 'uppercase', letterSpacing: 1 },
  subtitle: { fontSize: 10, color: '#6b7280', marginTop: 4 },
  metaTable: { marginBottom: 18 },
  metaRow: { flexDirection: 'row', paddingVertical: 3, borderBottom: '0.5pt solid #e5e7eb' },
  metaLabel: { width: 130, fontSize: 10, fontFamily: 'Times-Bold' },
  metaValue: { flex: 1, fontSize: 10 },
  bodyText: { fontSize: 11, marginBottom: 12, textAlign: 'justify' },
  signBlock: { marginTop: 36, borderTop: '0.5pt solid #1a1a1a', paddingTop: 16 },
  sigRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 18 },
  sigField: { flex: 1, borderBottom: '0.5pt solid #6b7280', height: 24, marginRight: 16 },
  sigLabel: { fontSize: 9, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  smallNote: { fontSize: 8, color: '#9ca3af', marginTop: 24, fontStyle: 'italic' },
});

function formatCents(cents) {
  const n = (parseInt(cents, 10) || 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d.toString().substring(0, 10) + 'T00:00:00')
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function bodyTextFor(waiver) {
  const amt = formatCents(waiver.amount_cents);
  const through = fmtDate(waiver.through_date);
  const project = waiver.project_name || 'the Project';
  const isConditional = waiver.waiver_type?.startsWith('conditional_');
  const isFinal = waiver.waiver_type?.endsWith('_final');

  if (isConditional) {
    return `Upon receipt by the undersigned of a check from the payer in the sum of ${amt} payable to the undersigned, and the check has been properly endorsed and has been paid by the bank on which it is drawn, this document shall become effective to release any mechanic's lien, stop payment notice, or right against any labor and material bond the undersigned has on the project located at or known as "${project}" for labor, services, equipment, or material furnished to or for the benefit of the project ${isFinal ? 'through completion of the undersigned\'s scope of work' : `through ${through}`}.`;
  }
  return `The undersigned has been paid in full for all labor, services, equipment, or material furnished to or for the benefit of the project located at or known as "${project}" ${isFinal ? 'through completion of the undersigned\'s scope of work' : `through ${through}`}, and does hereby waive and release any mechanic's lien, stop payment notice, or right against any labor and material bond the undersigned has on the project to the extent of the sum of ${amt}.`;
}

export default function LienWaiverPDF({ waiver }) {
  const title = TYPE_TITLES[waiver.waiver_type] || 'Lien Waiver';
  return (
    <Document>
      <Page size="LETTER" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>{title}</Text>
          {waiver.state && <Text style={s.subtitle}>State: {waiver.state} (generic template — consult counsel for statutory form)</Text>}
        </View>

        <View style={s.metaTable}>
          <View style={s.metaRow}>
            <Text style={s.metaLabel}>Project</Text>
            <Text style={s.metaValue}>{waiver.project_name}</Text>
          </View>
          {waiver.subcontractor_name && (
            <View style={s.metaRow}>
              <Text style={s.metaLabel}>Subcontractor</Text>
              <Text style={s.metaValue}>{waiver.subcontractor_name}</Text>
            </View>
          )}
          <View style={s.metaRow}>
            <Text style={s.metaLabel}>Amount</Text>
            <Text style={s.metaValue}>{formatCents(waiver.amount_cents)}</Text>
          </View>
          <View style={s.metaRow}>
            <Text style={s.metaLabel}>Through Date</Text>
            <Text style={s.metaValue}>{fmtDate(waiver.through_date)}</Text>
          </View>
          <View style={s.metaRow}>
            <Text style={s.metaLabel}>Direction</Text>
            <Text style={s.metaValue}>{waiver.direction === 'from_sub' ? 'Sub → GC' : 'GC → Owner'}</Text>
          </View>
        </View>

        <Text style={s.bodyText}>{bodyTextFor(waiver)}</Text>

        {/* Notice block — uniform language across types */}
        <Text style={s.bodyText}>
          {waiver.waiver_type?.startsWith('unconditional_')
            ? 'NOTICE: This document waives rights unconditionally and states that you have been paid for giving up those rights. If you have not been paid, use a conditional release form.'
            : 'NOTICE: This document waives the claimant\'s lien, stop payment notice, and payment bond rights effective on receipt of payment. A person should NOT rely on this document unless satisfied that the claimant has received payment.'}
        </Text>

        <View style={s.signBlock}>
          <View style={s.sigRow}>
            <View style={{ flex: 2 }}>
              <View style={{ ...s.sigField, marginRight: 0, height: 28 }} />
              <Text style={s.sigLabel}>Signature</Text>
            </View>
            <View style={{ width: 16 }} />
            <View style={{ flex: 1 }}>
              <View style={{ ...s.sigField, marginRight: 0, height: 28 }}>
                <Text style={{ fontSize: 10, paddingTop: 6 }}>{waiver.signed_at ? fmtDate(waiver.signed_at) : ''}</Text>
              </View>
              <Text style={s.sigLabel}>Date</Text>
            </View>
          </View>
          <View style={s.sigRow}>
            <View style={{ flex: 1 }}>
              <View style={{ ...s.sigField, marginRight: 0 }}>
                <Text style={{ fontSize: 10, paddingTop: 6 }}>{waiver.signer_name || ''}</Text>
              </View>
              <Text style={s.sigLabel}>Printed Name</Text>
            </View>
            <View style={{ width: 16 }} />
            <View style={{ flex: 1 }}>
              <View style={{ ...s.sigField, marginRight: 0 }}>
                <Text style={{ fontSize: 10, paddingTop: 6 }}>{waiver.signer_title || ''}</Text>
              </View>
              <Text style={s.sigLabel}>Title</Text>
            </View>
          </View>
          <View style={{ ...s.sigRow, marginBottom: 0 }}>
            <View style={{ flex: 1 }}>
              <View style={{ ...s.sigField, marginRight: 0 }}>
                <Text style={{ fontSize: 10, paddingTop: 6 }}>{waiver.signer_company || ''}</Text>
              </View>
              <Text style={s.sigLabel}>Company</Text>
            </View>
          </View>
        </View>

        <Text style={s.smallNote}>
          This is a generic statutory-style template. Some states (California, Texas, Florida, New York,
          Mississippi, others) require specific statutory forms with exact statutory language. Consult
          counsel to confirm enforceability in the applicable jurisdiction.
        </Text>
      </Page>
    </Document>
  );
}
