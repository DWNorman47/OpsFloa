/**
 * Public intake form for customer requests. Unauthenticated and reached at
 * /r/:slug where :slug is the company slug. Includes a
 * hidden honeypot field and relies on server-side rate limiting.
 */

import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

export default function ServiceRequest() {
  const { slug } = useParams();
  const [companyName, setCompanyName] = useState('');
  const [accepting, setAccepting] = useState(true);
  const [hasPublicProfile, setHasPublicProfile] = useState(false);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    requester_name: '',
    requester_email: '',
    requester_phone: '',
    requester_address: '',
    category: '',
    description: '',
    website: '', // honeypot
  });

  useDocumentMeta({
    title: companyName ? `Request work from ${companyName}` : 'Request work',
    description: `Submit a service, support, or work request to ${companyName || 'this business'} via OpsFloa.`,
    robots: 'noindex',
  });

  useEffect(() => {
    api.get(`/public/service-requests/${slug}`)
      .then(r => {
        setCompanyName(r.data.company_name);
        setAccepting(r.data.accepting);
        setHasPublicProfile(!!r.data.has_public_profile);
        const cats = r.data.categories || [];
        setCategories(cats);
        if (cats.length > 0) setForm(f => ({ ...f, category: cats[0] }));
      })
      .catch(err => {
        if (err.response?.status === 404) setNotFound(true);
        else setError('Failed to load form. Please try again.');
      })
      .finally(() => setLoading(false));
  }, [slug]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.requester_name.trim()) { setError('Please enter your name.'); return; }
    if (!form.description.trim()) { setError('Please describe what you need.'); return; }
    setSubmitting(true); setError('');
    try {
      await api.post(`/public/service-requests/${slug}`, form);
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div style={styles.loading}>Loading...</div>;

  if (notFound) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>We couldn't find that business.</h1>
          <p style={styles.bodyText}>The link you used may be outdated. Please contact them directly.</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={{ fontSize: 48, textAlign: 'center', marginBottom: 12 }}>OK</div>
          <h1 style={styles.title}>Thanks - your request was sent.</h1>
          <p style={styles.bodyText}>
            {companyName} has been notified and will follow up with you directly. If you included an
            email address, they may reply that way; if not, expect a phone call.
          </p>
          <p style={{ ...styles.bodyText, fontSize: 13, color: '#6b7280', marginTop: 20 }}>
            Powered by OpsFloa
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.logo}>OpsFloa</div>
          <h1 style={styles.title}>{companyName}</h1>
          <p style={styles.subtitle}>Request service, support, or an estimate</p>
          {hasPublicProfile && (
            <a href={`/companies/${slug}`} style={styles.profileLink}>View company profile</a>
          )}
        </div>

        {!accepting ? (
          <p style={styles.notAccepting}>
            {companyName} isn't accepting new requests through this form right now. Please contact them directly.
          </p>
        ) : (
          <form onSubmit={submit} style={styles.form}>
            {/* Honeypot, visually hidden and labeled for accessibility tools. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', height: 0, width: 0, overflow: 'hidden' }}>
              <label>Website <input type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={e => set('website', e.target.value)} /></label>
            </div>

            <div style={styles.row}>
              <label style={styles.field}>
                <span style={styles.label}>Your name *</span>
                <input style={styles.input} type="text" required maxLength={200} value={form.requester_name} onChange={e => set('requester_name', e.target.value)} />
              </label>
            </div>

            <div style={styles.row}>
              <label style={styles.field}>
                <span style={styles.label}>Email</span>
                <input style={styles.input} type="email" maxLength={200} value={form.requester_email} onChange={e => set('requester_email', e.target.value)} placeholder="optional" />
              </label>
              <label style={styles.field}>
                <span style={styles.label}>Phone</span>
                <input style={styles.input} type="tel" maxLength={40} value={form.requester_phone} onChange={e => set('requester_phone', e.target.value)} placeholder="optional" />
              </label>
            </div>

            <div style={styles.row}>
              <label style={styles.field}>
                <span style={styles.label}>Address (where the work is)</span>
                <input style={styles.input} type="text" maxLength={500} value={form.requester_address} onChange={e => set('requester_address', e.target.value)} placeholder="optional" />
              </label>
            </div>

            {categories.length > 0 && (
              <div style={styles.row}>
                <label style={styles.field}>
                  <span style={styles.label}>What do you need? *</span>
                  <select style={styles.input} value={form.category} onChange={e => set('category', e.target.value)}>
                    {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
            )}

            <div style={styles.row}>
              <label style={styles.field}>
                <span style={styles.label}>Describe the work *</span>
                <textarea style={{ ...styles.input, minHeight: 120, resize: 'vertical' }} required maxLength={5000} value={form.description} onChange={e => set('description', e.target.value)} placeholder="Tell the team what you need done, including any relevant details (timing, access, conditions)." />
                <span style={styles.counter}>{form.description.length} / 5000</span>
              </label>
            </div>

            {error && <div role="alert" style={styles.error}>{error}</div>}

            <button type="submit" style={{ ...styles.submit, ...(submitting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} disabled={submitting}>
              {submitting ? 'Sending...' : 'Send request'}
            </button>
            <p style={styles.note}>
              By submitting you agree that OpsFloa may share the above with {companyName}.
              Your information is not shared with anyone else.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  page:    { minHeight: '100vh', background: '#f4f6f9', padding: '32px 16px', fontFamily: '-apple-system, Segoe UI, Roboto, sans-serif' },
  card:    { maxWidth: 560, margin: '0 auto', background: '#fff', borderRadius: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', padding: '32px 28px' },
  header:  { marginBottom: 24, textAlign: 'center' },
  logo:    { fontSize: 12, color: 'var(--ops-page-accent)', fontWeight: 800, letterSpacing: 2, marginBottom: 8 },
  title:   { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  subtitle:{ fontSize: 14, color: '#6b7280', marginTop: 6 },
  profileLink: { display: 'inline-flex', marginTop: 10, color: 'var(--ops-page-accent)', fontSize: 13, fontWeight: 700, textDecoration: 'none' },
  bodyText:{ fontSize: 14, color: '#374151', lineHeight: 1.55 },
  notAccepting: { background: '#fef3c7', color: '#92400e', padding: '14px 16px', borderRadius: 8, fontSize: 14 },
  form:    { display: 'flex', flexDirection: 'column', gap: 14 },
  row:     { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field:   { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' },
  label:   { fontSize: 12, fontWeight: 700, color: '#374151' },
  input:   { padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, fontFamily: 'inherit' },
  counter: { fontSize: 11, color: '#9ca3af', alignSelf: 'flex-end', marginTop: 2 },
  submit:  { padding: '12px 24px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8 },
  error:   { color: '#991b1b', background: '#fee2e2', padding: '10px 12px', borderRadius: 8, fontSize: 13 },
  note:    { fontSize: 11, color: '#9ca3af', textAlign: 'center', marginTop: 6 },
  loading: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: 15 },
};
