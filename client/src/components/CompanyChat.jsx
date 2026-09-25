import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import { labelSg } from '../companyLabels';

import { silentError } from '../errorReporter';
import { syncLegacyAdminReadKey } from '../chatReadSync';
// Server page size (server/routes/chat.js PAGE_SIZE): a thread fetch returns the NEWEST page;
// `?before=<oldest id>` pages back. (DMs report `has_more` themselves.)
const CHAT_PAGE = 100;

// A poll returns the newest page — keep any older messages the user already paged in.
function mergeNewest(prev, page) {
  if (!page.length) return page;
  const minId = page[0].id;
  return [...prev.filter(m => m.id < minId), ...page];
}
function prependOlder(prev, older) {
  const have = new Set(prev.map(m => m.id));
  return [...older.filter(m => !have.has(m.id)), ...prev];
}

// After new messages: stick to the bottom — unless older ones were just prepended, in which
// case keep the reader where they were (same distance from the bottom as before).
function scrollThread(bottomRef, keepScrollRef) {
  const container = bottomRef.current?.parentElement;
  if (!container) return;
  if (keepScrollRef.current != null) {
    container.scrollTop = container.scrollHeight - keepScrollRef.current;
    keepScrollRef.current = null;
    return;
  }
  container.scrollTop = container.scrollHeight;
}

