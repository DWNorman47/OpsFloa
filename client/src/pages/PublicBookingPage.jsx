// Public booking — three-step wizard at /book/:companySlug (or
// /book/:companySlug/:typeSlug to skip the picker). No auth.
// Reads availability from the public router; books to the public
// router which atomically round-robin-assigns inside a TX with
// FOR UPDATE locks.

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { publicLinkError } from '../utils/publicErrors';
import { getT } from '../i18n';
import { detectLanguage } from '../languageDetect';
import { formatDate, formatDateTime, langToLocale } from '../utils';

const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const pub = axios.create({ baseURL });

// Public visitors are anonymous, so resolve the language from the browser.
const lang = detectLanguage();
const t = getT(lang);

const locationKindLabels = () => ({
  phone: t.pbkLocationPhone,
  video: t.pbkLocationVideo,
  onsite: t.pbkLocationOnsite,
  office: t.pbkLocationOffice,
  other: t.pbkLocationOther,
});
const weekdayFull = () => [
  t.pbkWeekdaySunday,
  t.pbkWeekdayMonday,
  t.pbkWeekdayTuesday,
  t.pbkWeekdayWednesday,
  t.pbkWeekdayThursday,
  t.pbkWeekdayFriday,
  t.pbkWeekdaySaturday,
];

export default function PublicBookingPage() {
  const { companySlug, typeSlug } = useParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(typeSlug ? 'date' : 'type');
  const [companyName, setCompanyName] = useState(null);
  const [types, setTypes] = useState([]);
  const [type, setType] = useState(null);
  const [typesLoading, setTypesLoading] = useState(!typeSlug);
  const [typeLoading, setTypeLoading] = useState(!!typeSlug);
  const [pageError, setPageError] = useState(null);
  const [typeError, setTypeError] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);

  const LOCATION_KIND_LABELS = locationKindLabels();

  // Step 1: load types if no slug
  useEffect(() => {
    if (typeSlug) return undefined;
    let alive = true;
    setStep('type');
    setType(null);
    setTypeError(null);
    setSelectedSlot(null);
    setTypesLoading(true);
    setPageError(null);
    pub.get(`/public/book/${companySlug}`)
      .then(r => {
        if (!alive) return;
        setCompanyName(r.data.company_name);
        setTypes(r.data.types || []);
      })
      .catch(err => {
        if (!alive) return;
        setTypes([]);
        setPageError(publicLinkError(err, t.pbkPageUnavailable));
      })
      .finally(() => { if (alive) setTypesLoading(false); });
    return () => { alive = false; };
  }, [companySlug, typeSlug]);

  // Step 1b/2: load type detail if typeSlug given (or after picking)
  useEffect(() => {
    if (!typeSlug) return undefined;
    let alive = true;
    setStep('date');
    setSelectedSlot(null);
    setTypeLoading(true);
    setTypeError(null);
    pub.get(`/public/book/${companySlug}/${typeSlug}`)
      .then(r => {
        if (!alive) return;
        setType(r.data);
        setCompanyName(r.data.company_name);
      })
      .catch(err => {
        if (!alive) return;
        setType(null);
        setTypeError(publicLinkError(err, t.pbkTypeUnavailable));
      })
      .finally(() => { if (alive) setTypeLoading(false); });
    return () => { alive = false; };
  }, [companySlug, typeSlug]);

  function pickType(t) {
    navigate(`/book/${companySlug}/${t.slug}`);
    setStep('date');
  }

  // ── Type-picker step ─────────────────────────────────────────────────────
  if (!typeSlug && !type) {
    return (
      <Shell title={companyName ? `${t.pbkBookWith} ${companyName}` : t.pbkBookAnAppointment}>
        {typesLoading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
            {t.pbkLoadingOptions}
          </div>
        ) : pageError ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
            {pageError}
          </div>
        ) : types.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
            {t.pbkNoTypes}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {types.map(t2 => (
              <button
                key={t2.id}
                onClick={() => pickType(t2)}
                style={styles.typeBtn}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>{t2.name}</div>
                  <div style={{ fontSize: 13, color: '#6b7280' }}>{t2.duration_minutes} {t.pbkMin}</div>
                </div>
                {t2.description && <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{t2.description}</div>}
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {LOCATION_KIND_LABELS[t2.location_kind] || t2.location_kind}
                </div>
              </button>
            ))}
          </div>
        )}
      </Shell>
    );
  }

  if (typeLoading) {
    return (
      <Shell title={t.pbkLoading}>
        <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
          {t.pbkLoadingDetails}
        </div>
      </Shell>
    );
  }

  if (typeError && !type) {
    return <Shell title={t.pbkBookingUnavailable}><div style={{ color: '#6b7280', textAlign: 'center' }}>{typeError}</div></Shell>;
  }

  if (!type) return <Shell title={t.pbkBookingUnavailable}><div /></Shell>;

  // ── Date + slot step ────────────────────────────────────────────────────
  if (step === 'date') {
    return (
      <Shell
        title={`${t.pbkBook} ${type.name} ${t.pbkWithLower} ${companyName}`}
        subtitle={`${type.duration_minutes} ${t.pbkMin} · ${LOCATION_KIND_LABELS[type.location_kind] || type.location_kind}`}
      >
        <SlotPicker
          companySlug={companySlug}
          typeSlug={type.slug}
          duration={type.duration_minutes}
          onPick={slot => { setSelectedSlot(slot); setStep('client'); }}
          onBack={() => navigate(`/book/${companySlug}`)}
        />
      </Shell>
    );
  }

  // ── Client form step ────────────────────────────────────────────────────
  if (step === 'client') {
    return (
      <Shell
        title={`${t.pbkConfirm} — ${type.name}`}
        subtitle={`${formatDateTime(selectedSlot, lang)} · ${type.duration_minutes} ${t.pbkMin}`}
      >
        <ClientForm
          companySlug={companySlug}
          typeSlug={type.slug}
          slot={selectedSlot}
          onBack={() => setStep('date')}
        />
      </Shell>
    );
  }
  return null;
}

