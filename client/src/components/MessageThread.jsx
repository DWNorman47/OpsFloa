import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';

import { silentError } from '../errorReporter';
export default function MessageThread({ entryId, currentUserId, onUnreadChange }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    api.get(`/time-entries/${entryId}/messages`)
      .then(r => { setMessages(r.data); if (onUnreadChange) onUnreadChange(); })
      .catch(silentError('messagethread'))
      .finally(() => setLoading(false));
  }, [entryId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async e => {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    try {
      const r = await api.post(`/time-entries/${entryId}/messages`, { body });
      setMessages(prev => [...prev, r.data]);
      setBody('');
    } finally { setSending(false); }
  };

  const formatTime = str => new Date(str).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div style={styles.wrap}>
      {loading ? (
        <p style={styles.loading}>{t.loading}</p>
      ) : messages.length === 0 ? (
        <p style={styles.empty}>{t.chatNoMsgYet}</p>
      ) : (
        <div style={styles.thread}>
          {messages.map(m => {
            const isMine = m.sender_id === currentUserId;
            return (
              <div key={m.id} style={{ ...styles.bubble, ...(isMine ? styles.bubbleMine : styles.bubbleTheirs) }}>
                <div style={styles.bubbleMeta}>
                  <span style={styles.sender}>{isMine ? t.chatYou : m.sender_name}</span>
                  <span style={styles.time}>{formatTime(m.created_at)}</span>
                </div>
                <div style={styles.bubbleBody}>{m.body}</div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
      <form onSubmit={send} style={styles.form}>
        <input
          style={styles.input}
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder={t.chatWriteMsg}
          disabled={sending}
        />
        <button style={{ ...styles.sendBtn, ...((sending || !body.trim()) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={sending || !body.trim()}>
          {sending ? t.sending : t.chatSend}
        </button>
      </form>
    </div>
  );
}

const styles = {
  wrap: { marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
  loading: { padding: '10px 12px', color: '#6b7280', fontSize: 13, margin: 0 },
  empty: { padding: '10px 12px', color: '#6b7280', fontSize: 12, fontStyle: 'italic', margin: 0 },
  thread: { maxHeight: 200, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, background: '#fafafa' },
  bubble: { maxWidth: '80%', padding: '7px 10px', borderRadius: 8, fontSize: 13 },
  bubbleMine: { alignSelf: 'flex-end', background: '#dbeafe', color: '#1e3a5f' },
  bubbleTheirs: { alignSelf: 'flex-start', background: '#fff', border: '1px solid #e5e7eb', color: '#374151' },
  bubbleMeta: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 },
  sender: { fontSize: 11, fontWeight: 700, color: '#6b7280' },
  time: { fontSize: 10, color: '#6b7280' },
  bubbleBody: { lineHeight: 1.5 },
  form: { display: 'flex', borderTop: '1px solid #e5e7eb' },
  input: { flex: 1, padding: '8px 12px', border: 'none', fontSize: 13, outline: 'none', background: '#fff' },
  sendBtn: { padding: '8px 14px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
};
