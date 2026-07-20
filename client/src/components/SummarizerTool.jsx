import { renderAiMarkdown } from './aiMarkdown';
import React, { useState } from 'react';
import api from '../api';
import AiUsageBadge from './AiUsageBadge';

// render **bold** spans safely (React escapes the text, so no injection risk)
export default function SummarizerTool() {
  const [text, setText] = useState('');
  const [result, setResult] = useState('');
  const [clipped, setClipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState(0);

  const run = async () => {
    setError(''); setResult(''); setLoading(true);
    try {
      const { data } = await api.post('/office/summarize', { text }, { suppressToast: true });
      setResult(data.result || '');
      setClipped(!!data.clipped);
      setUsageRefresh(n => n + 1);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not summarize. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(result); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) { /* clipboard blocked */ }
  };

  const clearAll = () => { setText(''); setResult(''); setError(''); setClipped(false); };

  return (
    <div>
      <AiUsageBadge refreshSignal={usageRefresh} />
      <p style={styles.hint}>
        Paste a call or meeting transcript, rough notes, or a message thread and get back a clean
        summary with key points and action items. Nothing is stored — the text is sent only to
        generate the summary.
      </p>
      <textarea
        style={styles.input}
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Paste your transcript or notes here…"
        rows={12}
      />
      <div style={styles.actions}>
        <button className="ops-button-primary" onClick={run} disabled={loading || text.trim().length < 20}>
          {loading ? 'Summarizing…' : 'Summarize'}
        </button>
        {(text || result) && (
          <button className="ops-button" onClick={clearAll} disabled={loading}>Clear</button>
        )}
        <span style={styles.count}>{text.length.toLocaleString()} characters</span>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {result && (
        <div style={styles.resultWrap}>
          <div style={styles.resultHead}>
            <strong>Summary</strong>
            <button className="ops-button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          {clipped && <div style={styles.clip}>Note: the input was long and was trimmed before summarizing.</div>}
          <div style={styles.output}>{renderAiMarkdown(result)}</div>
        </div>
      )}
    </div>
  );
}

const styles = {
  hint: { color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 14, lineHeight: 1.5,
    border: '1px solid #e2e8f0', borderRadius: 10, resize: 'vertical', fontFamily: 'inherit',
    background: '#fff', color: '#0f172a',
  },
  actions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' },
  count: { color: '#94a3b8', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' },
  error: {
    marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13.5,
    background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
  },
  resultWrap: { marginTop: 16, border: '1px solid #e2e8f0', borderRadius: 12, background: '#fff', overflow: 'hidden' },
  resultHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px', borderBottom: '1px solid #eef2f6', background: '#f8fafc',
  },
  clip: { padding: '8px 14px', fontSize: 12.5, color: '#92400e', background: '#fffbeb', borderBottom: '1px solid #fef3c7' },
  output: { padding: '4px 16px 14px', fontSize: 14, lineHeight: 1.6, color: '#0f172a' },
};
