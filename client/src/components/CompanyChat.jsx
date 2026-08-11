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

// Worker view — the shared "Admins" thread (company_chat) plus 1:1 direct
// messages with specific people (/api/dm), when the company setting allows it.
// active === 'admins' → the collective thread; a number → a DM with that user.
function WorkerChat({ settings, onRead }) {
  const { user } = useAuth();
  const t = useT();
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const locale = langToLocale(user?.language);
  const [contacts, setContacts] = useState([]);
  const [active, setActive] = useState('admins');
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef(null);
  const pollRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const loadContacts = () => api.get('/dm/contacts').then(r => setContacts(r.data?.contacts || [])).catch(silentError('companychat'));

  const load = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) { setLoading(false); return Promise.resolve(); }
    const cur = activeRef.current;
    if (cur === 'admins') {
      return api.get('/chat').then(r => { setMessages(r.data); onRead?.(); }).catch(silentError('companychat')).finally(() => setLoading(false));
    }
    return api.get(`/dm/${cur}`).then(r => { setMessages(r.data?.messages || []); }).catch(silentError('companychat')).finally(() => setLoading(false));
  };

  useEffect(() => { loadContacts(); const iv = setInterval(loadContacts, 60000); return () => clearInterval(iv); }, []);

  // (Re)load the active thread when the selection changes + poll it.
  useEffect(() => {
    setLoading(true);
    clearInterval(pollRef.current);
    load();
    pollRef.current = setInterval(load, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(pollRef.current); document.removeEventListener('visibilitychange', onVisible); };
  }, [active]);

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
      const r = active === 'admins'
        ? await api.post('/chat', { body })
        : await api.post(`/dm/${active}`, { body });
      setMessages(prev => [...prev, r.data]);
      setBody('');
      if (active !== 'admins') loadContacts();
    } catch (err) {
      // eslint-disable-next-line no-alert
      if (err?.response?.status === 403) alert(err.response.data?.error || t.chatBlocked);
    } finally { setSending(false); }
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.title}>💬 {t.chatMessagesWithAdmin}</span>
        <span style={styles.sub}>{t.chatPrivateNote.replace('worker', workerLabel.toLowerCase())}</span>
      </div>
      {contacts.length > 0 && (
        <div style={styles.workerPicker}>
          <select style={styles.pickerSelect} value={String(active)} onChange={e => { setActive(e.target.value === 'admins' ? 'admins' : Number(e.target.value)); setBody(''); }}>
            <option value="admins">🏢 {t.chatAdminsOption}</option>
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.full_name}{c.role === 'admin' ? ` · ${t.chatAdminBadge}` : ''}{c.unread ? ` 🔴 ${c.unread}` : ''}</option>
            ))}
          </select>
        </div>
      )}
      <Thread messages={messages} loading={loading} currentUserId={user?.id} bottomRef={bottomRef} t={t} locale={locale} />
      <ChatForm body={body} setBody={setBody} sending={sending} onSubmit={send} t={t} />
    </div>
  );
}

