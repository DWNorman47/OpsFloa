import React, { useState } from 'react';
import api from '../api';
import AiUsageBadge from './AiUsageBadge';

const TONES = ['Professional', 'Friendly', 'Firm', 'Brief', 'Apologetic'];

export default function EmailDrafterTool() {
  const [points, setPoints] = useState('');
  const [tone, setTone] = useState('Professional');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState(0);

  const run = async () => {
    setError(''); setResult(''); setLoading(true);
    try {
      const { data } = await api.post('/office/draft-email', { points, tone }, { suppressToast: true });
      setResult(data.result || '');
      setUsageRefresh(n => n + 1);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not draft the message. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(result); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) { /* blocked */ }
  };

  return (
    <div>
      <AiUsageBadge refreshSignal={usageRefresh} />
      <p style={styles.hint}>
        Jot a few notes about what the message should say — a payment reminder, a running-late text,
        a quote follow-up — and get a polished draft you can tweak and send.
      </p>
      <textarea
        style={styles.input}
        value={points}
        onChange={e => setPoints(e.target.value)}
        placeholder={'What should it say? e.g.\n- following up on the driveway quote from last week\n- offer to swing by Thursday or Friday\n- ask if they have questions'}
        rows={8}
      />
      <div style={styles.actions}>
        <label style={styles.toneLabel}>
          Tone
          <select style={styles.select} value={tone} onChange={e => setTone(e.target.value)}>
            {TONES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <button className="ops-button-primary" onClick={run} disabled={loading || points.trim().length < 5}>
          {loading ? 'Drafting…' : 'Draft message'}
        </button>
        {(points || result) && (
          <button className="ops-button" onClick={() => { setPoints(''); setResult(''); setError(''); }} disabled={loading}>Clear</button>
        )}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {result && (
        <div style={styles.resultWrap}>
          <div style={styles.resultHead}>
            <strong>Draft</strong>
            <button className="ops-button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <div style={styles.output}>{result}</div>
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
  toneLabel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#475569', fontWeight: 600 },
  select: {
    padding: '7px 9px', fontSize: 13.5, border: '1px solid #e2e8f0', borderRadius: 8,
    background: '#fff', color: '#0f172a',
  },
  error: {
    marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13.5,
    background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
  },
  resultWrap: { marginTop: 16, border: '1px solid #e2e8f0', borderRadius: 12, background: '#fff', overflow: 'hidden' },
  resultHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px', borderBottom: '1px solid #eef2f6', background: '#f8fafc',
  },
  output: { padding: '14px 16px', fontSize: 14, lineHeight: 1.6, color: '#0f172a', whiteSpace: 'pre-wrap' },
};
