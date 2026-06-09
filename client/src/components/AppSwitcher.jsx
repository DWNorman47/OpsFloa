import React, { useState, useEffect, useRef } from 'react';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { userCanSeeModule } from '../modulePermissions';

// Workers see: Time Clock, Field, Inventory, Account
// Admins see:  Time Clock, Workforce, Field, Inventory, Projects, Administration, Analytics
//   (Time Clock = the participating page — admins use it to clock themselves
//    in. Workforce = the oversight page — Live, Approvals, Reports, etc.)
export const APPS = [
  {
    id: 'timeclock',
    name: 'Time Clock',
    bg: '#2563eb',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <circle cx="10" cy="10" r="7.5" />
        <polyline points="10,5.5 10,10 13,12" />
      </svg>
    ),
    path: '/timeclock',
  },
  {
    id: 'workforce',
    name: 'Workforce',
    bg: '#1d4ed8',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <circle cx="6.5" cy="7" r="2.4" />
        <circle cx="13.5" cy="7" r="2.4" />
        <path d="M2 16c0-2.2 2-4 4.5-4S11 13.8 11 16" />
        <path d="M9 16c0-2.2 2-4 4.5-4S18 13.8 18 16" />
      </svg>
    ),
    path: '/workforce',
  },
  {
    id: 'field',
    name: 'Field',
    bg: '#059669',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <path d="M19 15a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3l2-2.5h4L14 5h3a2 2 0 0 1 2 2z" />
        <circle cx="10" cy="11" r="3" />
      </svg>
    ),
    path: '/field',
  },
  {
    id: 'inventory',
    name: 'Inventory',
    bg: '#b45309',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <polyline points="2,6 10,11 18,6" />
        <path d="M2 6l8-4 8 4v8l-8 4-8-4V6z" />
        <line x1="10" y1="11" x2="10" y2="19" />
      </svg>
    ),
    path: '/inventory',
  },
  {
    id: 'account',
    name: 'Account',
    bg: '#475569',
    workerOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <circle cx="10" cy="7" r="3.5" />
        <path d="M2.5 17c0-3.6 3.4-6.5 7.5-6.5s7.5 2.9 7.5 6.5" />
      </svg>
    ),
    path: '/account',
  },
  {
    id: 'team',
    name: 'Team',
    bg: '#0284c7',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <circle cx="7" cy="7.5" r="2.6" />
        <circle cx="13.5" cy="7.5" r="2.6" />
        <path d="M2.5 17c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" />
        <path d="M9 17c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" />
      </svg>
    ),
    path: '/team',
  },
  {
    id: 'projects',
    name: 'Projects',
    bg: '#7c3aed',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <rect x="2.5" y="2.5" width="6" height="6" rx="1" />
        <rect x="11.5" y="2.5" width="6" height="6" rx="1" />
        <rect x="2.5" y="11.5" width="6" height="6" rx="1" />
        <rect x="11.5" y="11.5" width="6" height="6" rx="1" />
      </svg>
    ),
    path: '/projects',
  },
  {
    id: 'sales',
    name: 'Sales',
    bg: '#0891b2',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <path d="M3 6h14l-1.5 9.5h-11L3 6z" />
        <path d="M7 6V4a3 3 0 0 1 6 0v2" />
        <circle cx="7" cy="10" r="0.5" />
        <circle cx="13" cy="10" r="0.5" />
      </svg>
    ),
    path: '/sales',
  },
  {
    id: 'administration',
    name: 'Administration',
    bg: '#475569',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <path d="M10 2L3 5.5v4.5c0 4.2 3 7.9 7 9 4-1.1 7-4.8 7-9V5.5L10 2z" />
      </svg>
    ),
    path: '/administration',
  },
  {
    id: 'analytics',
    name: 'Analytics',
    bg: '#0e7490',
    adminOnly: true,
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
        <polyline points="2,15 7,9 11,12 18,5" />
        <polyline points="14,5 18,5 18,9" />
      </svg>
    ),
    path: '/analytics',
  },
];

