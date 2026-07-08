import React, { useState } from 'react';
import api from '../api';
import AiUsageBadge from './AiUsageBadge';

// small, safe markdown-lite renderer (React escapes text, so no injection)
function inline(text, k) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? <strong key={`${k}-${i}`}>{p.slice(2, -2)}</strong> : p);
}
function renderAnswer(md) {
  const lines = String(md).split('\n');
  const out = [];
  let bullets = null;
  const flush = () => { if (bullets) { out.push(<ul key={`ul-${out.length}`} style={styles.ul}>{bullets}</ul>); bullets = null; } };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) { flush(); out.push(<div key={i} style={styles.h}>{line.replace(/^#{1,6}\s/, '')}</div>); }
    else if (/^[-*]\s+/.test(line)) { (bullets = bullets || []).push(<li key={i}>{inline(line.replace(/^[-*]\s+/, ''), i)}</li>); }
    else if (line === '') { flush(); }
    else { flush(); out.push(<p key={i} style={styles.p}>{inline(line, i)}</p>); }
  });
  flush();
  return out;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function DocQATool() {
  const [doc, setDoc] = useState(null); // { name, text, pages, chars }
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [question, setQuestion] = useState('');
  const [thread, setThread] = useState([]); // [{ q, a }]
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [usageRefresh, setUsageRefresh] = useState(0);

  const openFile = async file => {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { setError('Please choose a PDF file.'); return; }
    setError(''); setLoadingDoc(true); setThread([]); setDoc(null);
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

  const ask = async q => {
    const query = String(q ?? question).trim();
    if (!doc || query.length < 2 || asking) return;
    setError(''); setAsking(true); setQuestion('');
    try {
      const { data } = await api.post('/office/ask', { context: doc.text, question: query }, { suppressToast: true });
      setThread(t => [...t, { q: query, a: data.result || '' }]);
      setUsageRefresh(n => n + 1);
    } catch (e) {
      setError(e?.response?.data?.error || 'The question failed. Please try again.');
      setQuestion(query); // don't lose what they typed
    } finally {
      setAsking(false);
    }
  };

  const onKeyDown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };

  return (
    <div>
      <AiUsageBadge refreshSignal={usageRefresh} />
      <p style={styles.hint}>
        Open a text-based PDF — a subcontract, spec section, or insurance cert — and ask questions
        about it, or get a plain-English summary. Answers come only from the document.
      </p>

      {!doc && (
        <label style={{ ...styles.drop, ...(loadingDoc ? styles.dropBusy : null) }}>
          <input type="file" accept="application/pdf" style={{ display: 'none' }}
            onChange={e => { openFile(e.target.files[0]); e.target.value = ''; }} disabled={loadingDoc} />
          <span style={styles.dropTitle}>{loadingDoc ? 'Reading PDF…' : 'Choose a PDF'}</span>
          <span style={styles.dropSub}>Only the text is read; the file stays in your browser.</span>
        </label>
      )}

      {doc && (
        <>
          <div style={styles.docBar}>
            <span style={styles.docName}>📄 {doc.name}</span>
            <span style={styles.docMeta}>{doc.pages} page{doc.pages === 1 ? '' : 's'} · {doc.chars.toLocaleString()} chars</span>
            <button className="ops-button" onClick={() => { setDoc(null); setThread([]); setError(''); }}>Open a different PDF</button>
          </div>

          <div style={styles.askRow}>
            <input
              style={styles.qInput}
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about this document… (e.g. what's the retainage %?)"
              disabled={asking}
            />
            <button className="ops-button-primary" onClick={() => ask()} disabled={asking || question.trim().length < 2}>
              {asking ? 'Asking…' : 'Ask'}
            </button>
          </div>
          {!thread.length && !asking && (
            <div style={styles.suggests}>
              <button className="ops-button" onClick={() => ask('Give a short plain-English summary of this document.')}>Summarize it</button>
              <button className="ops-button" onClick={() => ask('List the key dates and deadlines in this document.')}>Key dates</button>
              <button className="ops-button" onClick={() => ask('What are the payment terms and retainage?')}>Payment terms</button>
            </div>
          )}

          {error && <div style={styles.error}>{error}</div>}

          <div style={styles.thread}>
            {thread.map((turn, i) => (
              <div key={i} style={styles.turn}>
                <div style={styles.q}>{turn.q}</div>
                <div style={styles.a}>{renderAnswer(turn.a)}</div>
              </div>
            ))}
            {asking && <div style={styles.thinking}>Thinking…</div>}
          </div>
        </>
      )}

      {!doc && error && <div style={styles.error}>{error}</div>}
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
  askRow: { display: 'flex', gap: 8, alignItems: 'center' },
  qInput: {
    flex: 1, boxSizing: 'border-box', padding: '10px 12px', fontSize: 14, fontFamily: 'inherit',
    border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', color: '#0f172a',
  },
  suggests: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 },
  error: {
    marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13.5,
    background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
  },
  thread: { marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 },
  turn: { border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', background: '#fff' },
  q: { padding: '10px 14px', background: '#eff6ff', borderBottom: '1px solid #dbeafe', fontWeight: 600, color: '#0f172a' },
  a: { padding: '4px 16px 12px', fontSize: 14, lineHeight: 1.6, color: '#0f172a' },
  thinking: { color: '#94a3b8', fontSize: 13.5, fontStyle: 'italic' },
  h: { fontWeight: 700, fontSize: 14.5, margin: '12px 0 4px', color: '#0f172a' },
  p: { margin: '6px 0' },
  ul: { margin: '4px 0', paddingLeft: 20, lineHeight: 1.7 },
};
