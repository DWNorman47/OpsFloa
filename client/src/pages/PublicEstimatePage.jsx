// Public estimate view + accept/decline page. No auth — token-keyed.
// Sits at /e/:token. Mirrors the shape returned by GET /api/public/estimates/view/:token.

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';
import { publicLinkError } from '../utils/publicErrors';
import { formatCurrency } from '../utils';

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const publicApi = axios.create({ baseURL });

// This page is unauthenticated, so it can't read GET /api/settings — the
// contractor's currency rides along in the public payload instead. Falls back
// to USD only if the server omitted it.
function formatCents(cents, currency = 'USD') {
  return formatCurrency((parseInt(cents, 10) || 0) / 100, currency);
}

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];
const PCAT_KEY = {
  labor: 'pcatLabor', materials: 'pcatMaterials', equipment: 'pcatEquipment', subs: 'pcatSubs',
  overhead: 'pcatOverhead', contingency: 'pcatContingency', other: 'pcatOther',
};

export default function PublicEstimatePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // No logged-in user here — render in the client's stored language when known,
  // otherwise the visitor's browser language.
  const t = getT(detectLanguage(estimate?.client_language));

  // Accept flow state
  const [typedName, setTypedName] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  // Decline flow
  const [declineReason, setDeclineReason] = useState('');
  const [declined, setDeclined] = useState(false);
  const [showDecline, setShowDecline] = useState(false);

  useEffect(() => {
    publicApi.get(`/public/estimates/view/${token}`)
      .then(r => setEstimate(r.data))
      .catch(err => setError(publicLinkError(err, t.peErrNotFound)))
      .finally(() => setLoading(false));
  }, [token]);

  async function accept() {
    setError(null);
    setSubmitting(true);
    try {
      await publicApi.post(`/public/estimates/accept/${token}`, {
        typed_name: typedName.trim(),
        authorized: true,
      });
      setAccepted(true);
    } catch (err) {
      setError(publicLinkError(err, t.peErrAccept));
    } finally {
      setSubmitting(false);
    }
  }

  async function decline() {
    setError(null);
    setSubmitting(true);
    try {
      await publicApi.post(`/public/estimates/decline/${token}`, {
        reason: declineReason.trim() || null,
      });
      setDeclined(true);
    } catch (err) {
      setError(publicLinkError(err, t.peErrDecline));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <CenterMsg msg={t.loading} />;
  }

  if (error && !estimate) {
    return <CenterMsg title={t.pubNotFoundTitle} msg={error} tone="error" />;
  }

  if (accepted) {
    return <CenterMsg title={t.pubAcceptedTitle} msg={`${t.pubThankYou} ${typedName}. ${t.pubNotified}`} tone="success" />;
  }
  if (declined) {
    return <CenterMsg title={t.pubDeclinedTitle} msg={t.pubNotified} tone="neutral" />;
  }

  if (!estimate) return null;

  const canAct = estimate.status === 'sent';

  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of estimate.lines || []) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', padding: '40px 16px' }}>
      <div style={styles.card}>
        <div style={{ borderBottom: '2px solid var(--ops-page-accent)', paddingBottom: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ops-page-accent)', letterSpacing: 1, textTransform: 'uppercase' }}>{t.peEstimate}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
            {estimate.estimate_number} · {new Date(estimate.sent_at).toLocaleDateString()}
            {estimate.valid_until && <> · {t.peValidUntil} {new Date(estimate.valid_until).toLocaleDateString()}</>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
          <Block label={t.pubProject}>
            <div style={{ fontWeight: 600 }}>{estimate.project_name}</div>
          </Block>
          <Block label={t.pubPreparedFor}>
            <div style={{ fontWeight: 600 }}>{estimate.client_name_snapshot}</div>
          </Block>
        </div>

        {estimate.scope_summary && (
          <div style={{ marginBottom: 20 }}>
            <Block label={t.pubScope}>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{estimate.scope_summary}</div>
            </Block>
          </div>
        )}

        <div style={{ marginBottom: 24 }}>
          <h3 style={styles.h3}>{t.pubLineItems}</h3>
          {CATEGORIES.filter(c => linesByCat[c].length > 0).map(category => (
            <div key={category} style={{ marginBottom: 14 }}>
              <div style={styles.catLabel}>{t[PCAT_KEY[category]] || category}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <tbody>
                  {linesByCat[category].map((l, i) => (
                    <tr key={i}>
                      <td style={{ padding: '5px 0' }}>{l.description}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#6b7280', width: 90 }}>
                        {l.qty} {l.unit || ''}
                      </td>
                      <td style={{ padding: '5px 0', textAlign: 'right', width: 100 }}>
                        {formatCents(l.total_cents, estimate?.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div style={styles.totalsBox}>
          <Row label={t.pubSubtotal} value={estimate.subtotal_cents} currency={estimate.currency} />
          {parseFloat(estimate.overhead_pct) > 0 && (
            <Row label={`${t.pubOverhead} (${estimate.overhead_pct}%)`} value={Math.round(estimate.subtotal_cents * estimate.overhead_pct / 100)} currency={estimate.currency} />
          )}
          <Row label={t.pubTotal} value={estimate.total_cents} bold currency={estimate.currency} />
        </div>

        {estimate.exclusions && (
          <div style={{ marginTop: 24 }}>
            <Block label={t.pubExclusions}>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{estimate.exclusions}</div>
            </Block>
          </div>
        )}
        {estimate.terms && (
          <div style={{ marginTop: 16 }}>
            <Block label={t.pubTerms}>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{estimate.terms}</div>
            </Block>
          </div>
        )}

        {error && <div style={styles.errorBox}>{error}</div>}

        {/* Action panel */}
        {canAct ? (
          <div style={{ marginTop: 32, padding: 24, background: '#f0f4ff', borderRadius: 8 }}>
            {showDecline ? (
              <>
                <h3 style={{ ...styles.h3, marginTop: 0 }}>{t.peDeclineThis}</h3>
                <textarea
                  value={declineReason}
                  onChange={e => setDeclineReason(e.target.value)}
                  placeholder={t.pubReasonOptional}
                  style={{ ...styles.input, minHeight: 80, marginBottom: 12 }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowDecline(false)} style={styles.ghostBtn}>{t.back}</button>
                  <button onClick={decline} disabled={submitting} style={{ ...styles.primaryBtn, background: '#dc2626' }}>
                    {submitting ? t.pubSubmitting : t.pubConfirmDecline}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ ...styles.h3, marginTop: 0 }}>{t.peAcceptThis}</h3>
                <label style={{ display: 'block', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{t.pubTypeFullName}</div>
                  <input
                    value={typedName}
                    onChange={e => setTypedName(e.target.value)}
                    placeholder={t.pubNamePlaceholder}
                    style={styles.input}
                  />
                </label>
                <label style={{ display: 'flex', gap: 8, fontSize: 13, color: '#374151', marginBottom: 16 }}>
                  <input
                    type="checkbox"
                    checked={authorized}
                    onChange={e => setAuthorized(e.target.checked)}
                  />
                  {t.peAuthPre} {estimate.client_name_snapshot}.
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowDecline(true)} style={styles.ghostBtn}>{t.pubDecline}</button>
                  <button
                    onClick={accept}
                    disabled={submitting || !typedName.trim() || !authorized}
                    style={styles.primaryBtn}
                  >
                    {submitting ? t.peAccepting : t.peAcceptBtn}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 32, padding: 16, background: '#f3f4f6', borderRadius: 8, fontSize: 14, color: '#6b7280' }}>
            {t.peNoLonger} ({t.pubStatus}: <strong>{estimate.status}</strong>).
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

function Row({ label, value, bold, currency }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: bold ? '2px solid #111827' : '1px solid #e5e7eb', fontWeight: bold ? 700 : 400, fontSize: bold ? 18 : 14 }}>
      <span>{label}</span>
      <span>{formatCents(value, currency)}</span>
    </div>
  );
}

function CenterMsg({ title, msg, tone = 'neutral' }) {
  const colors = {
    success: { bg: '#d1fae5', fg: '#065f46' },
    error:   { bg: '#fee2e2', fg: '#991b1b' },
    neutral: { bg: '#f3f4f6', fg: '#374151' },
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