// Admin view — a recipient picker with two groups: the worker company_chat
// threads (value "w:<id>") and 1:1 direct messages (value "d:<id>", other admins
// + anyone who has DM'd this admin).
function AdminChat({ workers, settings }) {
  const { user } = useAuth();
  const t = useT();
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const locale = langToLocale(user?.language);
  const [selected, setSelected] = useState(''); // '' | 'w:<id>' | 'd:<id>'
  const [threads, setThreads] = useState([]);
  const [dmContacts, setDmContacts] = useState([]);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unreadByWorker, setUnreadByWorker] = useState({});
  const bottomRef = useRef(null);
  const pollRef = useRef(null);

  const loadThreads = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return Promise.resolve();
    return api.get('/chat').then(r => {
      setThreads(r.data);
      const unread = {};
      r.data.forEach(thread => {
        const key = `chatLastRead_admin_${thread.worker_id}`;
        const lastRead = safeLocal.getItem(key);
        if (!lastRead || new Date(thread.last_at) > new Date(lastRead)) unread[thread.worker_id] = true;
      });
      setUnreadByWorker(unread);
    }).catch(silentError('companychat'));
  };
  const loadContacts = () => api.get('/dm/contacts').then(r => setDmContacts(r.data?.contacts || [])).catch(silentError('companychat'));

  useEffect(() => {
    loadThreads(); loadContacts();
    const iv = setInterval(() => { loadThreads(); loadContacts(); }, 60000);
    const onVis = () => { loadThreads(); loadContacts(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', onVis); };
  }, []);

  // Load the selected thread (worker company_chat or a DM) + poll it.
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    setLoading(true);
    clearInterval(pollRef.current);
    const kind = selected.startsWith('d:') ? 'dm' : 'worker';
    const otherId = selected.slice(2);
    const fetch = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) { setLoading(false); return Promise.resolve(); }
      if (kind === 'worker') {
        return api.get(`/chat?worker_id=${otherId}`).then(r => {
          setMessages(r.data);
          safeLocal.setItem(`chatLastRead_admin_${otherId}`, new Date().toISOString());
          setUnreadByWorker(prev => { const n = { ...prev }; delete n[otherId]; return n; });
        }).catch(silentError('companychat')).finally(() => setLoading(false));
      }
      return api.get(`/dm/${otherId}`).then(r => { setMessages(r.data?.messages || []); loadContacts(); }).catch(silentError('companychat')).finally(() => setLoading(false));
    };
    fetch();
    pollRef.current = setInterval(fetch, 30000);
    document.addEventListener('visibilitychange', fetch);
    window.addEventListener('online', fetch);
    return () => { clearInterval(pollRef.current); document.removeEventListener('visibilitychange', fetch); window.removeEventListener('online', fetch); };
  }, [selected]);

  useEffect(() => {
    if (bottomRef.current) {
      const container = bottomRef.current.parentElement;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const send = async e => {
    e.preventDefault();
    if (!body.trim() || !selected) return;
    setSending(true);
    try {
      const kind = selected.startsWith('d:') ? 'dm' : 'worker';
      const otherId = selected.slice(2);
      const r = kind === 'worker'
        ? await api.post('/chat', { body, worker_id: otherId })
        : await api.post(`/dm/${otherId}`, { body });
      setMessages(prev => [...prev, r.data]);
      setBody('');
    } catch (err) {
      // eslint-disable-next-line no-alert
      if (err?.response?.status === 403) alert(err.response.data?.error || t.chatBlocked);
    } finally { setSending(false); }
  };

  const workerHasThread = id => threads.some(th => String(th.worker_id) === String(id));
  // Admins reach workers via the company_chat thread; the DM group shows other
  // admins (to start a DM) + anyone who already has a DM thread with this admin.
  const dmList = dmContacts.filter(c => c.role === 'admin' || c.last_at);

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <span style={styles.title}>💬 {workerLabel} messages</span>
        <span style={styles.sub}>{t.chatAdminPrivateNote}</span>
      </div>
      <div style={styles.workerPicker}>
        <select style={styles.pickerSelect} value={selected} onChange={e => { setSelected(e.target.value); setBody(''); }}>
          <option value="">{t.chatSelectRecipient}</option>
          <optgroup label={`${workerLabel} ${t.chatThreadsGroup}`}>
            {workers.filter(w => w.role !== 'admin').map(w => (
              <option key={`w${w.id}`} value={`w:${w.id}`}>{w.full_name}{workerHasThread(w.id) ? ' 💬' : ''}{unreadByWorker[w.id] ? ' 🔴' : ''}</option>
            ))}
          </optgroup>
          {dmList.length > 0 && (
            <optgroup label={t.chatDmGroup}>
              {dmList.map(c => (
                <option key={`d${c.id}`} value={`d:${c.id}`}>{c.full_name}{c.role === 'admin' ? ` · ${t.chatAdminBadge}` : ''}{c.unread ? ` 🔴 ${c.unread}` : ''}</option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {selected ? (
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
