// Public invoice view page. No auth — token-keyed. Sits at /i/:token.
// Mirrors GET /api/public/invoices/view/:token. View-only (online pay is
// deferred): the client sees the invoice, what's been paid, and the balance.

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';
import { publicLinkError } from '../utils/publicErrors';
import { formatCurrency } from '../utils';

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const publicApi = axios.create({ baseURL });

function formatCents(cents, currency = 'USD') {
  return formatCurrency((parseInt(cents, 10) || 0) / 100, currency);
}

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];
const PCAT_KEY = {
  labor: 'pcatLabor', materials: 'pcatMaterials', equipment: 'pcatEquipment', subs: 'pcatSubs',
  overhead: 'pcatOverhead', contingency: 'pcatContingency', other: 'pcatOther',
};

export default function PublicInvoicePage() {
  const { token } = useParams();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const t = getT(detectLanguage(invoice?.client_language));

  useEffect(() => {
    publicApi.get(`/public/invoices/view/${token}`)
      .then(r => setInvoice(r.data))
      .catch(err => setError(publicLinkError(err, t.peErrNotFound)))
      .finally(() => setLoading(false));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <CenterMsg msg={t.loading} />;
  if (error && !invoice) return <CenterMsg title={t.pubNotFoundTitle} msg={error} tone="error" />;
  if (!invoice) return null;

  const paid = parseInt(invoice.amount_paid_cents, 10) || 0;
  const total = parseInt(invoice.total_cents, 10) || 0;
  const balance = Math.max(0, total - paid);
  const currency = invoice.currency;

  const linesByCat = {};
  for (const c of CATEGORIES) linesByCat[c] = [];
  for (const l of invoice.lines || []) {
    if (linesByCat[l.category]) linesByCat[l.category].push(l);
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', padding: '40px 16px' }}>
      <div style={styles.card}>
        <div style={{ borderBottom: '2px solid var(--ops-page-accent)', paddingBottom: 16, marginBottom: 20 }}>
          {(invoice.company_logo_url || invoice.company_name) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              {invoice.company_logo_url && (
                <img src={invoice.company_logo_url} alt={invoice.company_name || ''} style={{ maxHeight: 56, maxWidth: 220, objectFit: 'contain' }} />
              )}
              {invoice.company_name && (
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111827' }}>{invoice.company_name}</div>
              )}
            </div>
          )}
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--ops-page-accent)', letterSpacing: 1, textTransform: 'uppercase' }}>{t.invPubTitle}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
            {invoice.invoice_number}
            {invoice.issue_date && <> · {t.invPubIssued} {new Date(invoice.issue_date).toLocaleDateString()}</>}
            {invoice.due_date && <> · {t.invPubDue} {new Date(invoice.due_date).toLocaleDateString()}</>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
          <Block label={t.invProject}>
            <div style={{ fontWeight: 600 }}>{invoice.project_name || '—'}</div>
          </Block>
          <Block label={t.invPubBilledTo}>
            <div style={{ fontWeight: 600 }}>{invoice.client_name_snapshot}</div>
          </Block>
        </div>

        <div style={{ marginBottom: 24 }}>
          <h3 style={styles.h3}>{t.invLineItems}</h3>
          {CATEGORIES.filter(c => linesByCat[c].length > 0).map(category => (
            <div key={category} style={{ marginBottom: 14 }}>
              <div style={styles.catLabel}>{t[PCAT_KEY[category]] || category}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <tbody>
                  {linesByCat[category].map((l, i) => (
                    <tr key={i}>
                      <td style={{ padding: '5px 0' }}>{l.description}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', color: '#6b7280', width: 90 }}>{l.qty} {l.unit || ''}</td>
                      <td style={{ padding: '5px 0', textAlign: 'right', width: 100 }}>{formatCents(l.total_cents, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div style={styles.totalsBox}>
          <Row label={t.invSubtotal} value={invoice.subtotal_cents} currency={currency} />
          {parseFloat(invoice.tax_pct) > 0 && <Row label={`${t.invTax} (${invoice.tax_pct}%)`} value={invoice.tax_cents} currency={currency} />}
          <Row label={t.invTotal} value={invoice.total_cents} bold currency={currency} />
          {parseInt(invoice.retainage_held_cents, 10) > 0 && <Row label={t.invRetainageHeld} value={invoice.retainage_held_cents} currency={currency} />}
          {paid > 0 && <Row label={t.invAmountPaid} value={paid} currency={currency} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', fontWeight: 700, fontSize: 18, color: balance === 0 ? '#059669' : '#111827' }}>
            <span>{balance === 0 && total > 0 ? t.invPaidInFull : t.invBalanceDue}</span>
            <span>{formatCents(balance, currency)}</span>
          </div>
        </div>

        {invoice.terms && (
          <div style={{ marginTop: 16 }}>
            <Block label={t.invTerms}>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{invoice.terms}</div>
            </Block>
          </div>
        )}

        {invoice.status === 'void' && (
          <div style={{ marginTop: 24, padding: 16, background: '#f3f4f6', borderRadius: 8, fontSize: 14, color: '#6b7280' }}>
            {t.invPubNoLonger}.
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
};
