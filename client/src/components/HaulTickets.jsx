import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import { labelSg } from '../companyLabels';
import { SkeletonList } from './Skeleton';

const UNITS = ['CY', 'tons', 'loads'];
const DIRECTIONS = ['export', 'import'];

function fmtDate(str, locale = 'en-US') {
  if (!str) return '';
  const s = String(str);
  const d = s.includes('T') ? new Date(s) : new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

const fmtQty = n => {
  const v = Number(n) || 0;
  return (Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
};

// ── Haul / production log — per-job truck-load tickets ──────────────────────────
export default function HaulTickets({ projects = [], settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workLabel = labelSg(settings?.label_work, 'project', user?.language);
  const today = new Date().toLocaleDateString('en-CA');

  const [filterProject, setFilterProject] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [form, setForm] = useState({
    project_id: '', ticket_date: today, ticket_no: '', hauler: '',
    material: '', qty: '', unit: 'CY', direction: 'export', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirmingId, setConfirmingId] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const params = {};
      if (filterProject) params.project_id = filterProject;
      if (from) params.from = from;
      if (to) params.to = to;
      const r = await api.get('/haul-tickets', { params });
      setTickets(r.data.items || []);
    } catch {
      setLoadError(t.haulLoadError);
    } finally {
      setLoading(false);
    }
  }, [filterProject, from, to, t]);

  useEffect(() => { load(); }, [load]);

  const addTicket = async () => {
    if (!form.ticket_date) { setSaveError(t.haulDateRequired); return; }
    setSaving(true);
    setSaveError('');
    try {
      const r = await api.post('/haul-tickets', {
        ...form,
        project_id: form.project_id || null,
        qty: form.qty === '' ? 0 : form.qty,
      });
      // If the new ticket matches the current filters, show it; otherwise just reset.
      const passesFilter =
        (!filterProject || String(r.data.project_id || '') === String(filterProject)) &&
        (!from || r.data.ticket_date >= from) &&
        (!to || r.data.ticket_date <= to);
      if (passesFilter) setTickets(list => [r.data, ...list]);
      setForm(f => ({ ...f, ticket_no: '', hauler: '', material: '', qty: '', notes: '' }));
    } catch (err) {
      setSaveError(err.response?.data?.error || t.haulSaveError);
    } finally {
      setSaving(false);
    }
  };

  const remove = async id => {
    try {
      await api.delete(`/haul-tickets/${id}`);
      setTickets(list => list.filter(x => x.id !== id));
    } catch {
      setLoadError(t.haulSaveError);
    } finally {
      setConfirmingId(null);
    }
  };

  // Totals by unit, split export vs import, plus net export (export − import).
  const totals = useMemo(() => {
    const by = {};
    for (const tk of tickets) {
      const u = UNITS.includes(tk.unit) ? tk.unit : 'CY';
      by[u] = by[u] || { export: 0, import: 0 };
      by[u][tk.direction === 'import' ? 'import' : 'export'] += Number(tk.qty) || 0;
    }
    return by;
  }, [tickets]);

  const exportCsv = () => {
    const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const rows = [['Date', 'Job', 'Ticket #', 'Hauler', 'Material', 'Qty', 'Unit', 'Direction', 'Notes'].map(q).join(',')];
    for (const tk of tickets) {
      rows.push([tk.ticket_date, tk.project_name || '', tk.ticket_no || '', tk.hauler || '',
        tk.material || '', tk.qty, tk.unit, tk.direction, tk.notes || ''].map(q).join(','));
    }
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `haul-tickets-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const projName = tk => tk.project_name || t.haulNoProject;

  return (
    <div>
      <p style={styles.intro}>{t.haulIntro}</p>

      {/* Add a ticket */}
      <div style={styles.card}>
        <div style={styles.cardHead}>{t.haulAddTitle}</div>
        <div style={styles.formGrid}>
          <label style={styles.field}>
            <span style={styles.lbl}>{t.haulDate}</span>
            <input style={styles.input} type="date" value={form.ticket_date} onChange={e => set('ticket_date', e.target.value)} />
          </label>
          <label style={styles.field}>
            <span style={styles.lbl}>{workLabel}</span>
            <select style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{t.haulNoProject}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.lbl}>{t.haulTicketNo}</span>
            <input style={styles.input} value={form.ticket_no} maxLength={100} onChange={e => set('ticket_no', e.target.value)} />
          </label>
          <label style={styles.field}>
            <span style={styles.lbl}>{t.haulHauler}</span>
            <input style={styles.input} value={form.hauler} maxLength={255} onChange={e => set('hauler', e.target.value)} />
          </label>
          <label style={styles.field}>
            <span style={styles.lbl}>{t.haulMaterial}</span>
            <input style={styles.input} value={form.material} maxLength={255} onChange={e => set('material', e.target.value)} />
          </label>
          <label style={{ ...styles.field, maxWidth: 90 }}>
            <span style={styles.lbl}>{t.haulQty}</span>
            <input style={styles.input} type="number" min="0" step="0.01" value={form.qty} onChange={e => set('qty', e.target.value)} />
          </label>
          <label style={{ ...styles.field, maxWidth: 110 }}>
            <span style={styles.lbl}>{t.haulUnit}</span>
            <select style={styles.input} value={form.unit} onChange={e => set('unit', e.target.value)}>
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          <label style={{ ...styles.field, maxWidth: 160 }}>
            <span style={styles.lbl}>{t.haulDirection}</span>
            <select style={styles.input} value={form.direction} onChange={e => set('direction', e.target.value)}>
              <option value="export">{t.haulExport}</option>
              <option value="import">{t.haulImport}</option>
            </select>
          </label>
          <label style={{ ...styles.field, flex: '1 1 100%' }}>
            <span style={styles.lbl}>{t.haulNotes}</span>
            <input style={styles.input} value={form.notes} maxLength={1000} onChange={e => set('notes', e.target.value)} />
          </label>
        </div>
        {saveError && <p role="alert" style={styles.error}>{saveError}</p>}
        <div style={styles.formActions}>
          <button style={{ ...styles.addBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={addTicket} disabled={saving}>
            {saving ? t.haulAdding : `+ ${t.haulAdd}`}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={styles.filters}>
        <select style={styles.filterInput} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
          <option value="">{t.haulAllProjects}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <label style={styles.filterLbl}>{t.haulFrom}
          <input style={styles.filterInput} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label style={styles.filterLbl}>{t.haulTo}
          <input style={styles.filterInput} type="date" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        {tickets.length > 0 && <button style={styles.csvBtn} onClick={exportCsv}>⤓ {t.haulCsv}</button>}
      </div>

      {/* Totals */}
      {Object.keys(totals).length > 0 && (
        <div style={styles.totalsBar}>
          <span style={styles.totalsLabel}>{t.haulTotals}:</span>
          {Object.entries(totals).map(([unit, d]) => (
            <span key={unit} style={styles.totalChip}>
              <b>{fmtQty(d.export - d.import)}</b> {unit}
              <span style={styles.totalSub}> ({t.haulNetExport}; ↑{fmtQty(d.export)} ↓{fmtQty(d.import)})</span>
            </span>
          ))}
        </div>
      )}

      {loadError && <p role="alert" style={styles.error}>{loadError}</p>}

      {/* List */}
      {loading ? (
        <SkeletonList count={4} />
      ) : tickets.length === 0 ? (
        <p style={styles.empty}>{t.haulNone}</p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t.haulDate}</th>
                <th style={styles.th}>{workLabel}</th>
                <th style={styles.th}>{t.haulTicketNo}</th>
                <th style={styles.th}>{t.haulHauler}</th>
                <th style={styles.th}>{t.haulMaterial}</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>{t.haulQty}</th>
                <th style={styles.th}>{t.haulDirection}</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {tickets.map(tk => (
                <tr key={tk.id}>
                  <td style={styles.td}>{fmtDate(tk.ticket_date, locale)}</td>
                  <td style={styles.td}>{projName(tk)}</td>
                  <td style={styles.td}>{tk.ticket_no || '—'}</td>
                  <td style={styles.td}>{tk.hauler || '—'}</td>
                  <td style={styles.td}>{tk.material || '—'}</td>
                  <td style={{ ...styles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtQty(tk.qty)} {tk.unit}</td>
                  <td style={styles.td}>
                    <span style={tk.direction === 'import' ? styles.dirImport : styles.dirExport}>
                      {tk.direction === 'import' ? t.haulImport : t.haulExport}
                    </span>
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {confirmingId === tk.id ? (
                      <>
                        <button style={styles.confirmDel} onClick={() => remove(tk.id)}>{t.haulDelete}</button>
                        <button style={styles.cancelDel} onClick={() => setConfirmingId(null)}>✕</button>
                      </>
                    ) : (
                      <button style={styles.delBtn} title={t.haulConfirmDelete} onClick={() => setConfirmingId(tk.id)}>🗑</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Styles (matches the field-module inline-styles idiom) ───────────────────────
const styles = {
  intro: { fontSize: 13, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5 },
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 16 },
  cardHead: { fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 10 },
  formGrid: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 140px', minWidth: 120 },
  lbl: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 14, width: '100%', boxSizing: 'border-box' },
  formActions: { marginTop: 12 },
  addBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 7, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  filters: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 12 },
  filterLbl: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: '#6b7280' },
  filterInput: { padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  csvBtn: { marginLeft: 'auto', background: '#fff', border: '1px solid #d1d5db', padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  totalsBar: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '10px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, marginBottom: 14 },
  totalsLabel: { fontSize: 12, fontWeight: 700, color: '#166534', textTransform: 'uppercase', letterSpacing: 0.4 },
  totalChip: { fontSize: 14, color: '#14532d' },
  totalSub: { fontSize: 11, color: '#4b5563' },
  tableWrap: { overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 720 },
  th: { textAlign: 'left', padding: '9px 10px', background: '#f9fafb', color: '#6b7280', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' },
  td: { padding: '9px 10px', borderBottom: '1px solid #f1f3f5', color: '#374151' },
  dirExport: { display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 600 },
  dirImport: { display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#dbeafe', color: '#1e40af', fontSize: 12, fontWeight: 600 },
  delBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, opacity: 0.7 },
  confirmDel: { background: '#dc2626', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', marginRight: 4 },
  cancelDel: { background: '#e5e7eb', color: '#374151', border: 'none', padding: '4px 8px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  empty: { fontSize: 14, color: '#9ca3af', textAlign: 'center', padding: '32px 0' },
  error: { color: '#dc2626', fontSize: 13, margin: '8px 0 0' },
};