// ── Slot picker ─────────────────────────────────────────────────────────────

function SlotPicker({ companySlug, typeSlug, duration, onPick, onBack }) {
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(14);

  const WEEKDAY_FULL = weekdayFull();

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data } = await pub.get(`/public/book/${companySlug}/${typeSlug}/availability`, {
        params: { days },
      });
      setSlots(data.slots || []);
    } catch (err) {
      setError(publicLinkError(err, t.pbkAvailabilityLoadFailed));
    } finally { setLoading(false); }
  }, [companySlug, typeSlug, days]);

  useEffect(() => { load(); }, [load]);

  // Group slots by date for a simple two-column day → time layout.
  const byDay = {};
  for (const iso of slots) {
    const d = new Date(iso);
    const key = formatDate(d, lang);
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push({ iso, time: d.toLocaleTimeString(langToLocale(lang), { hour: 'numeric', minute: '2-digit' }) });
  }
  const dayKeys = Object.keys(byDay);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <button onClick={onBack} style={styles.ghostBtn}>← {t.pbkBack}</button>
        <select value={days} onChange={e => setDays(parseInt(e.target.value, 10))} style={styles.select}>
          <option value="7">{t.pbkNext7Days}</option>
          <option value="14">{t.pbkNext14Days}</option>
          <option value="30">{t.pbkNext30Days}</option>
        </select>
      </div>

      {loading ? <div style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>{t.pbkLoadingAvailability}</div> :
        error ? <div style={styles.errorBox}>{error}</div> :
        slots.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
            {t.pbkNoSlots}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {dayKeys.map(dayKey => {
              const d = new Date(byDay[dayKey][0].iso);
              return (
                <div key={dayKey} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1d4ed8', marginBottom: 8 }}>
                    {WEEKDAY_FULL[d.getDay()]}, {dayKey}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {byDay[dayKey].map(s => (
                      <button key={s.iso} onClick={() => onPick(s.iso)} style={styles.slotBtn}>
                        {s.time}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}

// ── Client form ─────────────────────────────────────────────────────────────

function ClientForm({ companySlug, typeSlug, slot, onBack }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  async function submit() {
    setError(null); setSubmitting(true);
    try {
      const { data } = await pub.post(`/public/book/${companySlug}/${typeSlug}`, {
        scheduled_at: slot,
        client_name: name.trim(),
        client_email: email.trim(),
        client_phone: phone.trim() || null,
        client_notes: notes || null,
      });
      setSuccess(data);
    } catch (err) {
      setError(publicLinkError(err, t.pbkBookingFailed));
    } finally { setSubmitting(false); }
  }

  if (success) {
    const manageUrl = `${window.location.origin}/book/manage/${success.manage_token}`;
    return (
      <div style={{ textAlign: 'center', padding: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#065f46', marginBottom: 8 }}>
          ✓ {t.pbkBookedWith} {success.assigned_user_name}
        </div>
        <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 16 }}>
          {formatDateTime(success.scheduled_at, lang)}
        </div>
        <div style={{ background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 8, padding: 14, textAlign: 'left' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6, textTransform: 'uppercase' }}>
            {t.pbkManageLink}
          </div>
          <div style={{ fontSize: 13, color: '#7c3a00', marginBottom: 8 }}>
            {t.pbkManageLinkHint}
          </div>
          <input
            readOnly
            value={manageUrl}
            onClick={e => e.target.select()}
            style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12 }}
          />
          <button onClick={() => navigator.clipboard?.writeText(manageUrl)} style={{ ...styles.primaryBtn, marginTop: 8 }}>
            {t.pbkCopy}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} style={styles.ghostBtn}>← {t.pbkChooseDifferentTime}</button>
      <div style={{ marginTop: 14 }}>
        {error && <div style={styles.errorBox}>{error}</div>}
        <Field label={t.pbkFullName} required>
          <input value={name} onChange={e => setName(e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.pbkEmail} required>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.pbkPhone}>
          <input value={phone} onChange={e => setPhone(e.target.value)} style={styles.input} />
        </Field>
        <Field label={t.pbkNotesOptional}>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ ...styles.input, minHeight: 80 }} placeholder={t.pbkNotesPlaceholder} />
        </Field>
        <button
          onClick={submit}
          disabled={submitting || !name.trim() || !email.trim()}
          style={{ ...styles.primaryBtn, width: '100%', marginTop: 12 }}
        >
          {submitting ? t.pbkBooking : t.pbkConfirmBooking}
        </button>
      </div>
    </div>
  );
}

// ── Manage page ─────────────────────────────────────────────────────────────

export function PublicBookingManagePage() {
  const { token } = useParams();
  const [appt, setAppt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const LOCATION_KIND_LABELS = locationKindLabels();

  useEffect(() => {
    pub.get(`/public/book/manage/${token}`)
      .then(r => setAppt(r.data))
      .catch(err => setError(publicLinkError(err, t.pbkApptNotFound)))
      .finally(() => setLoading(false));
  }, [token]);

  async function cancel() {
    setCancelling(true);
    try {
      await pub.post(`/public/book/manage/${token}/cancel`, { reason: reason || null });
      setCancelled(true);
    } catch (err) {
      setError(publicLinkError(err, t.pbkCancelFailed));
    } finally { setCancelling(false); }
  }

  if (loading) return <Shell title={t.pbkLoading}><div /></Shell>;
  if (error && !appt) return <Shell title={t.pbkNotFound}><div style={{ color: '#6b7280' }}>{error}</div></Shell>;
  if (cancelled) return <Shell title={t.pbkCancelled}><div style={{ color: '#6b7280' }}>{t.pbkCancelledNotice} {appt?.company_name} {t.pbkHasBeenNotified}</div></Shell>;

  const canCancel = appt?.status === 'booked' || appt?.status === 'confirmed';

  return (
    <Shell title={`${t.pbkYourApptWith} ${appt.company_name}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
        <Row label={t.pbkStatus} value={appt.status} />
        <Row label={t.pbkWhen} value={formatDateTime(appt.scheduled_at, lang)} />
        <Row label={t.pbkDuration} value={`${appt.duration_minutes} ${t.pbkMin}`} />
        <Row label={t.pbkType} value={appt.appointment_type_name} />
        <Row label={t.pbkWith} value={appt.assigned_user_name} />
        <Row label={t.pbkLocation} value={LOCATION_KIND_LABELS[appt.location_kind]} />
        {appt.location_detail && <Row label={t.pbkDetails} value={appt.location_detail} />}
      </div>

      {canCancel ? (
        <div style={{ marginTop: 24, padding: 16, background: '#fef2f2', borderRadius: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#991b1b', marginBottom: 8 }}>{t.pbkNeedToCancel}</div>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder={t.pbkReasonOptional}
            style={{ ...styles.input, minHeight: 60, marginBottom: 8 }}
          />
          <button onClick={cancel} disabled={cancelling} style={{ background: '#dc2626', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            {cancelling ? t.pbkCancelling : t.pbkCancelAppointment}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 24, padding: 14, background: '#f3f4f6', borderRadius: 8, fontSize: 13, color: '#6b7280' }}>
          {t.pbkCannotCancelPrefix} <strong>{appt.status}</strong> {t.pbkCannotCancelSuffix}
        </div>
      )}
    </Shell>
  );
}

// ── Shared shell + small parts ──────────────────────────────────────────────

function Shell({ title, subtitle, children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb', padding: '40px 16px' }}>
      <div style={styles.card}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827', textAlign: 'center' }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 13, color: '#6b7280', textAlign: 'center', margin: '4px 0 24px' }}>{subtitle}</p>}
        {!subtitle && <div style={{ height: 16 }} />}
        {children}
      </div>
    </div>
  );
}
function Field({ label, required, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 12 }}>
      {label}{required && <span style={{ color: '#ef4444' }}>*</span>}
      {children}
    </label>
  );
}
function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
      <span style={{ color: '#6b7280' }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

const styles = {
  card: { maxWidth: 560, margin: '0 auto', background: '#fff', borderRadius: 12, padding: 32, boxShadow: '0 4px 20px rgba(0,0,0,0.06)' },
  typeBtn: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, cursor: 'pointer', textAlign: 'left', transition: 'border-color 0.15s' },
  slotBtn: { background: '#f0f4ff', color: '#1d4ed8', border: '1px solid #c7d2fe', padding: '8px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  primaryBtn: { background: 'var(--ops-primary)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  select: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' },
  input: { padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: 14 },
};