function formatTime(str, locale = 'en-US') {
  return new Date(str).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Map a failed send to a bilingual message. The server returns a stable `code` alongside its
// English `error` (kept for API consumers); the UI never shows the raw English text.
function chatSendErrorText(err, t) {
  const code = err?.response?.data?.code;
  if (code === 'chat_muted') return t.chatErrMuted;
  if (code === 'worker_not_in_scope') return t.chatErrWorkerScope;
  if (err?.response?.status === 403) return t.chatBlocked;
  return t.chatErrSendFailed;
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
  const [sendError, setSendError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const bottomRef = useRef(null);
  const pollRef = useRef(null);
  const olderLoadedRef = useRef(false);
  const keepScrollRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const loadContacts = () => api.get('/dm/contacts').then(r => setContacts(r.data?.contacts || [])).catch(silentError('companychat'));

  const load = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) { setLoading(false); return Promise.resolve(); }
    const cur = activeRef.current;
    // The user may switch threads while this request is in flight — drop a
    // response for a thread that's no longer selected so it can't overwrite
    // the new thread's messages.
    const stale = () => activeRef.current !== cur;
    const done = () => { if (!stale()) setLoading(false); };
    if (cur === 'admins') {
      return api.get('/chat').then(r => {
        if (stale()) return;
        const page = r.data || [];
        setMessages(prev => mergeNewest(prev, page));
        if (!olderLoadedRef.current) setHasOlder(page.length >= CHAT_PAGE);
        onRead?.();
      }).catch(silentError('companychat')).finally(done);
    }
    return api.get(`/dm/${cur}`).then(r => {
      if (stale()) return;
      setMessages(prev => mergeNewest(prev, r.data?.messages || []));
      if (!olderLoadedRef.current) setHasOlder(!!r.data?.has_more);
    }).catch(silentError('companychat')).finally(done);
  };

  const loadOlder = async (container) => {
    const target = activeRef.current;
    const oldest = messages[0]?.id;
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      let older; let more;
      if (target === 'admins') {
        const r = await api.get('/chat', { params: { before: oldest } });
        older = r.data || []; more = older.length >= CHAT_PAGE;
      } else {
        const r = await api.get(`/dm/${target}`, { params: { before: oldest } });
        older = r.data?.messages || []; more = !!r.data?.has_more;
      }
      if (activeRef.current !== target) return;
      olderLoadedRef.current = true;
      keepScrollRef.current = container ? container.scrollHeight - container.scrollTop : null;
      setMessages(prev => prependOlder(prev, older));
      setHasOlder(more);
    } catch (err) {
      silentError('companychat')(err);
    } finally { setLoadingOlder(false); }
  };

  useEffect(() => { loadContacts(); const iv = setInterval(loadContacts, 60000); return () => clearInterval(iv); }, []);

  // (Re)load the active thread when the selection changes + poll it.
  useEffect(() => {
    setLoading(true);
    setMessages([]); // don't show the previous thread's messages while this one loads
    setHasOlder(false);
    olderLoadedRef.current = false;
    clearInterval(pollRef.current);
    load();
    pollRef.current = setInterval(load, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(pollRef.current); document.removeEventListener('visibilitychange', onVisible); };
  }, [active]);

  useEffect(() => { scrollThread(bottomRef, keepScrollRef); }, [messages]);

  const send = async e => {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    setSendError('');
    const target = active;
    try {
      const r = target === 'admins'
        ? await api.post('/chat', { body })
        : await api.post(`/dm/${target}`, { body });
      // Only append if the user is still on the thread the message went to.
      if (activeRef.current === target) setMessages(prev => [...prev, r.data]);
      setBody('');
      if (active !== 'admins') loadContacts();
    } catch (err) {
      setSendError(chatSendErrorText(err, t));
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
          <select style={styles.pickerSelect} value={String(active)} onChange={e => { setActive(e.target.value === 'admins' ? 'admins' : Number(e.target.value)); setBody(''); setSendError(''); }}>
            <option value="admins">🏢 {t.chatAdminsOption}</option>
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.full_name}{c.role === 'admin' ? ` · ${t.chatAdminBadge}` : ''}{c.unread ? ` 🔴 ${c.unread}` : ''}</option>
            ))}
          </select>
        </div>
      )}
      <Thread messages={messages} loading={loading} currentUserId={user?.id} bottomRef={bottomRef} t={t} locale={locale}
        hasOlder={hasOlder} loadingOlder={loadingOlder} onLoadOlder={loadOlder} />
      <ChatForm body={body} setBody={setBody} sending={sending} onSubmit={send} t={t} error={sendError} />
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
  const [sendError, setSendError] = useState('');
  const [loading, setLoading] = useState(false);
  const [unreadByWorker, setUnreadByWorker] = useState({});
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const bottomRef = useRef(null);
  const pollRef = useRef(null);
  const olderLoadedRef = useRef(false);
  const keepScrollRef = useRef(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Unread is server-side (per-admin read markers): `unread` counts the WORKER's messages this
  // admin hasn't seen — their own / other admins' replies never count, on any device.
  const loadThreads = () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return Promise.resolve();
    return api.get('/chat').then(r => {
      const list = r.data || [];
      setThreads(list);
      const unread = {};
      list.forEach(thread => {
        if (thread.unread > 0) unread[thread.worker_id] = true;
        syncLegacyAdminReadKey(thread);
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
    setMessages([]); // never show the previous thread's messages under the new one
    setHasOlder(false);
    olderLoadedRef.current = false;
    if (!selected) return undefined;
    setLoading(true);
    clearInterval(pollRef.current);
    // Responses that land after the selection changed (or the view unmounted)
    // are dropped — otherwise a slow reply for the old thread overwrites the new one.
    let cancelled = false;
    const kind = selected.startsWith('d:') ? 'dm' : 'worker';
    const otherId = selected.slice(2);
    const done = () => { if (!cancelled) setLoading(false); };
    const fetch = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) { setLoading(false); return Promise.resolve(); }
      if (kind === 'worker') {
        // The newest-page fetch marks the thread read for this admin server-side.
        return api.get('/chat', { params: { worker_id: otherId } }).then(r => {
          if (cancelled) return;
          const page = r.data || [];
          setMessages(prev => mergeNewest(prev, page));
          if (!olderLoadedRef.current) setHasOlder(page.length >= CHAT_PAGE);
          const last = page[page.length - 1];
          if (last) syncLegacyAdminReadKey({ worker_id: otherId, unread: 0, last_at: last.created_at });
          setUnreadByWorker(prev => { const n = { ...prev }; delete n[otherId]; return n; });
        }).catch(silentError('companychat')).finally(done);
      }
      return api.get(`/dm/${otherId}`).then(r => {
        if (cancelled) return;
        setMessages(prev => mergeNewest(prev, r.data?.messages || []));
        if (!olderLoadedRef.current) setHasOlder(!!r.data?.has_more);
        loadContacts();
      }).catch(silentError('companychat')).finally(done);
    };
    fetch();
    pollRef.current = setInterval(fetch, 30000);
    document.addEventListener('visibilitychange', fetch);
    window.addEventListener('online', fetch);
    return () => { cancelled = true; clearInterval(pollRef.current); document.removeEventListener('visibilitychange', fetch); window.removeEventListener('online', fetch); };
  }, [selected]);

  useEffect(() => { scrollThread(bottomRef, keepScrollRef); }, [messages]);

  const loadOlder = async (container) => {
    const target = selectedRef.current;
    const oldest = messages[0]?.id;
    if (!target || !oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const otherId = target.slice(2);
      let older; let more;
      if (target.startsWith('d:')) {
        const r = await api.get(`/dm/${otherId}`, { params: { before: oldest } });
        older = r.data?.messages || []; more = !!r.data?.has_more;
      } else {
        const r = await api.get('/chat', { params: { worker_id: otherId, before: oldest } });
        older = r.data || []; more = older.length >= CHAT_PAGE;
      }
      if (selectedRef.current !== target) return;
      olderLoadedRef.current = true;
      keepScrollRef.current = container ? container.scrollHeight - container.scrollTop : null;
      setMessages(prev => prependOlder(prev, older));
      setHasOlder(more);
    } catch (err) {
      silentError('companychat')(err);
    } finally { setLoadingOlder(false); }
  };

  const send = async e => {
    e.preventDefault();
    if (!body.trim() || !selected) return;
    setSending(true);
    setSendError('');
    const target = selected;
    try {
      const kind = target.startsWith('d:') ? 'dm' : 'worker';
      const otherId = target.slice(2);
      const r = kind === 'worker'
        ? await api.post('/chat', { body, worker_id: otherId })
        : await api.post(`/dm/${otherId}`, { body });
      // Only append if the user is still on the thread the message went to.
      if (selectedRef.current === target) setMessages(prev => [...prev, r.data]);
      setBody('');
    } catch (err) {
      setSendError(chatSendErrorText(err, t));
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
        <select style={styles.pickerSelect} value={selected} onChange={e => { setSelected(e.target.value); setBody(''); setSendError(''); }}>
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
          <Thread messages={messages} loading={loading} currentUserId={user?.id} bottomRef={bottomRef} t={t} locale={locale}
            hasOlder={hasOlder} loadingOlder={loadingOlder} onLoadOlder={loadOlder} />
          <ChatForm body={body} setBody={setBody} sending={sending} onSubmit={send} t={t} error={sendError} />
        </>
      ) : (
        <p style={styles.hint}>{t.chatSelectHint}</p>
      )}
    </div>
  );
}

function Thread({ messages, loading, currentUserId, bottomRef, t, locale, hasOlder, loadingOlder, onLoadOlder }) {
  return (
    <div style={styles.thread}>
      {!loading && hasOlder && messages.length > 0 && (
        <button
          type="button"
          style={styles.olderBtn}
          disabled={loadingOlder}
          onClick={e => onLoadOlder?.(e.currentTarget.parentElement)}
        >
          {loadingOlder ? t.loading : t.chatLoadOlder}
        </button>
      )}
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

function ChatForm({ body, setBody, sending, onSubmit, t, error }) {
  return (
    <>
    {error && <div role="alert" style={styles.sendError}>{error}</div>}
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
    </>
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
  olderBtn: { alignSelf: 'center', background: '#fff', border: '1px solid #d1d5db', borderRadius: 16, padding: '6px 14px', minHeight: 32, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' },
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
  sendError: { padding: '8px 12px', background: '#fef2f2', color: '#b91c1c', fontSize: 13, borderTop: '1px solid #fecaca' },
  input: { flex: 1, padding: '10px 14px', border: 'none', fontSize: 13, outline: 'none', background: '#fff' },
  sendBtn: { padding: '10px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 },
};
