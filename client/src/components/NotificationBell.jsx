import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';

import { silentError } from '../errorReporter';
export default function NotificationBell() {
  const t = useT();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const load = useCallback(() => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    api.get('/inbox').then(r => setItems(r.data)).catch(silentError('notificationbell'));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    document.addEventListener('visibilitychange', load);
    window.addEventListener('online', load);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', load);
      window.removeEventListener('online', load);
    };
  }, [load]);

  // Close when clicking outside
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const unread = items.filter(i => !i.read_at).length;

  const markRead = async (id) => {
    await api.patch(`/inbox/${id}/read`).catch(silentError('notificationbell'));
    setItems(prev => prev.map(i => i.id === id ? { ...i, read_at: new Date().toISOString() } : i));
  };

  const markAllRead = async () => {
    await api.patch('/inbox/read-all').catch(silentError('notificationbell'));
    setItems(prev => prev.map(i => ({ ...i, read_at: i.read_at || new Date().toISOString() })));
  };

  const handleItemClick = async (item) => {
    if (!item.read_at) await markRead(item.id);
    if (item.link) window.location.hash = item.link;
    setOpen(false);
  };

  const fmtTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMin = Math.floor((now - d) / 60000);
    if (diffMin < 1) return t.justNow;
    if (diffMin < 60) return t.minutesAgo.replace('{n}', diffMin);
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return t.hoursAgo.replace('{n}', diffH);
    return d.toLocaleDateString();
  };

  return (
    <div ref={ref} style={styles.wrap}>
      <button style={styles.bell} onClick={() => setOpen(o => !o)} aria-label={t.notifAriaLabel}>
        <BellIcon />
        {unread > 0 && <span style={styles.badge}>{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div style={styles.dropdown} className="notification-dropdown">
          <div style={styles.dropHeader}>
            <span style={styles.dropTitle}>{t.notifications}</span>
            {unread > 0 && (
              <button style={styles.markAllBtn} onClick={markAllRead}>{t.markAllRead}</button>
            )}
          </div>

          {items.length === 0 ? (
            <div style={styles.empty}>{t.noNotificationsYet}</div>
          ) : (
            <div style={styles.list}>
              {items.map(item => (
                <div
                  key={item.id}
                  style={{ ...styles.item, ...(item.read_at ? {} : styles.itemUnread) }}
                  onClick={() => handleItemClick(item)}
                >
                  <div style={styles.itemDot}>
                    {!item.read_at && <span style={styles.dot} />}
                  </div>
                  <div style={styles.itemBody}>
                    <div style={styles.itemTitle}>{item.title}</div>
                    {item.body && <div style={styles.itemText}>{item.body}</div>}
                    <div style={styles.itemTime}>{fmtTime(item.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

const styles = {
  wrap: { position: 'relative' },
  bell: {
    position: 'relative', background: 'none', border: 'none', cursor: 'pointer',
    color: '#475569', padding: '6px', borderRadius: 8, display: 'flex', alignItems: 'center',
    transition: 'color 0.15s',
  },
  badge: {
    position: 'absolute', top: 2, right: 2,
    background: '#ef4444', color: '#fff', borderRadius: 10,
    fontSize: 10, fontWeight: 700, minWidth: 16, height: 16,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 3px',
  },
  dropdown: {
    position: 'absolute', right: 0, top: 'calc(100% + 8px)',
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
    boxShadow: '0 8px 30px rgba(0,0,0,0.12)', width: 320, zIndex: 200,
    overflow: 'hidden',
  },
  dropHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 16px 10px', borderBottom: '1px solid #f3f4f6',
  },
  dropTitle: { fontSize: 14, fontWeight: 700, color: '#111827' },
  markAllBtn: {
    background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontSize: 12,
    fontWeight: 600, cursor: 'pointer', padding: 0,
  },
  list: { maxHeight: 380, overflowY: 'auto' },
  empty: { padding: '24px 16px', textAlign: 'center', color: '#6b7280', fontSize: 13 },
  item: {
    display: 'flex', gap: 10, padding: '12px 16px', cursor: 'pointer',
    borderBottom: '1px solid #f9fafb', transition: 'background 0.1s',
  },
  itemUnread: { background: '#f0f7ff' },
  itemDot: { width: 10, flexShrink: 0, paddingTop: 4, display: 'flex', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: '50%', background: 'var(--ops-page-accent)', display: 'block' },
  itemBody: { flex: 1, minWidth: 0 },
  itemTitle: { fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 2 },
  itemText: { fontSize: 12, color: '#6b7280', marginBottom: 3, whiteSpace: 'pre-line' },
  itemTime: { fontSize: 11, color: '#6b7280' },
};
