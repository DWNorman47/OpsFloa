import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

/**
 * Super-admin Mail page (/mail): a mail client over the opsfloa.com
 * addresses that forward into the shared Gmail account. Each address is
 * an isolated view (its own inbox, folders, sent copies, compose-as);
 * the backend filters by delivered-to so Gmail's own mail never shows.
 * English-only like SuperAdmin.jsx — this page has exactly one user.
 */

function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
    + ' ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

const S = {
  page: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 20px)', padding: 10, boxSizing: 'border-box', background: '#f8fafc' },
  topBar: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
  body: { display: 'flex', gap: 10, flex: 1, minHeight: 0 },
  side: { width: 190, flexShrink: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, overflowY: 'auto' },
  main: { flex: 1, minWidth: 0, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  select: { padding: '7px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, background: '#fff' },
  input: { padding: '7px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 },
  folderBtn: active => ({
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', textAlign: 'left',
    padding: '7px 9px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, marginBottom: 2,
    background: active ? '#e0e7ff' : 'transparent', color: active ? '#3730a3' : '#334155', fontWeight: active ? 700 : 500,
  }),
  row: unseen => ({
    display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 12px', borderBottom: '1px solid #f1f5f9',
    cursor: 'pointer', fontWeight: unseen ? 700 : 400, background: unseen ? '#fff' : '#fbfcfd',
  }),
  notice: { padding: '10px 12px', borderRadius: 8, background: '#f1f5f9', color: '#475569', fontSize: 14, margin: 12 },
  errNotice: { padding: '10px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 14, margin: 12 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 },
  modal: { background: '#fff', borderRadius: 12, padding: 16, width: 'min(640px, 92vw)', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '90vh' },
};

export default function MailPage() {
  const [config, setConfig] = useState(null);          // { configured, accounts, defaultAccount }
  const [account, setAccount] = useState(null);
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState(null);          // null = Inbox
  const [list, setList] = useState({ items: [], total: 0, page: 1, pages: 1 });
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [dir, setDir] = useState('desc');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(null);        // opened message detail
  const [msgLoading, setMsgLoading] = useState(false);
  const [compose, setCompose] = useState(null);        // { to, cc, subject, text, inReplyTo, references }
  const [sending, setSending] = useState(false);
  const [newFolder, setNewFolder] = useState('');

  useEffect(() => {
    api.get('/mailbox/config', { suppressToast: true })
      .then(({ data }) => { setConfig(data); setAccount(data.defaultAccount); })
      .catch(() => setError('Could not load mailbox configuration.'));
  }, []);

  const loadList = useCallback(async (page = 1) => {
    if (!account) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/mailbox/messages', {
        params: { account, folder: folder || undefined, q: q || undefined, page, dir },
        suppressToast: true,
      });
      setList(data);
      setFolders(data.folders || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load messages.');
    } finally {
      setLoading(false);
    }
  }, [account, folder, q, dir]);

  useEffect(() => { setMessage(null); loadList(1); }, [loadList]);

  const openMessage = async item => {
    setMsgLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/mailbox/messages/${item.uid}`, { params: { account }, suppressToast: true });
      setMessage(data);
      if (!item.seen) {
        api.post(`/mailbox/messages/${item.uid}/read`, { account, seen: true }, { suppressToast: true }).catch(() => {});
        setList(prev => ({ ...prev, items: prev.items.map(m => (m.uid === item.uid ? { ...m, seen: true } : m)) }));
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open the message.');
    } finally {
      setMsgLoading(false);
    }
  };

  const markUnread = async () => {
    if (!message) return;
    await api.post(`/mailbox/messages/${message.uid}/read`, { account, seen: false }, { suppressToast: true }).catch(() => {});
    setList(prev => ({ ...prev, items: prev.items.map(m => (m.uid === message.uid ? { ...m, seen: false } : m)) }));
    setMessage(null);
  };

  const moveTo = async target => {
    if (!message) return;
    try {
      await api.post(`/mailbox/messages/${message.uid}/move`, { account, folder: target || null }, { suppressToast: true });
      setMessage(null);
      loadList(list.page);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not move the message.');
    }
  };

  const addFolder = async () => {
    const name = newFolder.trim();
    if (!name) return;
    try {
      const { data } = await api.post('/mailbox/folders', { account, name }, { suppressToast: true });
      setFolders(data.folders);
      setNewFolder('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create the folder.');
    }
  };

  const removeFolder = async name => {
    if (!window.confirm(`Delete folder "${name}"? Its messages go back to the inbox.`)) return;
    try {
      const { data } = await api.delete('/mailbox/folders', { params: { account, name }, suppressToast: true });
      setFolders(data.folders);
      if (folder === name) setFolder(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not delete the folder.');
    }
  };

  const downloadAttachment = async att => {
    try {
      const { data } = await api.get(`/mailbox/messages/${message.uid}/attachments/${att.index}`, {
        params: { account }, responseType: 'blob', suppressToast: true,
      });
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not download the attachment.');
    }
  };

  const startReply = () => {
    if (!message) return;
    const fromAddr = (message.from.match(/<([^>]+)>/) || [null, message.from])[1];
    setCompose({
      to: fromAddr || '',
      cc: '',
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      text: `\n\nOn ${fmtDate(message.date)}, ${message.from} wrote:\n> ${String(message.text || '').split('\n').join('\n> ')}`,
      inReplyTo: message.messageId || '',
      references: [message.references, message.messageId].flat().filter(Boolean).join(' '),
    });
  };

  const send = async () => {
    setSending(true);
    setError('');
    try {
      await api.post('/mailbox/send', { account, ...compose }, { suppressToast: true });
      setCompose(null);
      if (folder === 'Sent') loadList(1);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the email.');
    } finally {
      setSending(false);
    }
  };

  // Production-only page (matches the server's 403 gate): the real mailbox
  // credentials exist only on prod, and dev shouldn't read or send as the
  // real opsfloa addresses.
  const prodHost = typeof window !== 'undefined'
    && (window.location.hostname === 'opsfloa.com' || window.location.hostname === 'www.opsfloa.com');
  if (!prodHost) {
    return (
      <div style={{ maxWidth: 640, margin: '60px auto', padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>Mail</h2>
        <div style={S.notice}>The Mail page is only available on production (opsfloa.com).</div>
        <Link to="/superadmin">&larr; Back to Super Admin</Link>
      </div>
    );
  }

  if (!config) return <div className="ops-loading-state" style={{ margin: 40 }}>Loading mailbox…</div>;

  if (!config.configured) {
    return (
      <div style={{ maxWidth: 640, margin: '60px auto', padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>Mail</h2>
        <div style={S.notice}>
          The mailbox is not configured. Set <code>MAILBOX_GMAIL_USER</code>, <code>MAILBOX_GMAIL_APP_PASSWORD</code> and{' '}
          <code>MAILBOX_ACCOUNTS</code> on the server, then reload.
        </div>
        <Link to="/superadmin">&larr; Back to Super Admin</Link>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <div style={S.topBar}>
        <Link to="/superadmin" style={{ color: '#64748b', textDecoration: 'none', fontSize: 14 }}>&larr; Super Admin</Link>
        <h2 style={{ margin: 0, fontSize: 20 }}>Mail</h2>
        <select style={S.select} value={account || ''} onChange={e => { setAccount(e.target.value); setFolder(null); }} aria-label="Email account">
          {config.accounts.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <button className="ops-button-primary" onClick={() => setCompose({ to: '', cc: '', subject: '', text: '', inReplyTo: '', references: '' })}>
          Compose
        </button>
        <div style={{ flex: 1 }} />
        <form onSubmit={e => { e.preventDefault(); setQ(qInput); }} style={{ display: 'flex', gap: 6 }}>
          <input style={S.input} value={qInput} onChange={e => setQInput(e.target.value)} placeholder="Search (Gmail syntax ok)" aria-label="Search mail" />
          <button className="ops-button-secondary" type="submit">Search</button>
          {q && <button className="ops-button-secondary" type="button" onClick={() => { setQ(''); setQInput(''); }}>Clear</button>}
        </form>
        <button className="ops-button-secondary" onClick={() => setDir(d => (d === 'desc' ? 'asc' : 'desc'))} title="Sort by date">
          {dir === 'desc' ? 'Newest first' : 'Oldest first'}
        </button>
      </div>

      <div style={S.body}>
        <div style={S.side}>
          <button style={S.folderBtn(!folder)} onClick={() => setFolder(null)}>Inbox</button>
          {folders.map(f => (
            <button key={f} style={S.folderBtn(folder === f)} onClick={() => setFolder(f)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</span>
              {f !== 'Sent' && (
                <span
                  role="button"
                  aria-label={`Delete folder ${f}`}
                  onClick={e => { e.stopPropagation(); removeFolder(f); }}
                  style={{ color: '#94a3b8', padding: '0 3px' }}
                >×</span>
              )}
            </button>
          ))}
          <form onSubmit={e => { e.preventDefault(); addFolder(); }} style={{ marginTop: 10, display: 'flex', gap: 4 }}>
            <input
              style={{ ...S.input, width: '100%', fontSize: 13, padding: '5px 8px' }}
              value={newFolder}
              onChange={e => setNewFolder(e.target.value)}
              placeholder="New folder…"
              aria-label="New folder name"
            />
            <button className="ops-button-secondary" type="submit" style={{ padding: '4px 8px' }}>+</button>
          </form>
        </div>

        <div style={S.main}>
          {error && <div style={S.errNotice}>{error}</div>}

          {message || msgLoading ? (
            <div style={{ overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
              {msgLoading && <div className="ops-loading-state">Opening…</div>}
              {message && (
                <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    <button className="ops-button-secondary" onClick={() => setMessage(null)}>&larr; Back</button>
                    <button className="ops-button-primary" onClick={startReply}>Reply</button>
                    <button className="ops-button-secondary" onClick={markUnread}>Mark unread</button>
                    <select
                      style={S.select}
                      value={message.labels?.[0] || ''}
                      onChange={e => moveTo(e.target.value)}
                      aria-label="Move to folder"
                    >
                      <option value="">Inbox (no folder)</option>
                      {folders.filter(f => f !== 'Sent').map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <h3 style={{ margin: '0 0 6px' }}>{message.subject}</h3>
                  <div style={{ color: '#64748b', fontSize: 13, marginBottom: 2 }}>From: {message.from}</div>
                  <div style={{ color: '#64748b', fontSize: 13, marginBottom: 2 }}>To: {message.to}</div>
                  {message.cc && <div style={{ color: '#64748b', fontSize: 13, marginBottom: 2 }}>Cc: {message.cc}</div>}
                  <div style={{ color: '#64748b', fontSize: 13, marginBottom: 10 }}>{fmtDate(message.date)}</div>
                  {message.attachments.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {message.attachments.map(att => (
                        <button key={att.index} className="ops-button-secondary" onClick={() => downloadAttachment(att)}>
                          📎 {att.filename} {att.size ? `(${fmtSize(att.size)})` : ''}
                        </button>
                      ))}
                    </div>
                  )}
                  {message.html ? (
                    <iframe
                      title="Email content"
                      sandbox=""
                      srcDoc={message.html}
                      style={{ border: '1px solid #e2e8f0', borderRadius: 8, width: '100%', flex: 1, minHeight: 380, background: '#fff' }}
                    />
                  ) : (
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, margin: 0 }}>{message.text}</pre>
                  )}
                </>
              )}
            </div>
          ) : (
            <>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {loading && <div className="ops-loading-state" style={{ margin: 12 }}>Loading…</div>}
                {!loading && list.items.length === 0 && (
                  <div style={S.notice}>{q ? 'No messages match this search.' : folder ? 'This folder is empty.' : 'Inbox zero 🎉'}</div>
                )}
                {!loading && list.items.map(item => (
                  <div key={item.uid} style={S.row(!item.seen)} onClick={() => openMessage(item)}>
                    <span style={{ width: 190, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.from?.name || item.from?.address || '—'}
                    </span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.subject}</span>
                    <span style={{ color: '#94a3b8', fontSize: 12, flexShrink: 0 }}>{fmtSize(item.size)}</span>
                    <span style={{ color: '#64748b', fontSize: 12, flexShrink: 0, width: 110, textAlign: 'right' }}>{fmtDate(item.date)}</span>
                  </div>
                ))}
              </div>
              {list.pages > 1 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: 8, borderTop: '1px solid #f1f5f9' }}>
                  <button className="ops-button-secondary" disabled={list.page <= 1} onClick={() => loadList(list.page - 1)}>&larr; Prev</button>
                  <span style={{ fontSize: 13, color: '#64748b' }}>Page {list.page} of {list.pages} · {list.total} messages</span>
                  <button className="ops-button-secondary" disabled={list.page >= list.pages} onClick={() => loadList(list.page + 1)}>Next &rarr;</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {compose && (
        <div style={S.overlay} onClick={() => !sending && setCompose(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>New message <span style={{ color: '#64748b', fontWeight: 400, fontSize: 14 }}>from {account}</span></h3>
            <input style={S.input} placeholder="To (comma-separated)" value={compose.to} onChange={e => setCompose(c => ({ ...c, to: e.target.value }))} aria-label="To" />
            <input style={S.input} placeholder="Cc" value={compose.cc} onChange={e => setCompose(c => ({ ...c, cc: e.target.value }))} aria-label="Cc" />
            <input style={S.input} placeholder="Subject" value={compose.subject} onChange={e => setCompose(c => ({ ...c, subject: e.target.value }))} aria-label="Subject" />
            <textarea
              style={{ ...S.input, minHeight: 220, resize: 'vertical', fontFamily: 'inherit' }}
              value={compose.text}
              onChange={e => setCompose(c => ({ ...c, text: e.target.value }))}
              aria-label="Message body"
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="ops-button-secondary" disabled={sending} onClick={() => setCompose(null)}>Cancel</button>
              <button className="ops-button-primary" disabled={sending || !compose.to.trim()} onClick={send}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
