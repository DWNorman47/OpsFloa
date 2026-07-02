// Public lien-waiver signing page. Token-keyed, no auth.
// Counterparty (sub or owner) sees the waiver and signs by typing
// their name. Lives at /lien-waiver-sign/:token.
//
// Once signed via this page, the server transitions status to 'signed'
// and — for from_sub direction — flips the matching sub PO payment's
// waiver_received flag, which causes the closeout module's "Lien
// waivers from all subs" auto-status to flip to done in real time.

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';
import { publicLinkError } from '../utils/publicErrors';

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const publicApi = axios.create({ baseURL });

// Subcontractors carry no stored language, so this page renders in the signer's
// browser language.
const TYPE_KEY = {
  conditional_progress:   'lwTypeCondProgress',
  unconditional_progress: 'lwTypeUncondProgress',
  conditional_final:      'lwTypeCondFinal',
  unconditional_final:    'lwTypeUncondFinal',
};

function formatCents(cents) {
  const n = (parseInt(cents, 10) || 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default function PublicLienWaiverSignPage() {
  const { token } = useParams();
  const [waiver, setWaiver] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const t = getT(detectLanguage());

  const [typedName, setTypedName] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [signed, setSigned] = useState(false);

  useEffect(() => {
    publicApi.get(`/public/lien-waivers/sign/${token}`)
      .then(r => setWaiver(r.data))
      .catch(err => setError(publicLinkError(err, t.lwErrNotFound)))
      .finally(() => setLoading(false));
  }, [token]);

  async function sign() {
    setError(null); setSubmitting(true);
    try {
      await publicApi.post(`/public/lien-waivers/sign/${token}`, {
        typed_name: typedName.trim(),
        signature_method: 'typed',
        signature_data: typedName.trim(),
      });
      setSigned(true);
    } catch (err) {
      setError(publicLinkError(err, t.lwErrSign));
    } finally { setSubmitting(false); }
  }

  if (loading) return <CenterMsg msg={t.loading} />;
  if (error && !waiver) return <CenterMsg title={t.pubNotFoundTitle} msg={error} tone="error" />;
  if (signed) return <CenterMsg title={t.lwSignedTitle} msg={`${t.pubThankYou} ${typedName}. ${t.lwRecorded}`} tone="success" />;
  if (!waiver) return null;

  const canSign = waiver.status === 'sent';
  const isConditional = waiver.waiver_type?.startsWith('conditional_');

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', padding: '40px 16px' }}>
      <div style={styles.card}>
        <div style={{ borderBottom: '2px solid var(--ops-page-accent)', paddingBottom: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ops-page-accent)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {t.lwLienWaiver}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginTop: 4 }}>
            {t[TYPE_KEY[waiver.waiver_type]] || waiver.waiver_type}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
            {t.pubProject}: <strong>{waiver.project_name}</strong>
            {waiver.state && <> · {t.lwState}: <strong>{waiver.state}</strong></>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
          <Block label={t.lwAmount}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{formatCents(waiver.amount_cents)}</div>
          </Block>
          <Block label={t.lwThroughDate}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {new Date(waiver.through_date).toLocaleDateString()}
            </div>
          </Block>
          <Block label={t.lwSignerOfRecord}>
            <div>{waiver.signer_name}</div>
            {waiver.signer_title && <div style={{ fontSize: 13, color: '#6b7280' }}>{waiver.signer_title}</div>}
          </Block>
          <Block label={t.lwSignerCompany}>
            <div>{waiver.signer_company}</div>
          </Block>
        </div>

        <div style={{ background: '#f9fafb', padding: 20, borderRadius: 8, fontSize: 13, color: '#374151', lineHeight: 1.6, marginBottom: 20 }}>
          {isConditional ? (
            <>
              <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t.lwCondHeading}</p>
              <p style={{ margin: 0 }}>
                {t.lwCondPre} {formatCents(waiver.amount_cents)}{' '}
                {t.lwCondMid} {new Date(waiver.through_date).toLocaleDateString()}{t.lwCondPost}
              </p>
            </>
          ) : (
            <>
              <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t.lwUncondHeading}</p>
              <p style={{ margin: 0 }}>
                {t.lwUncondPre} {formatCents(waiver.amount_cents)}{' '}
                {t.lwUncondMid} {new Date(waiver.through_date).toLocaleDateString()}{t.lwUncondPost}
              </p>
            </>
          )}
          <p style={{ fontSize: 11, color: '#6b7280', margin: '12px 0 0', fontStyle: 'italic' }}>
            {t.lwDisclaimer}
          </p>
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}

        {canSign ? (
          <div style={{ marginTop: 8, padding: 24, background: '#f0f4ff', borderRadius: 8 }}>
            <h3 style={{ ...styles.h3, marginTop: 0 }}>{t.lwSignThis}</h3>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                {t.lwTypeLegalName}
              </div>
              <input
                value={typedName}
                onChange={e => setTypedName(e.target.value)}
                placeholder={t.pubNamePlaceholder}
                style={{ ...styles.input, fontFamily: 'Caveat, cursive', fontSize: 22 }}
              />
            </label>
            <label style={{ display: 'flex', gap: 8, fontSize: 13, color: '#374151', marginBottom: 16 }}>
              <input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} />
              {t.lwAcknowledge}
            </label>
            <button
              onClick={sign}
              disabled={submitting || !typedName.trim() || !acknowledge}
              style={styles.primaryBtn}
            >
              {submitting ? t.lwSigning : t.lwSignBtn}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 16, padding: 16, background: '#f3f4f6', borderRadius: 8, fontSize: 14, color: '#6b7280' }}>
            {t.lwNoLonger} ({t.pubStatus}: <strong>{waiver.status}</strong>).
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
function CenterMsg({ title, msg, tone = 'neutral' }) {
  const fg = tone === 'success' ? '#065f46' : tone === 'error' ? '#991b1b' : '#374151';
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f9fafb' }}>
      <div style={{ maxWidth: 480, width: '100%', background: '#fff', padding: 40, borderRadius: 12, textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.06)' }}>
        {title && <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px', color: fg }}>{title}</h2>}
        <p style={{ fontSize: 15, color: '#6b7280', margin: 0 }}>{msg}</p>
      </div>
    </div>
  );
}

const styles = {
  card: { maxWidth: 760, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 40, boxShadow: '0 4px 20px rgba(0,0,0,0.06)' },
  h3: { fontSize: 13, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' },
  primaryBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  input: { padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginTop: 16, fontSize: 14 },
};
