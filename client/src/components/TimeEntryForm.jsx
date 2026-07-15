import React, { useState, useEffect } from 'react';
import api from '../api';
import { useFormPersist } from '../hooks/useFormPersist';

export default function TimeEntryForm({ projects, onEntryAdded, t, prefill, projectsEnabled = true }) {
  const today = new Date().toLocaleDateString('en-CA');
  const [collapsed, setCollapsed] = useState(true);
  const [form, setForm] = useState({
    project_id: '',
    work_date: today,
    start_time: '',
    end_time: '',
    notes: '',
    break_minutes: '',
    mileage: '',
  });

  useEffect(() => {
    if (!prefill) return;
    setForm(f => ({
      ...f,
      project_id: prefill.project_id ? String(prefill.project_id) : f.project_id,
      work_date: prefill.shift_date ? prefill.shift_date.toString().substring(0, 10) : f.work_date,
      start_time: prefill.start_time ? prefill.start_time.substring(0, 5) : f.start_time,
      end_time: prefill.end_time ? prefill.end_time.substring(0, 5) : f.end_time,
    }));
  }, [prefill]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // Validate + scrub the persisted form on restore: a project_id saved in
  // a prior session may reference a project that's since been archived,
  // renumbered, or belongs to a different company after a user switch.
  // Pass `projects` via a ref so the validator sees the live list at mount.
  const { clearPersisted } = useFormPersist('time-entry', form, setForm, {
    validate: saved => {
      if (!saved || typeof saved !== 'object') return {};
      if (saved.project_id && projects?.length > 0 &&
          !projects.some(p => String(p.id) === String(saved.project_id))) {
        return { ...saved, project_id: '' };
      }
      return saved;
    },
  });

  // Safety net for the case where projects arrive after the form has
  // already restored from localStorage. Mirrors the scrub in ClockInOut.
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (!form.project_id) return;
    const stillValid = projects.some(p => String(p.id) === String(form.project_id));
    if (!stillValid) setForm(f => ({ ...f, project_id: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setError(''); };

  const selectedProject = projects.find(p => p.id === parseInt(form.project_id));

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    if (projectsEnabled && !form.project_id) { setError(t.tefSelectFirst.replace('{label}', 'project')); return; }
    if (!form.start_time || !form.end_time) { setError(t.startEndRequired); return; }
    if (form.start_time >= form.end_time) {
      setError(t.endAfterStart);
      return;
    }
    setSaving(true);
    const client_id = crypto.randomUUID();
    try {
      const r = await api.post('/time-entries', { ...form, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, client_id });
      if (r.data?.offline) {
        // Queued offline — add optimistic pending entry
        const pendingEntry = {
          id: client_id,
          pending: true,
          project_id: parseInt(form.project_id),
          project_name: selectedProject?.name,
          work_date: form.work_date,
          start_time: form.start_time,
          end_time: form.end_time,
          break_minutes: parseInt(form.break_minutes) || 0,
          mileage: form.mileage ? parseFloat(form.mileage) : null,
          notes: form.notes || null,
          wage_type: selectedProject?.wage_type || 'regular',
          status: 'pending',
        };
        onEntryAdded(pendingEntry);
      } else {
        onEntryAdded({ ...r.data, project_name: selectedProject?.name });
      }
      clearPersisted();
      setForm(f => ({ ...f, start_time: '', end_time: '', notes: '', break_minutes: '', mileage: '' }));
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err.response?.data?.error || t.failedSaveEntry);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.card} className="mobile-card">
      <button style={styles.toggleHeader} onClick={() => setCollapsed(v => !v)}>
        <h2 style={styles.heading}>{t.logTime}</h2>
        <span style={{ ...styles.chevron, transform: collapsed ? 'none' : 'rotate(180deg)' }}>▾</span>
      </button>
      {!collapsed && <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.row} className="form-row">
          {projectsEnabled && <div style={styles.field}>
            <label htmlFor="tef-project" style={styles.label}>Project<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
            <select id="tef-project" style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)} required disabled={saving} title={saving ? t.saving : undefined}>
              <option value="">{t.tefSelectOption.replace('{label}', 'project')}</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.wage_type === 'prevailing' ? t.prevailing : t.regular})
                </option>
              ))}
            </select>
          </div>}
          <div style={styles.field}>
            <label htmlFor="tef-date" style={styles.label}>{t.date}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
            <input id="tef-date" style={styles.input} type="date" value={form.work_date} onChange={e => set('work_date', e.target.value)} required disabled={saving} title={saving ? t.saving : undefined} />
          </div>
        </div>
        <div style={styles.row} className="form-row">
          <div style={styles.field}>
            <label htmlFor="tef-start" style={styles.label}>{t.startTime}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
            <input id="tef-start" style={styles.input} type="time" value={form.start_time} onChange={e => set('start_time', e.target.value)} required disabled={saving} title={saving ? t.saving : undefined} />
          </div>
          <div style={styles.field}>
            <label htmlFor="tef-end" style={styles.label}>{t.endTime}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
            <input id="tef-end" style={styles.input} type="time" value={form.end_time} onChange={e => set('end_time', e.target.value)} required disabled={saving} title={saving ? t.saving : undefined} />
          </div>
        </div>
        {selectedProject && (
          <div style={styles.wageIndicator}>
            {t.wageType}: <span style={{ color: selectedProject.wage_type === 'prevailing' ? '#d97706' : '#2563eb', fontWeight: 700 }}>
              {selectedProject.wage_type === 'prevailing' ? t.prevailing : t.regular}
            </span>
          </div>
        )}
        <div style={styles.row} className="form-row">
          <div style={styles.field}>
            <label htmlFor="tef-break" style={styles.label}>{t.entryPanelBreakMin}</label>
            <input id="tef-break" style={styles.input} type="number" min="0" max="480" step="1" value={form.break_minutes} onChange={e => set('break_minutes', e.target.value)} placeholder="0" disabled={saving} />
          </div>
          <div style={styles.field}>
            <label htmlFor="tef-mileage" style={styles.label}>{t.entryPanelMileage}</label>
            <input id="tef-mileage" style={styles.input} type="number" min="0" step="0.1" value={form.mileage} onChange={e => set('mileage', e.target.value)} placeholder={t.optional} disabled={saving} />
          </div>
        </div>
        <div style={styles.field}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label htmlFor="tef-notes" style={styles.label}>{t.notesOptional}</label>
            <span style={styles.charCount}>{form.notes.length}/500</span>
          </div>
          <input id="tef-notes" style={styles.input} type="text" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder={t.notesPlaceholder} maxLength={500} disabled={saving} />
        </div>
        {error && <p role="alert" style={styles.error}>{error}</p>}
        {success && <p style={styles.success}>{t.entrySaved}</p>}
        <button style={{ ...styles.button, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : t.logEntry}</button>
      </form>}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  toggleHeader: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' },
  heading: { margin: 0, fontSize: 18, fontWeight: 700 },
  chevron: { fontSize: 16, color: '#6b7280', transition: 'transform 0.2s', display: 'inline-block', marginBottom: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20 },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
  label: { fontSize: 13, fontWeight: 600, color: '#555' },
  input: { padding: '9px 11px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, width: '100%' },
  wageIndicator: { fontSize: 13, color: '#555', padding: '6px 2px' },
  error: { color: '#e53e3e', fontSize: 13 },
  success: { color: '#38a169', fontSize: 13 },
  button: { padding: '11px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600 },
  charCount: { fontSize: 11, color: '#6b7280' },
};
