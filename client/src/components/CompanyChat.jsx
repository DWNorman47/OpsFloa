import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import { labelSg } from '../companyLabels';

import { silentError } from '../errorReporter';
import { safeLocal } from '../utils/safeStorage';
function formatTime(str, locale = 'en-US') {
  return new Date(str).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Worker view — shows their own private thread with admin
function WorkerChat({ settings, onRead }) {
  const { user } = useAuth();
  const t = useT();
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const locale = langToLocale(user?.language);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef(null);
  const pollRef = useRef(null);

  const load = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) {
      setLoading(false);
      return Promise.resolve();
    }
    return api.get('/chat').then(r => {
      setMessages(r.data);
      onRead?.();
    }).catch(silentError('companychat')).finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 30000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(pollRef.current); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  useEffect(() => {
    if (bottomRef.current) {
      const container = bottomRef.current.parentElement;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const send = async e => {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    try {
      const r = await api.post('/chat', { body });
      setMessages(prev => [...prev, r.data]);
      setBody('');
    } finally { setSending(false); }
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.title}>💬 {t.chatMessagesWithAdmin}</span>
        <span style={styles.sub}>{t.chatPrivateNote.replace('worker', workerLabel.toLowerCase())}</span>
      </div>
      <Thread messages={messages} loading={loading} currentUserId={user?.id} bottomRef={bottomRef} t={t} locale={locale} />
      <ChatForm body={body} setBody={setBody} sending={sending} onSubmit={send} t={t} />
    </div>
  );
}

// Admin view — worker picker + thread
function AdminChat({ workers, settings }) {
  const { user } = useAuth();
  const t = useT();
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const locale = langToLocale(user?.language);
  const [selectedId, setSelectedId] = useState('');
  const [threads, setThreads] = useState([]); // workers with recent messages
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unreadByWorker, setUnreadByWorker] = useState({}); // workerId → last_at of unread message
  const bottomRef = useRef(null);
  const pollRef = useRef(null);

  // Load worker thread list and check for unread
  const loadThreads = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return Promise.resolve();
    return api.get('/chat').then(r => {
      setThreads(r.data);
      // Compare thread last_at against per-worker last-read stored in localStorage
      const unread = {};
      r.data.forEach(thread => {
        const key = `chatLastRead_admin_${thread.worker_id}`;
        const lastRead = safeLocal.getItem(key);
        if (!lastRead || new Date(thread.last_at) > new Date(lastRead)) {
          unread[thread.worker_id] = true;
        }
      });
      setUnreadByWorker(unread);
    }).catch(silentError('companychat'));
  };

  useEffect(() => {
    loadThreads();
    const iv = setInterval(loadThreads, 60000);
    document.addEventListener('visibilitychange', loadThreads);
    window.addEventListener('online', loadThreads);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', loadThreads);
      window.removeEventListener('online', loadThreads);
    };
  }, []);

  // Load selected worker's thread
  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    setLoading(true);
    clearInterval(pollRef.current);
    const fetch = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) {
        setLoading(false);
        return Promise.resolve();
      }
      return api.get(`/chat?worker_id=${selectedId}`).then(r => {
        setMessages(r.data);
        // Mark as read
        safeLocal.setItem(`chatLastRead_admin_${selectedId}`, new Date().toISOString());
        setUnreadByWorker(prev => { const n = { ...prev }; delete n[selectedId]; return n; });
      }).catch(silentError('companychat')).finally(() => setLoading(false));
    };
    fetch();
    pollRef.current = setInterval(fetch, 30000);
    document.addEventListener('visibilitychange', fetch);
    window.addEventListener('online', fetch);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', fetch);
      window.removeEventListener('online', fetch);
    };
  }, [selectedId]);

  useEffect(() => {
    if (bottomRef.current) {
      const container = bottomRef.current.parentElement;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const send = async e => {
    e.preventDefault();
    if (!body.trim() || !selectedId) return;
    setSending(true);
    try {
      const r = await api.post('/chat', { body, worker_id: selectedId });
      setMessages(prev => [...prev, r.data]);
      setBody('');
    } finally { setSending(false); }
  };

  const workerHasThread = id => threads.some(t => String(t.worker_id) === String(id));

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.title}>💬 {workerLabel} messages</span>
        <span style={styles.sub}>{t.chatAdminPrivateNote}</span>
      </div>
      <div style={styles.workerPicker}>
        <select style={styles.pickerSelect} value={selectedId} onChange={e => setSelectedId(e.target.value)}>
          <option value="">Select {workerLabel.toLowerCase()}</option>
          {workers.filter(w => w.role !== 'admin').map(w => (
            <option key={w.id} value={w.id}>
              {w.full_name}{workerHasThread(w.id) ? ' 💬' : ''}{unreadByWorker[w.id] ? ' 🔴' : ''}
            </option>
          ))}
        </select>
      </div>
      {selectedId ? (
        <>
          <Thread messages={messages} loading={loading} currentUserId={user?.id} bottomRef={bottomRef} t={t} locale={locale} />
          <ChatForm body={body} setBody={setBody} sending={sending} onSubmit={send} t={t} />
        </>
      ) : (
        <p style={styles.hint}>{t.chatSelectHint}</p>
      )}
    </div>
  );
}

