import { renderAiMarkdown } from './aiMarkdown';
import React, { useState } from 'react';
import api from '../api';
import AiUsageBadge from './AiUsageBadge';

// "Speak English. Your crew reads Spanish." Foreman types the day's tasks in
// English → clean Spanish (or bilingual) task card the crew can read. Same
// text-in / markdown-out shape as SummarizerTool; the AI + metering live in
// server/routes/officeTools.js (/office/crew-card).
export default function CrewCardTool() {
  const [tasks, setTasks] = useState('');
  const [job, setJob] = useState('');
  const [bilingual, setBilingual] = useState(true);
  const [result, setResult] = useState('');
  const [clipped, setClipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState(0);

  const run = async () => {
    setError(''); setResult(''); setLoading(true);
    try {
      const { data } = await api.post('/office/crew-card', { tasks, job, bilingual }, { suppressToast: true });
      setResult(data.result || '');
      setClipped(!!data.clipped);
      setUsageRefresh(n => n + 1);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not make the crew card. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(result); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) { /* clipboard blocked */ }
  };

  const clearAll = () => { setTasks(''); setJob(''); setResult(''); setError(''); setClipped(false); };

  return (
    <div>
      <AiUsageBadge refreshSignal={usageRefresh} />
      <p style={styles.hint}>
        Type the day's tasks in English and get a clean task card your crew can read in Spanish.
        Keep it bilingual to double-check the translation against your own words, or switch to
        Spanish-only for the card you hand out.
      </p>

      <label style={styles.fieldLabel}>Job or site <span style={styles.optional}>(optional)</span></label>
      <input
        style={styles.jobInput}
        value={job}
        onChange={e => setJob(e.target.value)}
        placeholder="e.g. Maple St. retaining wall"
        maxLength={120}
      />

      <label style={styles.fieldLabel}>Tasks / notes (in English)</label>
      <textarea
        style={styles.input}
        value={tasks}
        onChange={e => setTasks(e.target.value)}
        placeholder={"What does the crew need to do? e.g.\n- finish forming the north footings\n- strip topsoil along the east fence line, stockpile it on site\n- rebar delivery around 10, get it unloaded\n- wear harnesses on the retaining wall"}
        rows={9}
      />

      <div style={styles.actions}>
        <label style={styles.toneLabel}>
          Card language
          <select style={styles.select} value={bilingual ? 'both' : 'es'} onChange={e => setBilingual(e.target.value === 'both')}>
            <option value="both">Spanish + English</option>
            <option value="es">Spanish only</option>
          </select>
        </label>
        <button className="ops-button-primary" onClick={run} disabled={loading || tasks.trim().length < 5}>
          {loading ? 'Making card…' : 'Make crew card'}
        </button>
        {(tasks || job || result) && (
          <button className="ops-button" onClick={clearAll} disabled={loading}>Clear</button>
        )}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {result && (
        <div style={styles.resultWrap}>
          <div style={styles.resultHead}>
            <strong>Crew card</strong>
            <button className="ops-button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          {clipped && <div style={styles.clip}>Note: the input was long and was trimmed before translating.</div>}
          <div style={styles.output}>{renderAiMarkdown(result)}</div>
        </div>
      )}
    </div>
  );
}

const styles = {
  hint: { color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: '0 0 12px' },
  fieldLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: '#475569', margin: '4px 0 4px' },
  optional: { fontWeight: 400, color: '#94a3b8' },
  jobInput: {
    width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 14,
    border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff', color: '#0f172a',
    marginBottom: 12,
  },
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
  clip: { padding: '8px 14px', fontSize: 12.5, color: '#92400e', background: '#fffbeb', borderBottom: '1px solid #fef3c7' },
  output: { padding: '4px 16px 14px', fontSize: 14, lineHeight: 1.6, color: '#0f172a' },
};
