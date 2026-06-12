// Public change-order view + accept/decline. Mirrors PublicEstimatePage.
// Lives at /co/:token.

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const publicApi = axios.create({ baseURL });

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];

function formatCents(cents) {
  const n = (parseInt(cents, 10) || 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default function PublicChangeOrderPage() {
  const { token } = useParams();
  const [co, setCo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [typedName, setTypedName] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [showDecline, setShowDecline] = useState(false);

  useEffect(() => {
    publicApi.get(`/public/change-orders/view/${token}`)
      .then(r => setCo(r.data))
      .catch(err => setError(err.response?.data?.error || 'Change order not found'))
      .finally(() => setLoading(false));
  }, [token]);

  async function accept() {
    setError(null); setSubmitting(true);
    try {
      await publicApi.post(`/public/change-orders/accept/${token}`, {
        typed_name: typedName.trim(),
        authorized: true,
      });
      setAccepted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Accept failed');
    } finally { setSubmitting(false); }
  }
  async function decline() {
    setError(null); setSubmitting(true);
    try {
      await publicApi.post(`/public/change-orders/decline/${token}`);
      setDeclined(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Decline failed');
    } finally { setSubmitting(false); }
  }

  if (loading) return <CenterMsg msg="Loading..." />;
  if (error && !co) return <CenterMsg title="Not found" msg={error} tone="error" />;
  if (accepted) return <CenterMsg title="Accepted" msg={`Thank you, ${typedName}. The contractor has been notified.`} tone="success" />;
  if (declined) return <CenterMsg title="Declined" msg="The contractor has been notified." tone="neutral" />;
  if (!co) return null;

  const canAct = co.status === 'sent';
  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of co.lines || []) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', padding: '40px 16px' }}>
      <div style={styles.card}>
        <div style={{ borderBottom: '2px solid var(--ops-page-accent)', paddingBottom: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ops-page-accent)', letterSpacing: 1, textTransform: 'uppercase' }}>Change Order</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
            {co.co_number} · {new Date(co.sent_at).toLocaleDateString()}
          </div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <Block label="Description">
            <div style={{ fontSize: 16, fontWeight: 600 }}>{co.description}</div>
          </Block>
        </div>

        <div style={{ marginBottom: 24 }}>
          <h3 style={styles.h3}>Line items</h3>
          {CATEGORIES.filter(c => linesByCat[c].length > 0).map(category => (
            <div key={category} style={{ marginBottom: 14 }}>
              <div style={styles.catLabel}>{category}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <tbody>
                  {linesByCat[category].map((l, i) => (
                    <tr key={i}>
                      <td style={{ padding: '5px 0' }}>{l.description}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#6b7280', width: 90 }}>{l.qty} {l.unit || ''}</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', width: 100 }}>{formatCents(l.total_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div style={styles.totalsBox}>
          <Row label="Subtotal" value={co.subtotal_cents} />
          {parseFloat(co.overhead_pct) > 0 && (
            <Row label={`Overhead (${co.overhead_pct}%)`} value={Math.round(co.subtotal_cents * co.overhead_pct / 100)} />
          )}
          <Row label="Total" value={co.total_cents} bold />
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}

        {canAct ? (
          <div style={{ marginTop: 32, padding: 24, background: '#f0f4ff', borderRadius: 8 }}>
            {showDecline ? (
              <>
                <h3 style={{ ...styles.h3, marginTop: 0 }}>Decline this change order</h3>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowDecline(false)} style={styles.ghostBtn}>Back</button>
                  <button onClick={decline} disabled={submitting} style={{ ...styles.primaryBtn, background: '#dc2626' }}>
                    {submitting ? 'Submitting...' : 'Confirm decline'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ ...styles.h3, marginTop: 0 }}>Accept this change order</h3>
                <label style={{ display: 'block', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Type your full name to accept</div>
                  <input value={typedName} onChange={e => setTypedName(e.target.value)} placeholder="e.g. Jane Smith" style={styles.input} />
                </label>
                <label style={{ display: 'flex', gap: 8, fontSize: 13, color: '#374151', marginBottom: 16 }}>
                  <input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)} />
                  I am authorized to accept this change order on behalf of the client.
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowDecline(true)} style={styles.ghostBtn}>Decline</button>
                  <button onClick={accept} disabled={submitting || !typedName.trim() || !authorized} style={styles.primaryBtn}>
                    {submitting ? 'Accepting...' : 'Accept change order'}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 32, padding: 16, background: '#f3f4f6', borderRadius: 8, fontSize: 14, color: '#6b7280' }}>
            This change order is no longer available for response (status: <strong>{co.status}</strong>).
          </div>
        )}
      </div>
    </div>
  );
}

function Block({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
function Row({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: bold ? '2px solid #111827' : '1px solid #e5e7eb', fontWeight: bold ? 700 : 400, fontSize: bold ? 18 : 14 }}>
      <span>{label}</span>
      <span>{formatCents(value)}</span>
    </div>
  );
}
function CenterMsg({ title, msg, tone = 'neutral' }) {
  const colors = {
    success: { fg: '#065f46' },
    error:   { fg: '#991b1b' },
    neutral: { fg: '#374151' },
  }[tone];
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f9fafb' }}>
      <div style={{ maxWidth: 480, width: '100%', background: '#fff', padding: 40, borderRadius: 12, textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.06)' }}>
        {title && <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px', color: colors.fg }}>{title}</h2>}
        <p style={{ fontSize: 15, color: '#6b7280', margin: 0 }}>{msg}</p>
      </div>
    </div>
  );
}

const styles = {
  card: { maxWidth: 800, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 40, boxShadow: '0 4px 20px rgba(0,0,0,0.06)' },
  h3: { fontSize: 13, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' },
  catLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid #e5e7eb' },
  totalsBox: { background: '#f9fafb', padding: '16px 20px', borderRadius: 8 },
  primaryBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '10px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  input: { padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginTop: 16, fontSize: 14 },
};
