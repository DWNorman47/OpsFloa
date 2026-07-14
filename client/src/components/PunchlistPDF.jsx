import React from 'react';
import { Document, Page, Text, View, StyleSheet, PDFDownloadLink } from '@react-pdf/renderer';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';

const pdf = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 9, color: '#1a1a1a', padding: '40 48 48 48' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, paddingBottom: 14, borderBottom: '2 solid #059669' },
  companyName: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#059669', marginBottom: 2 },
  reportTitle: { fontSize: 11, color: '#6b7280', letterSpacing: 1, textTransform: 'uppercase' },
  headerMeta: { fontSize: 9, color: '#374151', marginBottom: 2, textAlign: 'right' },
  // Summary bar
  summaryBar: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  summaryCard: { flex: 1, backgroundColor: '#f0fdf4', borderRadius: 6, padding: '8 10' },
  summaryLabel: { fontSize: 7, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  summaryValue: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: '#059669' },
  // Table
  table: { borderRadius: 4 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f0fdf4', padding: '5 8', borderRadius: '4 4 0 0' },
  tableRow: { flexDirection: 'row', padding: '6 8', borderBottom: '1 solid #f3f4f6' },
  tableRowAlt: { flexDirection: 'row', padding: '6 8', borderBottom: '1 solid #f3f4f6', backgroundColor: '#fafafa' },
  thText: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#166534', textTransform: 'uppercase', letterSpacing: 0.5 },
  tdText: { fontSize: 9, color: '#374151' },
  tdDesc: { fontSize: 8, color: '#6b7280', marginTop: 2 },
  colTitle: { flex: 3 },
  colProject: { flex: 2 },
  colPriority: { flex: 1, textAlign: 'center' },
  colStatus: { flex: 1, textAlign: 'center' },
  colAssigned: { flex: 2 },
  // Footer
  footer: { position: 'absolute', bottom: 24, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTop: '1 solid #e5e7eb', paddingTop: 6 },
  footerText: { fontSize: 7, color: '#6b7280' },
});

export function PunchlistDocument({ items, companyName, t = {}, language }) {
  const locale = langToLocale(language);
  const PRIORITY_LABEL = { high: t.priorityHigh, normal: t.priorityNormal, low: t.priorityLow };
  const STATUS_LABEL = {
    open: t.statusOpen,
    in_progress: t.statusInProgress || 'In Progress',
    resolved: t.statusDone,
    done: t.statusDone,
    verified: t.statusVerified,
  };
  const openCount = items.filter(i => i.status === 'open').length;
  const inProgressCount = items.filter(i => i.status === 'in_progress').length;
  const doneCount = items.filter(i => i.status === 'resolved' || i.status === 'done').length;
  const verifiedCount = items.filter(i => i.status === 'verified').length;
  const dateStr = new Date().toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <Document>
      <Page size="LETTER" style={pdf.page}>
        {/* Header */}
        <View style={pdf.headerRow} fixed>
          <View>
            <Text style={pdf.companyName}>{companyName || t.pdfPunchlistReport}</Text>
            <Text style={pdf.reportTitle}>{t.pdfPunchlistReport}</Text>
          </View>
          <View>
            <Text style={pdf.headerMeta}>{t.pdfGenerated}{dateStr}</Text>
            <Text style={pdf.headerMeta}>{items.length !== 1 ? t.pdfItemCountPlural.replace('{n}', items.length) : t.pdfItemCount.replace('{n}', items.length)}</Text>
          </View>
        </View>

        {/* Summary */}
        <View style={pdf.summaryBar}>
          <View style={pdf.summaryCard}>
            <Text style={pdf.summaryLabel}>{t.statusOpen}</Text>
            <Text style={pdf.summaryValue}>{openCount}</Text>
          </View>
          <View style={pdf.summaryCard}>
            <Text style={pdf.summaryLabel}>{t.statusInProgress || 'In Progress'}</Text>
            <Text style={pdf.summaryValue}>{inProgressCount}</Text>
          </View>
          <View style={pdf.summaryCard}>
            <Text style={pdf.summaryLabel}>{t.statusDone}</Text>
            <Text style={pdf.summaryValue}>{doneCount}</Text>
          </View>
          <View style={pdf.summaryCard}>
            <Text style={pdf.summaryLabel}>{t.statusVerified}</Text>
            <Text style={pdf.summaryValue}>{verifiedCount}</Text>
          </View>
          <View style={pdf.summaryCard}>
            <Text style={pdf.summaryLabel}>{t.totalLabel}</Text>
            <Text style={pdf.summaryValue}>{items.length}</Text>
          </View>
        </View>

        {/* Table */}
        <View style={pdf.table}>
          <View style={pdf.tableHeader}>
            <Text style={{ ...pdf.thText, ...pdf.colTitle }}>{t.pdfItemHeader}</Text>
            <Text style={{ ...pdf.thText, ...pdf.colProject }}>Project</Text>
            <Text style={{ ...pdf.thText, ...pdf.colPriority }}>{t.priorityField}</Text>
            <Text style={{ ...pdf.thText, ...pdf.colStatus }}>{t.statusLabel}</Text>
            <Text style={{ ...pdf.thText, ...pdf.colAssigned }}>{t.pdfAssignedTo}</Text>
          </View>
          {items.map((item, i) => (
            <View key={item.id} style={i % 2 === 0 ? pdf.tableRow : pdf.tableRowAlt}>
              <View style={pdf.colTitle}>
                <Text style={pdf.tdText}>{item.title}</Text>
                {item.description ? <Text style={pdf.tdDesc}>{item.description}</Text> : null}
                {item.location ? <Text style={{ ...pdf.tdDesc, color: '#6b7280' }}>📍 {item.location}</Text> : null}
              </View>
              <Text style={{ ...pdf.tdText, ...pdf.colProject }}>{item.project_name || '—'}</Text>
              <Text style={{ ...pdf.tdText, ...pdf.colPriority }}>{PRIORITY_LABEL[item.priority] || item.priority}</Text>
              <Text style={{ ...pdf.tdText, ...pdf.colStatus }}>{STATUS_LABEL[item.status] || item.status}</Text>
              <Text style={{ ...pdf.tdText, ...pdf.colAssigned }}>{item.assigned_to_name || '—'}</Text>
            </View>
          ))}
        </View>

        {/* Footer */}
        <View style={pdf.footer} fixed>
          <Text style={pdf.footerText}>{companyName} — {t.pdfPunchlistReport} — {dateStr}</Text>
          <Text style={pdf.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export function PunchlistPDFButton({ items, companyName, style }) {
  const t = useT();
  const { user } = useAuth();
  const fileName = `punchlist-${new Date().toLocaleDateString('en-CA')}.pdf`;
  return (
    <PDFDownloadLink
      document={<PunchlistDocument items={items} companyName={companyName} t={t} language={user?.language} />}
      fileName={fileName}
      style={style}
    >
      {({ loading }) => loading ? t.pdfPreparingBtn : t.pdfExportBtn}
    </PDFDownloadLink>
  );
}
