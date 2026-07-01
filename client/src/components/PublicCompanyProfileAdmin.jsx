import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { silentError } from '../errorReporter';
import PhotoCapture from './PhotoCapture';
import PublicCompanyProfileView from './PublicCompanyProfileView';

const blankProfile = {
  slug: '',
  company_name: '',
  display_name: '',
  short_description: '',
  services_offered: [],
  service_areas: [],
  license_info: '',
  equipment_capabilities: [],
  project_types: [],
  quote_instructions: '',
  contact_info: {
    name: '',
    email: '',
    phone: '',
    website: '',
    address: '',
  },
  faq_items: [],
  photos: [],
  is_public: false,
  accepts_service_requests: false,
};

function normalizeProfile(profile = {}) {
  return {
    ...blankProfile,
    ...profile,
    display_name: profile.display_name || profile.company_name || '',
    services_offered: profile.services_offered || [],
    service_areas: profile.service_areas || [],
    equipment_capabilities: profile.equipment_capabilities || [],
    project_types: profile.project_types || [],
    contact_info: { ...blankProfile.contact_info, ...(profile.contact_info || {}) },
    faq_items: profile.faq_items || [],
    photos: profile.photos || [],
  };
}

function parseLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
}

function ListField({ label, hint, value, onChange, placeholder }) {
  return (
    <label style={s.field}>
      <span style={s.label}>{label}</span>
      {hint && <span style={s.hintText}>{hint}</span>}
      <textarea
        style={s.textarea}
        value={(value || []).join('\n')}
        onChange={e => onChange(parseLines(e.target.value))}
        placeholder={placeholder || 'One per line'}
        rows={4}
      />
    </label>
  );
}

function TextField({ label, value, onChange, placeholder, rows = 3, maxLength }) {
  return (
    <label style={s.field}>
      <span style={s.label}>{label}</span>
      <textarea
        style={s.textarea}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
      />
    </label>
  );
}