function Thread({ messages, loading, currentUserId, bottomRef, t, locale }) {
  return (
    <div style={styles.thread}>
      {loading ? (
        <p style={styles.hintCenter}>{t.loading}</p>
      ) : messages.length === 0 ? (
        <p style={styles.hintCenter}>{t.chatNoMessages}</p>
      ) : (
        messages.map(m => {
          const isMine = m.sender_id === currentUserId;
          return (
            <div key={m.id} style={{ ...styles.bubbleWrap, justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
              <div style={{ ...styles.bubble, ...(isMine ? styles.bubbleMine : styles.bubbleTheirs) }}>
                <div style={styles.meta}>
                  <span style={styles.sender}>
                    {isMine ? t.chatYou : m.sender_name}
                    {m.sender_role === 'admin' && !isMine && <span style={styles.adminBadge}> {t.chatAdminBadge}</span>}
                  </span>
                  <span style={styles.time}>{formatTime(m.created_at, locale)}</span>
                </div>
                <div style={styles.msgBody}>{m.body}</div>
              </div>
            </div>
          );
        })
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function ChatForm({ body, setBody, sending, onSubmit, t }) {
  return (
    <form onSubmit={onSubmit} style={styles.form}>
      <input
        style={styles.input}
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder={t.chatPlaceholder}
        maxLength={1000}
        disabled={sending}
      />
      <button style={{ ...styles.sendBtn, ...((sending || !body.trim()) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={sending || !body.trim()}>
        {sending ? t.sending : t.chatSend}
      </button>
    </form>
  );
}

export default function CompanyChat({ workers, settings, onRead }) {
  const { user } = useAuth();
  if (!user) return null;
  if (user.role === 'admin') return <AdminChat workers={workers || []} settings={settings} />;
  return <WorkerChat userId={user.id} settings={settings} onRead={onRead} />;
}

const styles = {
  wrap: { background: '#fff', borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { padding: '14px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', gap: 2 },
  title: { fontWeight: 700, fontSize: 15, color: '#1a1a1a' },
  sub: { fontSize: 11, color: '#6b7280' },
  workerPicker: { padding: '10px 14px', borderBottom: '1px solid #f0f0f0' },
  pickerSelect: { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, color: '#374151' },
  thread: { flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 200, maxHeight: 340, background: '#fafafa' },
  hint: { padding: '16px', color: '#6b7280', fontSize: 13 },
  hintCenter: { color: '#6b7280', fontSize: 13, textAlign: 'center', margin: 'auto' },
  bubbleWrap: { display: 'flex' },
  bubble: { maxWidth: '80%', padding: '8px 12px', borderRadius: 10, fontSize: 13 },
  bubbleMine: { background: '#dbeafe', color: '#1e3a5f', borderBottomRightRadius: 3 },
  bubbleTheirs: { background: '#fff', border: '1px solid #e5e7eb', color: '#374151', borderBottomLeftRadius: 3 },
  meta: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 3 },
  sender: { fontSize: 11, fontWeight: 700, color: '#6b7280' },
  adminBadge: { background: 'var(--ops-page-accent)', color: '#fff', borderRadius: 4, padding: '1px 5px', fontSize: 9, fontWeight: 700, marginLeft: 4 },
  time: { fontSize: 10, color: '#6b7280' },
  msgBody: { lineHeight: 1.5 },
  form: { display: 'flex', borderTop: '1px solid #e5e7eb' },
  input: { flex: 1, padding: '10px 14px', border: 'none', fontSize: 13, outline: 'none', background: '#fff' },
  sendBtn: { padding: '10px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 },
};
