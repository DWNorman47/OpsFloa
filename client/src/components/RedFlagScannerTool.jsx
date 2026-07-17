import { renderAiMarkdown } from './aiMarkdown';
import React, { useState } from 'react';
import api from '../api';
import AiUsageBadge from './AiUsageBadge';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function RedFlagScannerTool() {
  const [doc, setDoc] = useState(null); // { name, text, pages, chars }
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [report, setReport] = useState('');
  const [clipped, setClipped] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [usageRefresh, setUsageRefresh] = useState(0);

  const openFile = async file => {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { setError('Please choose a PDF file.'); return; }
    setError(''); setLoadingDoc(true); setReport(''); setClipped(false); setDoc(null);
    try {
      const pdfBase64 = await fileToBase64(file);
      const { data } = await api.post('/office/extract', { pdfBase64 }, { suppressToast: true });
      setDoc({ name: file.name, text: data.text, pages: data.pages, chars: data.chars });
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not read that PDF.');
    } finally {
      setLoadingDoc(false);
    }
  };

  // Scanning is a separate click rather than firing on upload: it spends a
  // metered AI call, and the doc bar lets you confirm you grabbed the right
  // file (and re-scan) before spending one.
  const scan = async () => {
    if (!doc || scanning) return;
    setError(''); setScanning(true); setReport('');
    try {
      const { data } = await api.post('/office/scan-contract', { context: doc.text }, { suppressToast: true });
      setReport(data.result || '');
      setClipped(!!data.clipped);
      setUsageRefresh(n => n + 1);
    } catch (e) {
      setError(e?.response?.data?.error || 'The scan failed. Please try again.');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <AiUsageBadge refreshSignal={usageRefresh} />
      <p style={styles.hint}>
        Open a subcontract, purchase order, or spec section and get back the terms that carry real
        money — pay-if-paid, retainage, notice windows, liquidated damages, indemnity, and the rest
        — ranked worst first, each with the actual clause quoted and what to ask for instead.
      </p>

      {!doc && (
        <label style={{ ...styles.drop, ...(loadingDoc ? styles.dropBusy : null) }}>
          <input type="file" accept="application/pdf" style={{ display: 'none' }}
            onChange={e => { openFile(e.target.files[0]); e.target.value = ''; }} disabled={loadingDoc} />
          <span style={styles.dropTitle}>{loadingDoc ? 'Reading PDF…' : 'Choose a contract PDF'}</span>
          <span style={styles.dropSub}>Text-based PDFs only — a scanned photo of a contract can&rsquo;t be read.</span>
        </label>
      )}

      {doc && (
        <>
          <div style={styles.docBar}>
            <span style={styles.docName}>{doc.name}</span>
            <span style={styles.docMeta}>{doc.pages} pages · {doc.chars.toLocaleString()} characters</span>
            <label style={styles.link}>
              <input type="file" accept="application/pdf" style={{ display: 'none' }}
                onChange={e => { openFile(e.target.files[0]); e.target.value = ''; }} />
              Open a different PDF
            </label>
          </div>

          <button onClick={scan} disabled={scanning} style={styles.scanBtn}>
            {scanning ? 'Reading the fine print…' : report ? 'Scan again' : 'Scan for red flags'}
          </button>
        </>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {/* A scanner that silently reviewed half a contract and reported "clean"
          would be worse than no scanner, so a truncated read says so loudly. */}
      {clipped && (
        <div style={styles.warn}>
          <b>Only part of this contract was reviewed.</b> It&rsquo;s longer than the scanner reads in one
          pass, so anything past roughly the first 120,000 characters was not looked at. Treat the
          findings below as covering the front of the document only.
        </div>
      )}

      {report && (
        <div style={styles.report}>{renderAiMarkdown(report)}</div>
      )}

      {report && (
        <p style={styles.foot}>
          A reading aid, not legal advice — it can miss things, and it only sees this one document.
          Have a lawyer review anything that matters.
        </p>
      )}
    </div>
  );
}

const styles = {
  hint: { color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' },
  drop: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer',
    border: '2px dashed #cbd5e1', borderRadius: 12, padding: '32px 20px', textAlign: 'center', background: '#f8fafc',
  },
  dropBusy: { opacity: 0.6, cursor: 'default' },
  dropTitle: { fontSize: 16, fontWeight: 700, color: '#0f172a' },
  dropSub: { fontSize: 13, color: '#94a3b8' },
  docBar: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 10, background: '#f8fafc', marginBottom: 12,
  },
  docName: { fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 },
  docMeta: { color: '#64748b', fontSize: 12.5, flex: 1 },
  link: { color: '#2563eb', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  scanBtn: {
    width: '100%', padding: '12px 16px', fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
    color: '#fff', background: '#b91c1c', border: 'none', borderRadius: 10, cursor: 'pointer',
  },
  error: {
    marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13.5,
    background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
  },
  warn: {
    marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13.5, lineHeight: 1.6,
    background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
  },
  report: {
    marginTop: 16, padding: '4px 16px 12px', fontSize: 14, lineHeight: 1.6, color: '#0f172a',
    border: '1px solid #e2e8f0', borderRadius: 12, background: '#fff',
  },
  foot: { color: '#94a3b8', fontSize: 12.5, lineHeight: 1.6, margin: '10px 2px 0' },
};
