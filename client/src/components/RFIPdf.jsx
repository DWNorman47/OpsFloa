import React from 'react';
import {
  Document, Page, Text, View, StyleSheet, PDFDownloadLink,
} from '@react-pdf/renderer';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';

const STATUS_COLORS = {
  open: { bg: '#fef3c7', text: '#92400e' },
  answered: { bg: '#d1fae5', text: '#065f46' },
  closed: { bg: '#f3f4f6', text: '#374151' },
};

const pdf = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 9, color: '#1a1a1a', padding: '40 48 48 48' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, paddingBottom: 14, borderBottom: '2 solid var(--ops-page-accent)' },
  companyName: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: 'var(--ops-page-accent)', marginBottom: 2 },
  reportTitle: { fontSize: 11, color: '#6b7280', letterSpacing: 1, textTransform: 'uppercase' },
  headerRight: { alignItems: 'flex-end' },
  headerMeta: { fontSize: 9, color: '#374151', marginBottom: 2 },
  headerMetaBold: { fontFamily: 'Helvetica-Bold' },
  statusBadge: { marginTop: 6, padding: '3 8', borderRadius: 4, alignSelf: 'flex-end' },
  statusText: { fontSize: 8, fontFamily: 'Helvetica-Bold', letterSpacing: 0.5 },
  section: { marginBottom: 16 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  sectionTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: 'var(--ops-page-accent)', textTransform: 'uppercase', letterSpacing: 0.8 },
  sectionLine: { flex: 1, height: 1, backgroundColor: '#dbeafe', marginLeft: 8 },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16, backgroundColor: '#f9fafb', borderRadius: 6, padding: '10 12' },
  metaItem: { width: '47%' },
  metaLabel: { fontSize: 7, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  metaValue: { fontSize: 9, color: '#1a1a1a', fontFamily: 'Helvetica-Bold' },
  metaValueLight: { fontSize: 9, color: '#374151' },
  textBlock: { fontSize: 9, color: '#374151', lineHeight: 1.6, padding: '8 10', backgroundColor: '#f9fafb', borderRadius: 4, borderLeft: '3 solid #dbeafe' },
  responseBlock: { fontSize: 9, color: '#374151', lineHeight: 1.6, padding: '8 10', backgroundColor: '#f0fdf4', borderRadius: 4, borderLeft: '3 solid #86efac' },
  footer: { position: 'absolute', bottom: 24, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTop: '1 solid #e5e7eb', paddingTop: 6 },
  footerText: { fontSize: 7, color: '#6b7280' },
  rfiNumber: { fontSize: 28, fontFamily: 'Helvetica-Bold', color: 'var(--ops-page-accent)' },
});

function SectionHeader({ title }) {
  return (
    <View style={pdf.sectionHeader}>
      <Text style={pdf.sectionTitle}>{title}</Text>
      <View style={pdf.sectionLine} />
    </View>
  );
}

export function RFIDocument({ rfi, companyName, t = {}, language }) {
  const locale = langToLocale(language);
  const statusColors = STATUS_COLORS[rfi.status] || STATUS_COLORS.open;
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <Document>
      <Page size="LETTER" style={pdf.page}>
        {/* Header */}
        <View style={pdf.headerRow}>
          <View>
            <Text style={pdf.companyName}>{companyName}</Text>
            <Text style={pdf.reportTitle}>{t.pdfRequestForInfo}</Text>
          </View>
          <View style={pdf.headerRight}>
            <Text style={pdf.rfiNumber}>RFI #{rfi.rfi_number}</Text>
            <Text style={pdf.headerMeta}>{rfi.project_name || 'No project'}</Text>
            <View style={[pdf.statusBadge, { backgroundColor: statusColors.bg }]}>
              <Text style={[pdf.statusText, { color: statusColors.text }]}>
                {rfi.status.toUpperCase()}
              </Text>
            </View>
          </View>
        </View>

        {/* Meta grid */}
        <View style={pdf.section}>
          <View style={pdf.metaGrid}>
            <View style={pdf.metaItem}>
              <Text style={pdf.metaLabel}>{t.submittedBy}</Text>
              <Text style={pdf.metaValue}>{rfi.submitted_by || rfi.created_by_name || '—'}</Text>
            </View>
            <View style={pdf.metaItem}>
              <Text style={pdf.metaLabel}>{t.directedTo}</Text>
              <Text style={pdf.metaValue}>{rfi.directed_to || '—'}</Text>
            </View>
            <View style={pdf.metaItem}>
              <Text style={pdf.metaLabel}>{t.dateSubmitted}</Text>
              <Text style={pdf.metaValueLight}>{fmtDate(rfi.date_submitted)}</Text>
            </View>
            <View style={pdf.metaItem}>
              <Text style={pdf.metaLabel}>{t.pdfDateDue}</Text>
              <Text style={pdf.metaValueLight}>{fmtDate(rfi.date_due)}</Text>
            </View>
          </View>
        </View>

        {/* Subject */}
        <View style={pdf.section}>
          <SectionHeader title={t.subjectField} />
          <Text style={[pdf.textBlock, { fontFamily: 'Helvetica-Bold', fontSize: 10 }]}>{rfi.subject}</Text>
        </View>

        {/* Description */}
        {rfi.description ? (
          <View style={pdf.section}>
            <SectionHeader title={t.pdfDescriptionQuestion} />
            <Text style={pdf.textBlock}>{rfi.description}</Text>
          </View>
        ) : null}

        {/* Response */}
        {rfi.response ? (
          <View style={pdf.section}>
            <SectionHeader title={t.rfiResponse} />
            <Text style={pdf.responseBlock}>{rfi.response}</Text>
          </View>
        ) : null}

        {/* Footer */}
        <View style={pdf.footer} fixed>
          <Text style={pdf.footerText}>{companyName} · RFI #{rfi.rfi_number}</Text>
          <Text style={pdf.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

const linkStyle = {
  display: 'inline-block',
  background: '#eff6ff',
  color: 'var(--ops-page-accent)',
  border: '1px solid #bfdbfe',
  padding: '6px 14px',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  textDecoration: 'none',
  cursor: 'pointer',
};

export function RFIDownloadLink({ rfi, companyName }) {
  const t = useT();
  const { user } = useAuth();
  const fileName = `RFI-${rfi.rfi_number}-${(rfi.subject || 'rfi').replace(/[^a-z0-9]/gi, '-').toLowerCase()}.pdf`;
  return (
    <PDFDownloadLink
      document={<RFIDocument rfi={rfi} companyName={companyName} t={t} language={user?.language} />}
      fileName={fileName}
      style={linkStyle}
    >
      {({ loading }) => (loading ? t.pdfPreparingShort : t.pdfPDFLink)}
    </PDFDownloadLink>
  );
}
