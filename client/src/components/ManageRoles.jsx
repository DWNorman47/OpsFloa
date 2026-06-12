/**
 * Phase B roles management UI. Lives as a sub-tab under Team for users with
 * `manage_roles` permission (Owner by default, delegable).
 *
 * Shows every role in the company (built-in + custom) with name, parent,
 * user count, and permission count. Expanding a role reveals checkboxes
 * grouped by area. Built-in roles can have their permissions edited but
 * not their name or parent. Custom roles can be created from either a
 * Worker or Admin parent (initial permissions snapshot from that parent's
 * defaults), edited freely, and deleted (users fall back to parent).
 *
 * Permissions you don't have yourself appear disabled in the editor with a
 * tooltip — the server enforces the same rule via the privilege-escalation
 * guard in POST /admin/roles, but the UI surfaces it up front.
 */

import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import ModalShell from './ModalShell';
import { silentError } from '../errorReporter';

export default function ManageRoles() {
  const t = useT();
  const { user } = useAuth();
  const [roles, setRoles] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [myPerms, setMyPerms] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [draftRole, setDraftRole] = useState(null); // { id?, name, description, parent_role, permissions: Set }
  const [saving, setSaving] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  // Group catalog entries by their `group` field for the editor UI.
  const grouped = useMemo(() => {
    const out = {};
    for (const p of catalog) (out[p.group] ||= []).push(p);
    return out;
  }, [catalog]);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [rolesRes, catalogRes] = await Promise.all([
        api.get('/admin/roles'),
        api.get('/admin/permissions/catalog'),
      ]);
      setRoles(rolesRes.data);
      setCatalog(catalogRes.data);
      // /auth/me already resolved this user's effective permissions —
      // super_admin gets the full catalog, role_id users get their role's
      // perms, legacy admins get their admin_permissions translated. Use
      // that authoritative list directly so checkboxes never advertise a
      // grant the server would reject. (Old code granted ALL perms to
      // role_id=NULL users, which was misleading for legacy restricted
      // admins.)
      setMyPerms(new Set(user?.permissions || []));
    } catch (err) {
      setError(err.response?.data?.error || t.mrolesLoadFailed || 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const startEditExisting = async (role) => {
    if (expandedId === role.id) { setExpandedId(null); setDraftRole(null); return; }
    setExpandedId(role.id);
    try {
      const r = await api.get(`/admin/roles/${role.id}`);
      setDraftRole({
        id: r.data.id,
        name: r.data.name,
        description: r.data.description || '',
        parent_role: r.data.parent_role,
        is_builtin: r.data.is_builtin,
        permissions: new Set(r.data.permissions),
      });
    } catch (err) {
      silentError('manageroles')(err);
    }
  };

  const startCreate = (parent_role) => {
    // Seed perms from parent's built-in defaults so the user starts close
    // to a sensible baseline, then customizes from there.
    const parent = roles.find(r => r.is_builtin && r.parent_role === parent_role && r.name === (parent_role === 'worker' ? 'Worker' : 'Admin'));
    if (!parent) { setError(t.mrolesNoParent || 'Parent role missing'); return; }
    api.get(`/admin/roles/${parent.id}`).then(r => {
      setExpandedId(null);
      setDraftRole({
        name: '',
        description: '',
        parent_role,
        is_builtin: false,
        permissions: new Set(r.data.permissions),
      });
    });
  };

  const togglePerm = (key) => {
    if (!draftRole) return;
    const next = new Set(draftRole.permissions);
    if (next.has(key)) next.delete(key); else next.add(key);
    setDraftRole({ ...draftRole, permissions: next });
  };

  const save = async () => {
    if (!draftRole) return;
    if (!draftRole.id && !draftRole.name.trim()) {
      setError(t.mrolesNameRequired || 'Name is required');
      return;
    }
    setSaving(true); setError('');
    try {
      const body = {
        name: draftRole.name.trim(),
        description: draftRole.description.trim() || null,
        permissions: Array.from(draftRole.permissions),
      };
      if (!draftRole.id) body.parent_role = draftRole.parent_role;
      if (draftRole.id) {
        await api.patch(`/admin/roles/${draftRole.id}`, body);
      } else {
        await api.post('/admin/roles', body);
      }
      setDraftRole(null);
      setExpandedId(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || t.mrolesSaveFailed || 'Failed to save role');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/admin/roles/${id}`);
      setPendingDeleteId(null);
      setExpandedId(null);
      setDraftRole(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || t.mrolesDeleteFailed || 'Failed to delete role');
    }
  };

  if (loading) return <div style={styles.empty}>{t.loading || 'Loading…'}</div>;

  return (
    <div style={styles.wrap}>
      <div style={styles.headerRow}>
        <div>
          <h2 style={styles.title}>{t.mrolesTitle || 'Roles'}</h2>
          <p style={styles.subtitle}>{t.mrolesSubtitle || 'Define what each role can do. Built-in roles can be tweaked but not renamed or deleted.'}</p>
        </div>
        <div style={styles.newBtnGroup}>
          <button style={styles.newBtn} onClick={() => startCreate('worker')}>{t.mrolesNewWorker || '+ New worker role'}</button>
          <button style={styles.newBtn} onClick={() => startCreate('admin')}>{t.mrolesNewAdmin || '+ New admin role'}</button>
        </div>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      {/* Inline editor for a brand-new role (not yet saved → no id) */}
      {draftRole && !draftRole.id && (
        <ModalShell onClose={() => setDraftRole(null)} labelId="mroles-new-title" maxWidth={760}>
          <h3 id="mroles-new-title" style={styles.modalTitle}>
            {(t.mrolesNewTitle || 'New role')} ({draftRole.parent_role === 'worker' ? (t.mrolesParentWorker || 'based on Worker') : (t.mrolesParentAdmin || 'based on Admin')})
          </h3>
          <RoleEditor
            t={t}
            draft={draftRole}
            grouped={grouped}
            myPerms={myPerms}
            onNameChange={v => setDraftRole({ ...draftRole, name: v })}
            onDescriptionChange={v => setDraftRole({ ...draftRole, description: v })}
            onTogglePerm={togglePerm}
          />
          <div style={styles.modalActions}>
            <button style={styles.cancelBtn} onClick={() => setDraftRole(null)}>{t.cancel || 'Cancel'}</button>
            <button style={styles.saveBtn} disabled={saving} onClick={save}>
              {saving ? (t.saving || 'Saving…') : (t.mrolesCreateBtn || 'Create role')}
            </button>
          </div>
        </ModalShell>
      )}

      <div style={styles.list}>
        {roles.map(role => {
          const isOwn = role.id === user?.role_id;
          const isExpanded = expandedId === role.id;
          return (
            <div key={role.id} style={{ ...styles.roleCard, ...(isExpanded ? styles.roleCardExpanded : {}) }}>
              <button style={styles.roleHeader} onClick={() => startEditExisting(role)}>
                <div style={styles.roleHeaderLeft}>
                  <span style={styles.roleName}>{role.name}</span>
                  {role.is_builtin && <span style={styles.builtinBadge}>{t.mrolesBuiltinBadge || 'Built-in'}</span>}
                  {isOwn && <span style={styles.ownBadge}>{t.mrolesYouBadge || 'You'}</span>}
                  <span style={styles.roleParent}>
                    {role.parent_role === 'worker' ? (t.mrolesParentWorkerShort || 'Team Member') : (t.mrolesParentAdminShort || 'Admin')}
                  </span>
                </div>
                <div style={styles.roleHeaderRight}>
                  <span style={styles.roleStat}>{role.user_count} {role.user_count === 1 ? (t.mrolesUserSing || 'user') : (t.mrolesUserPlur || 'users')}</span>
                  <span style={styles.roleStat}>{role.permission_count} {role.permission_count === 1 ? (t.mrolesPermSing || 'permission') : (t.mrolesPermPlur || 'permissions')}</span>
                  <span style={styles.chevron}>{isExpanded ? '▾' : '▸'}</span>
                </div>
              </button>

              {isExpanded && draftRole?.id === role.id && (
                <div style={styles.roleBody}>
                  <RoleEditor
                    t={t}
                    draft={draftRole}
                    grouped={grouped}
                    myPerms={myPerms}
                    nameLocked={role.is_builtin}
                    onNameChange={v => setDraftRole({ ...draftRole, name: v })}
                    onDescriptionChange={v => setDraftRole({ ...draftRole, description: v })}
                    onTogglePerm={togglePerm}
                  />
                  <div style={styles.editActions}>
                    <button style={styles.cancelBtn} onClick={() => { setExpandedId(null); setDraftRole(null); }}>{t.cancel || 'Cancel'}</button>
                    <button style={styles.saveBtn} disabled={saving} onClick={save}>
                      {saving ? (t.saving || 'Saving…') : (t.save || 'Save')}
                    </button>
                    {!role.is_builtin && (pendingDeleteId === role.id
                      ? (
                        <div style={styles.deleteConfirm}>
                          <span style={styles.deleteWarn}>
                            {role.user_count > 0
                              ? (t.mrolesDeleteWarnUsers || 'Delete? {n} user(s) will fall back to {parent}.')
                                  .replace('{n}', role.user_count)
                    .replace('{parent}', role.parent_role === 'worker' ? (t.mrolesParentWorkerShort || 'Team Member') : (t.mrolesParentAdminShort || 'Admin'))
                              : (t.mrolesDeleteWarnEmpty || 'Delete this role?')}
                          </span>
                          <button style={styles.deleteConfirmBtn} onClick={() => handleDelete(role.id)}>{t.confirm || 'Confirm'}</button>
                          <button style={styles.cancelBtn} onClick={() => setPendingDeleteId(null)}>{t.cancel || 'Cancel'}</button>
                        </div>
                      )
                      : (
                        <button style={styles.deleteBtn} onClick={() => setPendingDeleteId(role.id)}>{t.mrolesDeleteBtn || 'Delete role'}</button>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoleEditor({ t, draft, grouped, myPerms, nameLocked, onNameChange, onDescriptionChange, onTogglePerm }) {
  return (
    <div style={styles.editorWrap}>
      <div style={styles.fieldRow}>
        <label style={styles.label}>{t.mrolesFieldName || 'Name'}</label>
        <input
          style={{ ...styles.input, ...(nameLocked ? { background: '#f3f4f6', color: '#6b7280' } : {}) }}
          value={draft.name}
          onChange={e => onNameChange(e.target.value)}
          disabled={nameLocked}
          maxLength={60}
        />
      </div>
      <div style={styles.fieldRow}>
        <label style={styles.label}>{t.mrolesFieldDescription || 'Description'}</label>
        <input
          style={styles.input}
          value={draft.description}
          onChange={e => onDescriptionChange(e.target.value)}
          maxLength={300}
        />
      </div>
      <div style={styles.permGrid}>
        {Object.entries(grouped).map(([group, perms]) => (
          <div key={group} style={styles.permGroup}>
            <div style={styles.permGroupTitle}>{(t['mrolesGroup_' + group]) || group}</div>
            {perms.map(p => {
              const checked = draft.permissions.has(p.key);
              const grantable = myPerms.has(p.key);
              return (
                <label key={p.key} style={{ ...styles.permRow, ...(grantable ? {} : styles.permRowDisabled) }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!grantable && !checked}
                    onChange={() => onTogglePerm(p.key)}
                  />
                  <span style={styles.permLabel}>{p.label}</span>
                  {!grantable && checked && (
                    <span style={styles.escalateHint} title={t.mrolesEscalateHint || "You don't have this permission"}>⚠</span>
                  )}
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 },
  title: { fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 },
  subtitle: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  newBtnGroup: { display: 'flex', gap: 8 },
  newBtn: { padding: '7px 14px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  empty: { padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 14 },
  error: { color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', padding: '10px 12px', borderRadius: 8, fontSize: 13, margin: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  roleCard: { border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' },
  roleCardExpanded: { borderColor: '#bfdbfe', boxShadow: '0 2px 8px rgba(26,86,219,0.08)' },
  roleHeader: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' },
  roleHeaderLeft: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  roleHeaderRight: { display: 'flex', alignItems: 'center', gap: 14 },
  roleName: { fontWeight: 700, fontSize: 14, color: '#111827' },
  builtinBadge: { fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: '#e0e7ff', color: '#3730a3', textTransform: 'uppercase', letterSpacing: '0.04em' },
  ownBadge: { fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: '#d1fae5', color: '#065f46', textTransform: 'uppercase', letterSpacing: '0.04em' },
  roleParent: { fontSize: 11, color: '#6b7280' },
  roleStat: { fontSize: 12, color: '#6b7280' },
  chevron: { fontSize: 12, color: '#6b7280' },
  roleBody: { borderTop: '1px solid #f3f4f6', padding: '14px 16px', background: '#fafafa' },
  editorWrap: { display: 'flex', flexDirection: 'column', gap: 12 },
  fieldRow: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#374151' },
  input: { padding: '8px 11px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  permGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 6 },
  permGroup: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10 },
  permGroupTitle: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 },
  permRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12, color: '#374151', cursor: 'pointer' },
  permRowDisabled: { opacity: 0.55 },
  permLabel: { flex: 1 },
  escalateHint: { color: '#b45309', cursor: 'help' },
  editActions: { display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' },
  modalTitle: { fontSize: 16, fontWeight: 700, margin: '0 0 14px', color: '#111827' },
  modalActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 },
  cancelBtn: { padding: '8px 14px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 7, fontSize: 13, cursor: 'pointer' },
  saveBtn: { padding: '8px 18px', background: '#059669', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  deleteBtn: { marginLeft: 'auto', padding: '8px 14px', background: 'none', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: 7, fontSize: 13, cursor: 'pointer' },
  deleteConfirm: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' },
  deleteWarn: { fontSize: 12, color: '#92400e' },
  deleteConfirmBtn: { padding: '7px 14px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
};
