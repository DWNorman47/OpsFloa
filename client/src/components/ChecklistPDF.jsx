import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { langToLocale } from '../utils';

// Shared PDF for both checklist surfaces: Checklist Reports (a filled safety/required
// checklist submission) and Daily Checklist history (one completed day). The caller
// normalizes its rows into `items` and builds `meta` label/value pairs, so this stays
// generic. Loaded lazily (import('@react-pdf/renderer') + import('./ChecklistPDF')) so
// react-pdf never ships in the main bundle.
const pdf = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 9, color: '#1a1a1a', padding: '40 48 48 48' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, paddingBottom: 12, borderBottom: '2 solid #1a56db' },
  companyName: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#1a56db', marginBottom: 2 },
  reportTitle: { fontSize: 10, color: '#6b7280', letterSpacing: 1, textTransform: 'uppercase' },
  headerMeta: { fontSize: 9, color: '#374151', textAlign: 'right' },
  docTitle: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#111827', marginBottom: 10 },
  // Meta block (label / value pairs)
  metaBox: { backgroundColor: '#f9fafb', border: '1 solid #eef0f2', borderRadius: 6, padding: '8 10', marginBottom: 14 },
  metaRow: { flexDirection: 'row', marginBottom: 2 },
  metaLabel: { width: 110, fontSize: 8, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 },
  metaValue: { flex: 1, fontSize: 9, color: '#111827' },
  // Items
  itemList: { display: 'flex', flexDirection: 'column', gap: 6 },
  itemRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingBottom: 6, borderBottom: '1 solid #f3f4f6' },
  // Latin-safe marks only ("Yes"/"No"/"—"/"•") — the built-in Helvetica has no ✓/✗/○ glyphs.
  mark: { fontSize: 9, fontFamily: 'Helvetica-Bold', width: 30 },
  itemBody: { flex: 1 },
  itemText: { fontSize: 10, color: '#111827', lineHeight: 1.4 },
  answer: { fontFamily: 'Helvetica-Bold', color: '#111827' },
  who: { fontSize: 8, color: '#6b7280', marginTop: 1 },
  muted: { fontSize: 9, color: '#6b7280' },
  // Notes
  notesBox: { marginTop: 12 },
  sectionLabel: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  notesText: { fontSize: 9, color: '#374151', lineHeight: 1.6 },
  // Footer
  footer: { position: 'absolute', bottom: 24, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTop: '1 solid #e5e7eb', paddingTop: 6 },
  footerText: { fontSize: 7, color: '#6b7280' },
});

// items: [{ mark: '✓'|'✗'|'○'|'✎', done: bool, label, answer?: string, who?: string }]
// meta:  [{ label, value }]
export function ChecklistDocument({ companyName, title, subtitle, meta = [], items = [], notes, notesLabel, noItemsLabel, t, language }) {
  const locale = langToLocale(language);
  const dateStr = new Date().toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  const heading = companyName || title || subtitle;

  return (
    <Document>
      <Page size="LETTER" style={pdf.page}>
        <View style={pdf.headerRow} fixed>
          <View>
            <Text style={pdf.companyName}>{heading}</Text>
            <Text style={pdf.reportTitle}>{subtitle}</Text>
          </View>
          <View>
            <Text style={pdf.headerMeta}>{t.pdfGenerated}{dateStr}</Text>
          </View>
        </View>

        {title ? <Text style={pdf.docTitle}>{title}</Text> : null}

        {meta.length > 0 && (
          <View style={pdf.metaBox}>
            {meta.map((m, i) => (
              <View key={i} style={pdf.metaRow}>
                <Text style={pdf.metaLabel}>{m.label}</Text>
                <Text style={pdf.metaValue}>{m.value}</Text>
              </View>
            ))}
          </View>
        )}

        {items.length === 0 ? (
          <Text style={pdf.muted}>{noItemsLabel}</Text>
        ) : (
          <View style={pdf.itemList}>
            {items.map((it, i) => (
              <View key={i} style={pdf.itemRow} wrap={false}>
                <Text style={{ ...pdf.mark, color: it.done ? '#059669' : '#9ca3af' }}>{it.mark}</Text>
                <View style={pdf.itemBody}>
                  <Text style={pdf.itemText}>
                    {it.label}
                    {it.answer ? <Text>: <Text style={pdf.answer}>{it.answer}</Text></Text> : null}
                  </Text>
                  {it.who ? <Text style={pdf.who}>{it.who}</Text> : null}
                </View>
              </View>
            ))}
          </View>
        )}

        {notes ? (
          <View style={pdf.notesBox}>
            <Text style={pdf.sectionLabel}>{notesLabel}</Text>
            <Text style={pdf.notesText}>{notes}</Text>
          </View>
        ) : null}

        <View style={pdf.footer} fixed>
          <Text style={pdf.footerText}>{heading} — {subtitle} — {dateStr}</Text>
          <Text style={pdf.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
