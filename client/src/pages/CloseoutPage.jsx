// Project closeout — checklist orchestrator. Reads auto-status items
// live from underlying modules (punchlist, lien waivers, invoices),
// surfaces them alongside manual items, and gates the lifecycle
// transitions on completion of the right items.

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../api';
import { PageShell } from '../components/PageShell';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { silentError } from '../errorReporter';

const STATUS_COLORS = {
  open:                  { bg: '#f3f4f6', fg: '#374151', label: 'Open' },
  in_progress:           { bg: '#dbeafe', fg: '#1d4ed8', label: 'In Progress' },
  substantially_complete:{ bg: '#fef3c7', fg: '#92400e', label: 'Substantially Complete' },
  final_complete:        { bg: '#d1fae5', fg: '#065f46', label: 'Final Complete' },
  closed:                { bg: '#a7f3d0', fg: '#065f46', label: 'Closed' },
  reopened:              { bg: '#fee2e2', fg: '#991b1b', label: 'Reopened' },
};

const ITEM_STATUS_COLORS = {
  pending:     { fg: '#6b7280', icon: '○' },
  in_progress: { fg: '#1d4ed8', icon: '◐' },
  done:        { fg: '#065f46', icon: '●' },
  waived:      { fg: '#7c3aed', icon: '◆' },
  n_a:         { fg: '#9ca3af', icon: '⊘' },
};

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.open;
  return (
    <span style={{
      fontSize: 12, fontWeight: 700, background: c.bg, color: c.fg,
      padding: '4px 10px', borderRadius: 12, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{c.label}</span>
  );
}

// ── Project picker ───────────────────────────────────────────────────────────

function CloseoutLanding({ onSelect }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [warranties, setWarranties] = useState([]);

  useEffect(() => {
    api.get('/admin/projects').then(({ data }) => setProjects(data || []))
      .catch(silentError).finally(() => setLoading(false));
    api.get('/warranties-expiring', { params: { within_days: 60 } })
      .then(({ data }) => setWarranties(data.items || [])).catch(() => {});
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>Project Closeout</h1>

      {warranties.length > 0 && (
        <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>
            {warranties.length} warrant{warranties.length === 1 ? 'y' : 'ies'} expiring in the next 60 days
          </div>
          {warranties.slice(0, 5).map(w => (
            <div key={w.id} style={{ fontSize: 13, color: '#7c3a00', marginBottom: 2 }}>
              <strong>{w.project_name}</strong> · expires {new Date(w.warranty_end_date).toLocaleDateString()}
            </div>
          ))}
        </div>
      )}

      {loading ? <SkeletonList rows={3} /> :
        projects.length === 0 ? (
          <EmptyState title="No projects" body="Open a project to begin closeout." />
        ) : (
          <>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>Choose a project to view or open its closeout:</div>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr style={styles.tableHeader}>
                    <th style={styles.th}>Project</th>
                    <th style={styles.th}>Client</th>
                    <th style={styles.th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map(p => (
                    <tr key={p.id} style={styles.tableRow} onClick={() => onSelect(p.id)}>
                      <td style={styles.td}><strong>{p.name}</strong></td>
                      <td style={styles.td}>{p.client_name || '—'}</td>
                      <td style={styles.td}>{p.status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      }
    </div>
  );
}

// ── Project closeout view ────────────────────────────────────────────────────

function ProjectCloseoutView({ projectId, onBack }) {
  const [closeout, setCloseout] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/projects/${projectId}/closeout`);
      setCloseout(data.closeout);
      setItems(data.items || []);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function openCloseout() {
    setBusy(true); setError(null);
    try {
      const { data } = await api.post(`/projects/${projectId}/closeout`);
      setCloseout(data.closeout);
      setItems(data.items || []);
    } catch (err) { setError(err.response?.data?.error || 'Failed to open closeout'); }
    finally { setBusy(false); }
  }

  async function transition(to_status) {
    setBusy(true); setError(null);
    try {
      await api.post(`/projects/${projectId}/closeout/transition`, { to_status });
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Transition failed'); }
    finally { setBusy(false); }
  }

  async function toggleItem(item, newStatus) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/closeout-items/${item.id}`, { status: newStatus });
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Update failed'); }
    finally { setBusy(false); }
  }

  if (loading) return <SkeletonList rows={4} />;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
      <div style={{ marginBottom: 16 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← Back to projects</button>
      </div>

      {!closeout ? (
        <div style={styles.formCard}>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>No closeout opened yet</h2>
          <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 16 }}>
            Opening a closeout seeds the company's default checklist for this project. Auto-status items (punchlist, lien waivers, final invoice, retainage) start computing immediately.
          </p>
          <button onClick={openCloseout} disabled={busy} style={styles.primaryBtn}>
            {busy ? 'Opening...' : 'Open closeout'}
          </button>
          {error && <div style={styles.errorBox}>{error}</div>}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>Closeout</h1>
            <StatusBadge status={closeout.status} />
          </div>

          {error && <div style={styles.errorBox}>{error}</div>}

          {/* Lifecycle */}
          <div style={styles.formCard}>
            <h3 style={styles.formH3}>Lifecycle</h3>
            <div style={styles.grid4}>
              <Info label="Substantial Completion" value={closeout.substantial_completion_date ? new Date(closeout.substantial_completion_date).toLocaleDateString() : null} />
              <Info label="Final Completion" value={closeout.final_completion_date ? new Date(closeout.final_completion_date).toLocaleDateString() : null} />
              <Info label="Warranty Start" value={closeout.warranty_start_date ? new Date(closeout.warranty_start_date).toLocaleDateString() : null} />
              <Info label="Warranty Months" value={closeout.warranty_months} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              {closeout.status === 'in_progress' && (
                <button onClick={() => transition('substantially_complete')} disabled={busy} style={styles.primaryBtn}>
                  Mark Substantially Complete
                </button>
              )}
              {closeout.status === 'open' && (
                <button onClick={() => transition('in_progress')} disabled={busy} style={styles.primaryBtn}>
                  Begin closeout
                </button>
              )}
              {closeout.status === 'substantially_complete' && (
                <button onClick={() => transition('final_complete')} disabled={busy} style={styles.primaryBtn}>
                  Mark Final Complete
                </button>
              )}
              {closeout.status === 'final_complete' && (
                <button onClick={() => transition('closed')} disabled={busy} style={styles.primaryBtn}>
                  Close
                </button>
              )}
              {closeout.status === 'closed' && (
                <button onClick={() => transition('reopened')} disabled={busy} style={{ ...styles.ghostBtn, color: '#991b1b' }}>
                  Reopen
                </button>
              )}
            </div>
          </div>

          {/* Checklist */}
          <div style={styles.formCard}>
            <h3 style={styles.formH3}>Checklist ({items.filter(i => ['done', 'waived', 'n_a'].includes(i.status)).length} / {items.length} complete)</h3>
            <div>
              {items.map(item => (
                <ChecklistRow key={item.id} item={item} onChange={toggleItem} busy={busy} />
              ))}
            </div>
          </div>

          {closeout.notes && (
            <div style={styles.formCard}>
              <h3 style={styles.formH3}>Notes</h3>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: '#374151', margin: 0 }}>{closeout.notes}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ChecklistRow({ item, onChange, busy }) {
  const c = ITEM_STATUS_COLORS[item.status] || ITEM_STATUS_COLORS.pending;
  const isAuto = !!item.auto_source;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 0', borderBottom: '1px solid #f3f4f6',
    }}>
      <div style={{ width: 30, fontSize: 22, color: c.fg, textAlign: 'center', flexShrink: 0 }}>{c.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
          {item.title}
          {!item.required && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8, fontWeight: 500 }}>(optional)</span>}
          {isAuto && (
            <span style={{ fontSize: 10, color: '#1d4ed8', marginLeft: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>auto</span>
          )}
        </div>
        {item.description && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{item.description}</div>
        )}
        {item.completed_at && (
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
            Completed {new Date(item.completed_at).toLocaleDateString()}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>
        {isAuto ? (
          <span style={{ fontSize: 12, color: c.fg, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {item.status}
          </span>
        ) : (
          <select
            value={item.status}
            onChange={e => onChange(item, e.target.value)}
            disabled={busy}
            style={{ ...styles.input, padding: '4px 8px', fontSize: 13 }}
          >
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
            <option value="waived">Waived</option>
            <option value="n_a">N/A</option>
          </select>
        )}
      </div>
    </div>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────

export default function CloseoutPage() {
  const { user } = useAuth();
  const [projectId, setProjectId] = useState(null);

  return (
    <PageShell currentApp="timeclock" maxWidth={1200} headerProps={{ userRole: user?.role }}>
      {projectId == null
        ? <CloseoutLanding onSelect={setProjectId} />
        : <ProjectCloseoutView projectId={projectId} onBack={() => setProjectId(null)} />}
    </PageShell>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: '#111827' }}>{value || '—'}</div>
    </div>
  );
}

const styles = {
  primaryBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' },
  tableWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  tableRow: { borderBottom: '1px solid #f3f4f6', cursor: 'pointer' },
  td: { padding: '12px 14px', color: '#111827' },
  formCard: { background: '#fff', borderRadius: 8, padding: 20, marginBottom: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' },
  formH3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
