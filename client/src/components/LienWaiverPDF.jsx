// Lien waiver PDF renderer using @react-pdf/renderer — same pattern as
// ProjectBillPDF. Dispatches by `waiver.state` to a state-aware
// template (CA / TX / FL / NY) or a generic statutory-style template
// for anything else. The state-aware templates use the canonical title
// and reference the statutory section that governs the form (e.g.
// Civil Code §8132); the substantive body language remains conditional-
// vs-unconditional aware since that's the legally-binding distinction.
//
// Disclaimer: these templates are statutory-FLAVORED — they reflect the
// structure and references of the state-specific forms, but the exact
// statutory text may differ. The PDF footer always recommends consulting
// counsel before issuing waivers in a binding context.

import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

const TYPE_TITLES = {
  conditional_progress:   'Conditional Waiver and Release on Progress Payment',
  unconditional_progress: 'Unconditional Waiver and Release on Progress Payment',
  conditional_final:      'Conditional Waiver and Release on Final Payment',
  unconditional_final:    'Unconditional Waiver and Release on Final Payment',
};

// State-specific registry. Each entry overrides the generic title /
// statutory reference / lead notice / additional body language / and
// optionally appends a notary block. Add a state to this map to
// support it; missing values fall back to the generic template.
const STATE_CONFIGS = {
  CA: {
    titleOverride: {
      conditional_progress:   'Conditional Waiver and Release on Progress Payment (Cal. Civ. Code §8132)',
      unconditional_progress: 'Unconditional Waiver and Release on Progress Payment (Cal. Civ. Code §8134)',
      conditional_final:      'Conditional Waiver and Release on Final Payment (Cal. Civ. Code §8136)',
      unconditional_final:    'Unconditional Waiver and Release on Final Payment (Cal. Civ. Code §8138)',
    },
    statutoryRef: 'Cal. Civ. Code §§8132–8138',
    leadingNotice: 'IDENTIFICATION OF CLAIMANT: This release is required by California Civil Code Section 8132 et seq. and is governed by California law.',
    notary: false,
  },
  TX: {
    titleOverride: {
      conditional_progress:   'Conditional Waiver and Release on Progress Payment (Tex. Prop. Code §53.281)',
      unconditional_progress: 'Unconditional Waiver and Release on Progress Payment (Tex. Prop. Code §53.282)',
      conditional_final:      'Conditional Waiver and Release on Final Payment (Tex. Prop. Code §53.283)',
      unconditional_final:    'Unconditional Waiver and Release on Final Payment (Tex. Prop. Code §53.284)',
    },
    statutoryRef: 'Tex. Prop. Code Ch. 53 Subchapter L',
    leadingNotice: 'NOTICE TO CLAIMANT: This release is required by Texas Property Code Chapter 53, Subchapter L, and substantially follows the form prescribed therein. A claimant may not, by contract or otherwise, waive its right to file or enforce any lien except as provided by Subchapter L.',
    notary: false,
  },
  FL: {
    titleOverride: {
      conditional_progress:   'Conditional Waiver and Release of Lien Upon Progress Payment (Fla. Stat. §713.20)',
      unconditional_progress: 'Unconditional Waiver and Release of Lien Upon Progress Payment (Fla. Stat. §713.20)',
      conditional_final:      'Conditional Waiver and Release of Lien Upon Final Payment (Fla. Stat. §713.20)',
      unconditional_final:    'Unconditional Waiver and Release of Lien Upon Final Payment (Fla. Stat. §713.20)',
    },
    statutoryRef: 'Fla. Stat. §713.20',
    leadingNotice: 'NOTICE: This release is required by Florida Statute §713.20. Conditional releases are effective only on actual receipt of the funds described.',
    notary: false,
  },
  NY: {
    titleOverride: {
      conditional_progress:   'Conditional Partial Waiver and Release of Lien (N.Y. Lien Law §34)',
      unconditional_progress: 'Unconditional Partial Waiver and Release of Lien (N.Y. Lien Law §34)',
      conditional_final:      'Conditional Final Waiver and Release of Lien (N.Y. Lien Law §34)',
      unconditional_final:    'Unconditional Final Waiver and Release of Lien (N.Y. Lien Law §34)',
    },
    statutoryRef: 'N.Y. Lien Law §34',
    leadingNotice: 'NOTICE: To be effective under N.Y. Lien Law §34, this waiver must be in writing, executed by the lienor, and (for full effectiveness against subsequently-perfected liens) acknowledged before a notary public.',
    notary: true,
  },
};

