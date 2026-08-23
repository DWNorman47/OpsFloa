import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { playMessageChime } from '../chime';
import { silentError } from '../errorReporter';
import { safeLocal } from '../utils/safeStorage';
import { setChatUnread } from '../chatUnreadStore';

/**
 * Speech-bubble bell that sits to the LEFT of the notifications bell. Its badge
 * counts unread chat messages and its dropdown lists them, styled to match
 * NotificationBell.
 *
 * Unread state reuses the same client-side localStorage keys that drive the
 * Messages / Live tab dots, so the bell, the dots, and CompanyChat stay in sync:
 *   - Worker: single `chatLastRead` timestamp for their own thread.
 *   - Admin:  per-worker `chatLastRead_admin_<worker_id>` timestamps.
 *
 * When a new unread message appears since the previous poll, it plays a short
 * in-app chime (the device push handles sound/vibration when the app is closed).
 */
export default function MessagesBell() {
  const t = useT();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [items, setItems] = useState([]); // normalized unread items
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const prevKeysRef = useRef(new Set());
  const firstLoadRef = useRef(true);

  const load = useCallback(() => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    Promise.all([
      api.get('/chat').then(r => r.data || []).catch(() => []),
      api.get('/dm/contacts').then(r => r.data?.contacts || []).catch(() => []),
    ]).then(([data, contacts]) => {
      let unread;
      if (isAdmin) {
        // Admin sees a list of worker threads; a thread is unread when its last
        // message is newer than the last time this admin opened it.
        unread = data
          .filter(thread => {
            const lr = safeLocal.getItem(`chatLastRead_admin_${thread.worker_id}`);
            return !lr || new Date(thread.last_at) > new Date(lr);
          })
          .map(thread => ({
            key: `t${thread.worker_id}:${thread.last_at}`,
            title: thread.worker_name,
            body: thread.last_message,
            time: thread.last_at,
            readKey: `chatLastRead_admin_${thread.worker_id}`,
          }));
      } else {
        // Worker has a single thread; unread = messages from someone else newer
        // than their last read timestamp.
        const lastRead = safeLocal.getItem('chatLastRead');
        unread = data
          .filter(m => m.sender_id !== user?.id && (!lastRead || new Date(m.created_at) > new Date(lastRead)))
          .map(m => ({
            key: `m${m.id}`,
            title: m.sender_name,
            body: m.body,
            time: m.created_at,
            readKey: 'chatLastRead',
          }));
      }

      // Publish the company-chat unread signal (not DMs) so the Dashboard's
      // Messages-tab dot can read it instead of polling /chat a second time.
      setChatUnread(unread.length > 0);

      // Direct-message unread (from /dm/contacts; server-authoritative). These
      // clear when the user opens that conversation (server stamps read_at), so
      // they carry no localStorage readKey.
      const dmItems = contacts.filter(c => c.unread > 0).map(c => ({
        key: `dm${c.id}:${c.last_at}`,
        title: c.full_name,
        body: c.last_message,
        time: c.last_at,
        readKey: null,
      }));
      const all = [...unread, ...dmItems];

      // Chime when something new showed up since the previous poll (never on the
      // first load, so opening the app doesn't blast the chime for old messages).
      const keys = all.map(u => u.key);
      if (!firstLoadRef.current && keys.some(k => !prevKeysRef.current.has(k))) {
        playMessageChime();
      }
      prevKeysRef.current = new Set(keys);
      firstLoadRef.current = false;

      setItems(all);
    }).catch(silentError('messagesbell'));
  }, [isAdmin, user?.id]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 40000);
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

  const unread = items.length;

  const markAllRead = () => {
    const now = new Date().toISOString();
    // Set every relevant read key to now so the badge, the tab dots, and
    // CompanyChat all agree the thread(s) have been seen.
    const keys = new Set(items.map(i => i.readKey).filter(Boolean));
    keys.forEach(k => safeLocal.setItem(k, now));
    prevKeysRef.current = new Set();
    setItems([]);
  };

  const handleItemClick = (item) => {
    safeLocal.setItem(item.readKey, new Date().toISOString());
    setItems(prev => prev.filter(i => i.readKey !== item.readKey));
    setOpen(false);
    // Both worker messages and admin workforce chat live under /timeclock. Using
    // location.assign fires a hashchange on the same page (no reload) and does a
    // full navigation from another page — either way the right tab opens.
    window.location.assign(isAdmin ? '/timeclock#wf-live' : '/timeclock#messages');
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
      <button style={styles.bell} onClick={() => setOpen(o => !o)} aria-label={t.tabMessages}>
        <BubbleIcon />
        {unread > 0 && <span style={styles.badge}>{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div style={styles.dropdown} className="notification-dropdown">
          <div style={styles.dropHeader}>
            <span style={styles.dropTitle}>{t.tabMessages}</span>
            {unread > 0 && (
              <button style={styles.markAllBtn} onClick={markAllRead}>{t.markAllRead}</button>
            )}
          </div>

          {items.length === 0 ? (
            <div style={styles.empty}>{t.noUnreadMessages}</div>
          ) : (
            <div style={styles.list}>
              {items.map(item => (
                <div
                  key={item.key}
                  style={{ ...styles.item, ...styles.itemUnread }}
                  onClick={() => handleItemClick(item)}
                >
                  <div style={styles.itemDot}><span style={styles.dot} /></div>
                  <div style={styles.itemBody}>
                    <div style={styles.itemTitle}>{item.title}</div>
                    {item.body && <div style={styles.itemText}>{item.body}</div>}
                    <div style={styles.itemTime}>{fmtTime(item.time)}</div>
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

function BubbleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
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
  itemText: { fontSize: 12, color: '#6b7280', marginBottom: 3, whiteSpace: 'pre-line', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  itemTime: { fontSize: 11, color: '#6b7280' },
};
