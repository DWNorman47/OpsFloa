import React, { useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';

export default function BroadcastMessage() {
  const t = useT();
  const [message, setMessage] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | sent | error

  const handleSend = async () => {
    if (!message.trim()) return;
    setState('sending');
    try {
      await api.post('/admin/broadcast', { message });
      setState('sent');
      setMessage('');
      setTimeout(() => setState('idle'), 3000);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.heading}>{t.announceTitle}</h3>
      <p style={styles.sub}>{t.announceDesc}</p>
      <div style={styles.row} className="broadcast-message-row">
        <input
          style={styles.input}
          className="broadcast-message-input"
          type="text"
          placeholder={t.broadcastPlaceholder}
          value={message}
          maxLength={200}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          disabled={state === 'sending' || state === 'sent'}
        />
        <button
          style={{ ...(state === 'sent' ? styles.btnSent : styles.btn), ...((!message.trim() || state === 'sending') ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
          className="broadcast-message-button"
          onClick={handleSend}
          disabled={!message.trim() || state === 'sending' || state === 'sent'}
        >
          {state === 'sending' ? t.sending : state === 'sent' ? t.sent : t.send}
        </button>
      </div>
      {state === 'error' && <p role="alert" style={styles.error}>{t.failedSend}</p>}
      <div style={styles.charCount}>{message.length}/200</div>
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: '18px 20px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)', marginBottom: 16 },
  heading: { fontSize: 15, fontWeight: 700, margin: '0 0 4px 0', color: '#111827' },
  sub: { fontSize: 12, color: '#6b7280', margin: '0 0 12px 0' },
  row: { display: 'flex', gap: 8, minWidth: 0 },
  input: { flex: 1, minWidth: 0, padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 },
  btn: { padding: '9px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap' },
  btnSent: { padding: '9px 18px', background: '#059669', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'default', whiteSpace: 'nowrap' },
  error: { color: '#dc2626', fontSize: 12, margin: '6px 0 0 0' },
  charCount: { fontSize: 11, color: '#6b7280', marginTop: 4, textAlign: 'right' },
};
