import React, { useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { labelSg, labelPl } from '../companyLabels';

function today() {
  return new Date().toLocaleDateString('en-CA');
}
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export default function ExportPanel({ workers, projects, settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [workerId, setWorkerId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    setError('');
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (workerId) params.set('worker_id', workerId);
      if (projectId) params.set('project_id', projectId);
      if (status) params.set('status', status);

      const r = await api.get(`/admin/export?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `timecrunch-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t.exportFailed);
    } finally {
      setLoading(false);
    }
  };

  // Summary: one row per worker with approved Regular/OT/Total hours + days
  // worked over the date range (ignores the worker/project/status filters).
  const downloadHoursSummary = async () => {
    setError('');
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      const r = await api.get(`/admin/export/worker-hours?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `worker-hours-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t.exportFailed);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>{t.exportTimeEntries}</h3>
      <p style={styles.sub}>{t.exportDesc}</p>

      <div style={styles.filters} className="export-filters">
        <div style={styles.filterGroup}>
          <label htmlFor="exp-from" style={styles.label}>{t.from}</label>
          <input id="exp-from" style={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div style={styles.filterGroup}>
          <label htmlFor="exp-to" style={styles.label}>{t.to}</label>
          <input id="exp-to" style={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div style={styles.filterGroup}>
          <label htmlFor="exp-worker" style={styles.label}>{workerLabel}</label>
          <select id="exp-worker" style={styles.input} value={workerId} onChange={e => setWorkerId(e.target.value)}>
            <option value="">{`All ${workerLabelPlural}`}</option>
            {workers.map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
          </select>
        </div>
        <div style={styles.filterGroup}>
          <label htmlFor="exp-project" style={styles.label}>Project</label>
          <select id="exp-project" style={styles.input} value={projectId} onChange={e => setProjectId(e.target.value)}>
            <option value="">{`All Projects`}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={styles.filterGroup}>
          <label htmlFor="exp-status" style={styles.label}>{t.status}</label>
          <select id="exp-status" style={styles.input} value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">{t.allStatuses}</option>
            <option value="approved">{t.approved}</option>
            <option value="pending">{t.pending}</option>
            <option value="rejected">{t.rejected}</option>
          </select>
        </div>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      <div style={styles.actions}>
        <button style={{ ...styles.downloadBtn, ...((loading || !from || !to) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={download} disabled={loading || !from || !to}>
          {loading ? t.preparing : t.downloadCSV}
        </button>
        <button style={{ ...styles.summaryBtn, ...((loading || !from || !to) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadHoursSummary} disabled={loading || !from || !to}>
          {t.exportWorkerHours}
        </button>
        <span style={styles.hint}>{t.exportColumns}</span>
      </div>
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  title: { fontSize: 17, fontWeight: 700, marginBottom: 6 },
  sub: { fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.5 },
  filters: { display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 },
  filterGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  input: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 10 },
  actions: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  downloadBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  summaryBtn: { background: '#fff', color: '#059669', border: '1px solid #059669', padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  hint: { fontSize: 12, color: '#6b7280' },
};
