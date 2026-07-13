/**
 * WH-347 Certified Payroll PDF.
 *
 * Not a pixel-perfect clone of the DOL form — those are NOT required; DOL
 * accepts any report containing the equivalent fields ("in a form acceptable
 * to the contracting agency"). This layout mirrors the WH-347 columns so
 * auditors familiar with the form can read it without effort:
 *
 *   Page 1 — Payroll table
 *     Row block per worker: name, SSN last-4, classification, daily hours
 *       (straight / OT sub-rows), weekly total, pay rate, gross, fringes.
 *   Page 2 — Statement of Compliance
 *     Full WH-347 declaration text + signer name/title/date.
 */

import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function fmtHours(h) {
  if (!h || h === 0) return '';
  return h.toFixed(2);
}
function fmtMoney(n) {
  return n == null ? '' : n.toFixed(2);
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const styles = StyleSheet.create({
  page: { padding: 28, fontSize: 8, fontFamily: 'Helvetica' },
  h1:   { fontSize: 13, fontWeight: 'bold', textAlign: 'center', marginBottom: 4 },
  h2:   { fontSize: 9, textAlign: 'center', marginBottom: 12, color: '#555' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  metaCell: { flex: 1, paddingRight: 8 },
  metaLabel: { fontSize: 7, color: '#666', marginBottom: 1 },
  metaValue: { fontSize: 9, fontWeight: 'bold' },

  table:     { borderTopWidth: 0.7, borderLeftWidth: 0.7, borderColor: '#333' },
  headerRow: { flexDirection: 'row', backgroundColor: '#eef2f7', borderBottomWidth: 0.7, borderColor: '#333' },
  cell:      { padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7, textAlign: 'center', justifyContent: 'center' },
  cellName:  { width: 88,  padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 8 },
  cellSsn:   { width: 32, padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7, textAlign: 'center' },
  cellClass: { width: 70, padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7 },
  cellOtSt:  { width: 18, padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7, textAlign: 'center' },
  cellDay:   { width: 26, padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7, textAlign: 'center' },
  cellTotal: { width: 28, padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7, textAlign: 'center' },
  cellRate:  { width: 28, padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7, textAlign: 'right' },
  cellGross: { width: 40, padding: 2, borderRightWidth: 0.7, borderColor: '#333', fontSize: 7, textAlign: 'right' },
  workerRow: { flexDirection: 'row', borderBottomWidth: 0.7, borderColor: '#333', backgroundColor: '#fff' },
  workerRowAlt: { flexDirection: 'row', borderBottomWidth: 0.7, borderColor: '#333', backgroundColor: '#f8fafc' },
  compliance: { marginTop: 24 },
  complianceTitle: { fontSize: 12, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
  complianceP: { fontSize: 9, lineHeight: 1.4, marginBottom: 8 },
  sigBox: { marginTop: 24, flexDirection: 'row', justifyContent: 'space-between' },
  sigLine: { borderBottomWidth: 0.5, borderColor: '#333', marginTop: 24, marginBottom: 2 },
  sigLabel: { fontSize: 8, color: '#555' },
  sigVal: { fontSize: 10, fontWeight: 'bold', marginTop: 2 },
  sigDate: { fontSize: 8, color: '#333', marginTop: 2 },
  footer: { marginTop: 16, fontSize: 7, color: '#777', textAlign: 'center' },
});

export default function CertifiedPayrollPDF({ report, settings }) {
  if (!report) return null;
  const { contractor, project, week_start, week_end, workers = [], signature } = report;
  const workLabel = settings?.label_work || 'Work';
  const workerLabel = settings?.label_worker || 'Team Member';

  return (
    <Document>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        <Text style={styles.h1}>PAYROLL</Text>
        <Text style={styles.h2}>For Contractor's Optional Use (See Form WH-347 Instructions)</Text>

        <View style={styles.metaRow}>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>NAME OF CONTRACTOR</Text>
            <Text style={styles.metaValue}>{contractor}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>{workLabel.toUpperCase()}</Text>
            <Text style={styles.metaValue}>{project || `All ${workLabel.toLowerCase()}`}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>WEEK ENDING</Text>
            <Text style={styles.metaValue}>{fmtDate(week_end)}</Text>
          </View>
          <View style={styles.metaCell}>
            <Text style={styles.metaLabel}>PERIOD</Text>
            <Text style={styles.metaValue}>{fmtDate(week_start)} – {fmtDate(week_end)}</Text>
          </View>
        </View>

        <View style={styles.table}>
          {/* Header */}
          <View style={styles.headerRow}>
            <Text style={styles.cellName}>NAME OF {workerLabel.toUpperCase()}</Text>
            <Text style={styles.cellSsn}>SSN</Text>
            <Text style={styles.cellClass}>CLASSIFICATION</Text>
            <Text style={styles.cellOtSt}>O/S</Text>
            {DAY_LABELS.map(l => <Text key={l} style={styles.cellDay}>{l}</Text>)}
            <Text style={styles.cellTotal}>TOTAL</Text>
            <Text style={styles.cellRate}>RATE</Text>
            <Text style={styles.cellGross}>GROSS</Text>
          </View>

          {/* Worker rows — straight / OT sub-rows */}
          {workers.map((w, i) => (
            <WorkerBlock key={w.worker_id} w={w} alt={i % 2 === 1} />
          ))}
        </View>

        <Text style={styles.footer}>Generated by OpsFloa · {new Date().toLocaleString()}</Text>
      </Page>

      {/* Statement of Compliance */}
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.complianceTitle}>Statement of Compliance</Text>
        <Text style={styles.complianceP}>
          Date: {signature ? new Date(signature.signed_at).toLocaleDateString() : '____________'}
        </Text>
        <Text style={styles.complianceP}>
          I, <Text style={{ fontWeight: 'bold' }}>{signature?.signer_name || '_________________________'}</Text>
          {signature?.signer_title ? ` (${signature.signer_title})` : ''}, do hereby state:
        </Text>
        <Text style={styles.complianceP}>
          (1) That I pay or supervise the payment of the persons employed by {contractor} on the{' '}
          {project || 'referenced project'}; that during the payroll period commencing on {fmtDate(week_start)} and
          ending on {fmtDate(week_end)}, all persons employed on said project have been paid the full weekly wages
          earned; that no rebates have been or will be made either directly or indirectly to or on behalf of said
          contractor from the full weekly wages earned by any person; and that no deductions have been made either
          directly or indirectly from the full wages earned by any person other than permissible deductions as defined
          in Regulations, Part 3 (29 CFR Subtitle A).
        </Text>
        <Text style={styles.complianceP}>
          (2) That any payrolls otherwise under this contract required to be submitted for the above period are
          correct and complete; that the wage rates for laborers or mechanics contained therein are not less than the
          applicable wage rates contained in any wage determination incorporated into the contract; that the
          classifications set forth therein for each laborer or mechanic conform with the work performed.
        </Text>
        <Text style={styles.complianceP}>
          (3) That any apprentices employed in the above period are duly registered in a bona fide apprenticeship
          program registered with a State apprenticeship agency recognized by the Bureau of Apprenticeship and
          Training, United States Department of Labor.
        </Text>
        <Text style={styles.complianceP}>
          (4) That fringe benefits have been paid as specified in the contract.
        </Text>

        <View style={styles.sigBox}>
          <View style={{ width: 260 }}>
            <View style={styles.sigLine} />
            <Text style={styles.sigLabel}>Signature</Text>
            {signature && <Text style={{ ...styles.sigVal, fontFamily: 'Times-Italic' }}>{signature.signer_name}</Text>}
          </View>
          <View style={{ width: 220 }}>
            <View style={styles.sigLine} />
            <Text style={styles.sigLabel}>Title</Text>
            {signature?.signer_title && <Text style={styles.sigVal}>{signature.signer_title}</Text>}
          </View>
          <View style={{ width: 120 }}>
            <View style={styles.sigLine} />
            <Text style={styles.sigLabel}>Date</Text>
            {signature && <Text style={styles.sigDate}>{new Date(signature.signed_at).toLocaleDateString()}</Text>}
          </View>
        </View>

        {!signature && (
          <Text style={{ ...styles.complianceP, marginTop: 24, fontStyle: 'italic', color: '#b91c1c' }}>
            Not yet signed. Sign the Statement of Compliance in OpsFloa before filing this report.
          </Text>
        )}

        <Text style={styles.footer}>Generated by OpsFloa · {new Date().toLocaleString()}</Text>
      </Page>
    </Document>
  );
}

function WorkerBlock({ w, alt }) {
  // Two sub-rows per worker: straight (S) and overtime (O). Current data
  // doesn't split OT from straight in the /certified-payroll response;
  // until that's done we put all hours on the S row and leave O blank.
  return (
    <>
      <View style={alt ? styles.workerRowAlt : styles.workerRow}>
        <View style={styles.cellName}>
          <Text style={{ fontWeight: 'bold' }}>{w.worker_name}</Text>
          {w.fringe_total_per_hour > 0 && (
            <Text style={{ fontSize: 6, color: '#666', marginTop: 1 }}>
              Fringe: ${w.fringe_total_per_hour.toFixed(4)}/hr
            </Text>
          )}
        </View>
        <Text style={styles.cellSsn}>{w.ssn_last4 ? `***-**-${w.ssn_last4}` : ''}</Text>
        <Text style={styles.cellClass}>{w.classification || ''}</Text>
        <Text style={styles.cellOtSt}>S</Text>
        {DAY_KEYS.map(k => <Text key={k} style={styles.cellDay}>{fmtHours(w.regular_days[k] + (w.prevailing_days[k] || 0))}</Text>)}
        <Text style={styles.cellTotal}>{fmtHours(w.total)}</Text>
        <Text style={styles.cellRate}>${fmtMoney(w.rate)}</Text>
        <Text style={styles.cellGross}>${fmtMoney(w.gross_pay)}</Text>
      </View>
      <View style={alt ? styles.workerRowAlt : styles.workerRow}>
        <View style={styles.cellName}><Text style={{ fontSize: 6, color: '#666' }}>{' '}</Text></View>
        <Text style={styles.cellSsn}> </Text>
        <Text style={styles.cellClass}> </Text>
        <Text style={styles.cellOtSt}>O</Text>
        {DAY_KEYS.map(k => <Text key={k} style={styles.cellDay}> </Text>)}
        <Text style={styles.cellTotal}> </Text>
        <Text style={styles.cellRate}> </Text>
        <Text style={styles.cellGross}> </Text>
      </View>
    </>
  );
}