export default function PublicCompanyProfileAdmin() {
  const [draft, setDraft] = useState(blankProfile);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/admin/company-profile')
      .then(r => setDraft(normalizeProfile(r.data.profile)))
      .catch(() => setError('Failed to load public profile settings.'))
      .finally(() => setLoading(false));
  }, []);

  const publicUrl = useMemo(() => (
    draft.slug ? `${window.location.origin}/companies/${draft.slug}` : ''
  ), [draft.slug]);
  const requestUrl = useMemo(() => (
    draft.slug ? `${window.location.origin}/r/${draft.slug}` : ''
  ), [draft.slug]);

  const update = (key, value) => setDraft(prev => ({ ...prev, [key]: value }));
  const updateContact = (key, value) => setDraft(prev => ({
    ...prev,
    contact_info: { ...(prev.contact_info || {}), [key]: value },
  }));

  const save = async (publish = false) => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const r = publish
        ? await api.post('/admin/company-profile/publish', draft)
        : await api.patch('/admin/company-profile', draft);
      setDraft(normalizeProfile(r.data.profile));
      setMessage(publish ? 'Public profile published.' : 'Public profile saved.');
      if (publish) setPreviewOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save public profile.');
    } finally {
      setSaving(false);
    }
  };

  const unpublish = async () => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const r = await api.post('/admin/company-profile/unpublish');
      setDraft(normalizeProfile(r.data.profile));
      setMessage('Public profile unpublished.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to unpublish public profile.');
    } finally {
      setSaving(false);
    }
  };

  const copy = (value) => {
    if (!value) return;
    navigator.clipboard?.writeText(value).catch(silentError('public-profile-copy'));
  };

  const addFaq = () => update('faq_items', [...(draft.faq_items || []), { question: '', answer: '' }]);
  const updateFaq = (index, key, value) => {
    const next = (draft.faq_items || []).map((item, i) => i === index ? { ...item, [key]: value } : item);
    update('faq_items', next);
  };
  const removeFaq = (index) => update('faq_items', (draft.faq_items || []).filter((_, i) => i !== index));

  if (loading) {
    return <div style={s.card}><p style={s.muted}>Loading public profile settings...</p></div>;
  }

  return (
    <section style={s.card}>
      <div style={s.header}>
        <div>
          <p style={s.kicker}>Public Company Profile</p>
          <h3 style={s.title}>Explain who this company is before someone sends a request.</h3>
          <p style={s.copy}>
            This page is public only when published. It uses the existing request form as the next step.
          </p>
        </div>
        <div style={s.statusBox}>
          <span style={draft.is_public ? s.statusOn : s.statusOff}>
            {draft.is_public ? 'Published' : 'Private'}
          </span>
          {publicUrl && draft.is_public && <a href={publicUrl} target="_blank" rel="noopener noreferrer" style={s.openLink}>Open public page</a>}
        </div>
      </div>

      {publicUrl && (
        <div style={s.linkGrid}>
          <div style={s.linkRow}>
            <span>Profile</span>
            <code style={s.linkCode}>{publicUrl}</code>
            <button type="button" style={s.smallBtn} onClick={() => copy(publicUrl)}>Copy</button>
          </div>
          {draft.accepts_service_requests && (
            <div style={s.linkRow}>
              <span>Request form</span>
              <code style={s.linkCode}>{requestUrl}</code>
              <button type="button" style={s.smallBtn} onClick={() => copy(requestUrl)}>Copy</button>
            </div>
          )}
        </div>
      )}

      <div style={s.formGrid}>
        <label style={s.field}>
          <span style={s.label}>Public company name</span>
          <input
            style={s.input}
            value={draft.display_name || ''}
            onChange={e => update('display_name', e.target.value)}
            placeholder={draft.company_name || 'Company name'}
            maxLength={255}
          />
        </label>
        <TextField
          label="Short description"
          value={draft.short_description}
          onChange={value => update('short_description', value)}
          placeholder="A plain-language summary of who you are, what you do, and who you help."
          rows={3}
          maxLength={700}
        />
        <ListField
          label="Services offered"
          value={draft.services_offered}
          onChange={value => update('services_offered', value)}
          placeholder={'Repair\nMaintenance\nInstallation'}
        />
        <ListField
          label="Service areas"
          value={draft.service_areas}
          onChange={value => update('service_areas', value)}
          placeholder={'Phoenix\nMesa\nScottsdale'}
        />
        <ListField
          label="Project types"
          value={draft.project_types}
          onChange={value => update('project_types', value)}
          placeholder={'Commercial\nResidential\nEmergency work'}
        />
        <ListField
          label="Equipment and capabilities"
          value={draft.equipment_capabilities}
          onChange={value => update('equipment_capabilities', value)}
          placeholder={'Lift access\nFleet service vehicles\nLicensed technicians'}
        />
      </div>

      <div style={s.formGrid}>
        <TextField
          label="License/certification info"
          value={draft.license_info}
          onChange={value => update('license_info', value)}
          placeholder="License numbers, bonding, insurance, certifications, or compliance notes."
          rows={3}
        />
        <TextField
          label="Quote/request instructions"
          value={draft.quote_instructions}
          onChange={value => update('quote_instructions', value)}
          placeholder="Tell visitors what details to include and what happens after they submit a request."
          rows={3}
        />
      </div>

      <div style={s.subsection}>
        <h4 style={s.subTitle}>Contact information</h4>
        <div style={s.contactGrid}>
          {[
            ['name', 'Contact name'],
            ['email', 'Public email'],
            ['phone', 'Public phone'],
            ['website', 'Website'],
            ['address', 'Public address'],
          ].map(([key, label]) => (
            <label key={key} style={s.field}>
              <span style={s.label}>{label}</span>
              <input
                style={s.input}
                value={draft.contact_info?.[key] || ''}
                onChange={e => updateContact(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      <div style={s.subsection}>
        <div style={s.subHeader}>
          <h4 style={s.subTitle}>FAQ</h4>
          <button type="button" style={s.smallBtn} onClick={addFaq}>Add FAQ</button>
        </div>
        {(draft.faq_items || []).length === 0 ? (
          <p style={s.muted}>Add common questions if visitors usually need context before requesting work.</p>
        ) : (
          <div style={s.faqList}>
            {draft.faq_items.map((item, index) => (
              <div key={index} style={s.faqCard}>
                <input
                  style={s.input}
                  value={item.question}
                  onChange={e => updateFaq(index, 'question', e.target.value)}
                  placeholder="Question"
                  maxLength={220}
                />
                <textarea
                  style={s.textarea}
                  value={item.answer}
                  onChange={e => updateFaq(index, 'answer', e.target.value)}
                  placeholder="Answer"
                  rows={2}
                  maxLength={1200}
                />
                <button type="button" style={s.dangerBtn} onClick={() => removeFaq(index)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={s.subsection}>
        <h4 style={s.subTitle}>Public photos or examples</h4>
        <p style={s.photoHelp}>Only add photos that are safe to show publicly. Internal job photos stay private unless uploaded here.</p>
        <PhotoCapture photos={draft.photos || []} onChange={photos => update('photos', photos)} maxPhotos={8} />
      </div>

      {message && <p style={s.success}>{message}</p>}
      {error && <p style={s.error}>{error}</p>}

      <div style={s.actions}>
        <button type="button" style={s.secondaryBtn} onClick={() => setPreviewOpen(open => !open)}>
          {previewOpen ? 'Hide preview' : 'Preview'}
        </button>
        <button type="button" style={s.secondaryBtn} onClick={() => save(false)} disabled={saving}>
          {saving ? 'Saving...' : 'Save changes'}
        </button>
        {draft.is_public ? (
          <button type="button" style={s.dangerOutlineBtn} onClick={unpublish} disabled={saving}>Unpublish</button>
        ) : (
          <button type="button" style={s.primaryBtn} onClick={() => save(true)} disabled={saving}>Publish profile</button>
        )}
      </div>

      {previewOpen && (
        <div style={s.preview}>
          <PublicCompanyProfileView profile={{ ...draft, is_public: true }} preview />
        </div>
      )}
    </section>
  );
}

const s = {
  card: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 18, boxShadow: '0 1px 4px rgba(15,23,42,0.04)' },
  header: { display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap' },
  kicker: { margin: '0 0 5px', color: '#2563eb', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 900 },
  title: { margin: 0, fontSize: 18, lineHeight: 1.25, color: '#0f172a' },
  copy: { margin: '7px 0 0', color: '#64748b', fontSize: 13, lineHeight: 1.45, maxWidth: 680 },
  statusBox: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 },
  statusOn: { color: '#047857', background: '#d1fae5', borderRadius: 999, padding: '5px 9px', fontSize: 12, fontWeight: 850 },
  statusOff: { color: '#64748b', background: '#f1f5f9', borderRadius: 999, padding: '5px 9px', fontSize: 12, fontWeight: 850 },
  openLink: { color: '#2563eb', fontSize: 12, fontWeight: 800, textDecoration: 'none' },
  linkGrid: { display: 'flex', flexDirection: 'column', gap: 8, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 16, maxWidth: '100%', overflow: 'hidden' },
  linkRow: { display: 'grid', gridTemplateColumns: 'minmax(72px, 90px) minmax(0, 1fr) auto', gap: 8, alignItems: 'center', fontSize: 12, color: '#64748b', minWidth: 0 },
  linkCode: { display: 'block', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word', color: '#475569', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginTop: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
  label: { color: '#334155', fontSize: 12, fontWeight: 850 },
  hintText: { color: '#64748b', fontSize: 12, lineHeight: 1.35 },
  input: { border: '1px solid #cbd5e1', borderRadius: 8, padding: '9px 10px', fontSize: 14, fontFamily: 'inherit', width: '100%', background: '#fff' },
  textarea: { border: '1px solid #cbd5e1', borderRadius: 8, padding: '9px 10px', fontSize: 14, fontFamily: 'inherit', width: '100%', resize: 'vertical', minHeight: 86, background: '#fff' },
  subsection: { borderTop: '1px solid #e2e8f0', marginTop: 18, paddingTop: 16 },
  subHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  subTitle: { margin: '0 0 10px', color: '#0f172a', fontSize: 15 },
  contactGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 },
  faqList: { display: 'flex', flexDirection: 'column', gap: 10 },
  faqCard: { display: 'grid', gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.2fr) auto', gap: 10, alignItems: 'start', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 },
  muted: { color: '#64748b', fontSize: 13, lineHeight: 1.45, margin: 0 },
  photoHelp: { color: '#64748b', fontSize: 13, lineHeight: 1.45, margin: '0 0 14px' },
  success: { color: '#047857', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '9px 10px', borderRadius: 8, fontSize: 13, fontWeight: 800 },
  error: { color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', padding: '9px 10px', borderRadius: 8, fontSize: 13, fontWeight: 800 },
  actions: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 },
  primaryBtn: { border: 'none', borderRadius: 8, background: '#2563eb', color: '#fff', padding: '10px 14px', fontSize: 13, fontWeight: 850, cursor: 'pointer' },
  secondaryBtn: { border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#334155', padding: '10px 14px', fontSize: 13, fontWeight: 850, cursor: 'pointer' },
  smallBtn: { border: '1px solid #cbd5e1', borderRadius: 7, background: '#fff', color: '#334155', padding: '6px 9px', fontSize: 12, fontWeight: 800, cursor: 'pointer' },
  dangerBtn: { border: '1px solid #fecaca', borderRadius: 7, background: '#fff', color: '#b91c1c', padding: '7px 10px', fontSize: 12, fontWeight: 800, cursor: 'pointer' },
  dangerOutlineBtn: { border: '1px solid #fecaca', borderRadius: 8, background: '#fff', color: '#b91c1c', padding: '10px 14px', fontSize: 13, fontWeight: 850, cursor: 'pointer' },
  preview: { borderTop: '1px solid #e2e8f0', marginTop: 18, paddingTop: 8, background: '#f8fafc', borderRadius: 8 },
};