function getStateConfig(state, waiverType) {
  if (!state) return null;
  const conf = STATE_CONFIGS[state];
  if (!conf) return null;
  return {
    title: conf.titleOverride[waiverType] || TYPE_TITLES[waiverType],
    statutoryRef: conf.statutoryRef,
    leadingNotice: conf.leadingNotice,
    notary: conf.notary,
  };
}

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
  const stateConf = getStateConfig(waiver.state, waiver.waiver_type);
  const title = stateConf?.title || TYPE_TITLES[waiver.waiver_type] || 'Lien Waiver';
  return (
    <Document>
      <Page size="LETTER" style={s.page}>
        <View style={s.header}>
          <Text style={s.title}>{title}</Text>
          {stateConf
            ? <Text style={s.subtitle}>{stateConf.statutoryRef}</Text>
            : waiver.state && <Text style={s.subtitle}>State: {waiver.state} (generic template — consult counsel for statutory form)</Text>}
        </View>

        {stateConf?.leadingNotice && (
          <View style={{ marginBottom: 14, padding: 10, backgroundColor: '#f9fafb', borderLeft: '2pt solid #1a56db' }}>
            <Text style={{ fontSize: 9, color: '#374151', lineHeight: 1.4 }}>
              {stateConf.leadingNotice}
            </Text>
          </View>
        )}

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

        {stateConf?.notary && (
          <View style={{ marginTop: 32, padding: 14, border: '0.5pt solid #1a1a1a' }}>
            <Text style={{ fontSize: 10, fontFamily: 'Times-Bold', textAlign: 'center', marginBottom: 12 }}>
              ACKNOWLEDGMENT
            </Text>
            <Text style={{ fontSize: 9, lineHeight: 1.5 }}>
              State of New York{'\n'}
              County of __________________________{'\n\n'}
              On the ______ day of __________________________, 20____, before me, the undersigned,
              personally appeared {waiver.signer_name || '__________________________'}, personally known to me
              or proved to me on the basis of satisfactory evidence to be the individual whose name is subscribed
              to the within instrument and acknowledged to me that they executed the same in their capacity, and
              that by their signature on the instrument, the individual, or the person upon behalf of which the
              individual acted, executed the instrument.
            </Text>
            <View style={{ flexDirection: 'row', marginTop: 18 }}>
              <View style={{ flex: 2 }}>
                <View style={{ borderBottom: '0.5pt solid #6b7280', height: 22 }} />
                <Text style={s.sigLabel}>Notary Public Signature</Text>
              </View>
              <View style={{ width: 16 }} />
              <View style={{ flex: 1 }}>
                <View style={{ borderBottom: '0.5pt solid #6b7280', height: 22 }} />
                <Text style={s.sigLabel}>Commission Expires</Text>
              </View>
            </View>
          </View>
        )}

        <Text style={s.smallNote}>
          {stateConf
            ? `This template reflects the structure of ${stateConf.statutoryRef}. The exact statutory text controls; consult counsel before issuing waivers in a binding context.`
            : 'This is a generic statutory-style template. Some states (California, Texas, Florida, New York, Mississippi, others) require specific statutory forms with exact statutory language. Consult counsel to confirm enforceability in the applicable jurisdiction.'}
        </Text>
      </Page>
    </Document>
  );
}