export default function AppSwitcher({ currentApp = 'timeclock', userRole, features = {} }) {
  const t = useT();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const isAdmin = userRole === 'admin' || userRole === 'super_admin';
  const labelFor = app => {
    if (app.id === 'field') return features?.label_field || app.name;
    if (app.id === 'projects') return features?.label_work || app.name;
    return app.name;
  };
  const visibleApps = APPS.filter(a => {
    if (a.adminOnly && !isAdmin) return false;
    if (a.workerOnly && isAdmin) return false;
    // Company-level feature toggles (admin choice). These hide modules
    // entirely regardless of user perms — the company doesn't use the feature.
    if (a.id === 'field' && features?.module_field === false) return false;
    if (a.id === 'projects' && features?.module_projects === false) return false;
    if (a.id === 'inventory' && features?.module_inventory === false) return false;
    if (a.id === 'analytics' && features?.module_analytics === false) return false;
    if (a.id === 'team' && features?.module_team === false) return false;
    // module_timeclock now gates the admin oversight page (Workforce). Time
    // Clock itself stays visible to everyone — workers always need it, and
    // admins use it for their own time-tracking even if oversight is off.
    if (a.id === 'workforce' && features?.module_timeclock === false) return false;
    // Phase D: per-user permission gate. A user with zero perms inside a
    // module shouldn't see it at all. Account is always shown.
    if (!userCanSeeModule(user, a.id)) return false;
    return true;
  });
  const current = APPS.find(a => a.id === currentApp) || APPS[0];

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const navigate = app => {
    setOpen(false);
    if (app.soon) return;
    window.location.href = app.path;
  };

  return (
    <div ref={ref} style={styles.wrap}>
      <button style={styles.trigger} onClick={() => setOpen(o => !o)}>
        <div style={{ ...styles.appIcon, background: current.bg }}>{current.icon}</div>
        <span style={styles.appName} className="app-switcher-name">{labelFor(current)}</span>
        <svg style={{ ...styles.chevron, transform: open ? 'rotate(180deg)' : 'none' }}
          viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="12" height="12">
          <polyline points="2,4 6,8 10,4" />
        </svg>
      </button>

      {open && (
        <div style={styles.dropdown}>
          {visibleApps.map(app => (
            <button
              key={app.id}
              style={{
                ...styles.item,
                ...(app.id === currentApp ? styles.itemActive : {}),
                ...(app.soon ? styles.itemSoon : {}),
              }}
              onClick={() => navigate(app)}
            >
              <div style={{ ...styles.itemIcon, background: app.soon ? '#e5e7eb' : app.bg }}>
                {app.icon}
              </div>
              <span style={{ ...styles.itemName, color: app.soon ? '#9ca3af' : '#111827' }}>{labelFor(app)}</span>
              {app.soon && <span style={styles.soonBadge}>{t.comingSoon}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { position: 'relative' },
  trigger: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#f8fafc', border: '1px solid #cbd5e1',
    borderRadius: 999, padding: '5px 12px 5px 6px',
    color: '#0f172a', cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s',
  },
  appIcon: {
    width: 28, height: 28, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  appName: { fontWeight: 800, fontSize: 15, letterSpacing: 0 },
  chevron: { opacity: 0.8, transition: 'transform 0.2s', color: '#475569' },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 8px)', left: 0,
    background: '#fff', borderRadius: 10, boxShadow: '0 16px 42px rgba(15,23,42,0.14)',
    border: '1px solid #e2e8f0', padding: 6, minWidth: 220, zIndex: 1000,
  },
  item: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%', padding: '10px 12px', border: 'none',
    background: 'none', borderRadius: 9, cursor: 'pointer',
    textAlign: 'left', transition: 'background 0.1s',
  },
  itemActive: { background: '#f1f5f9' },
  itemSoon: { cursor: 'default' },
  itemIcon: {
    width: 36, height: 36, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  itemName: { fontWeight: 600, fontSize: 15, color: '#111827', flex: 1 },
  soonBadge: { fontSize: 10, fontWeight: 700, color: '#6b7280', background: '#f3f4f6', padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
};
