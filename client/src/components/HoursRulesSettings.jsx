import React, { useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { invalidateCache } from '../offlineDb';
import { silentError } from '../errorReporter';

/**
 * Admin UI for the configurable work-hour / pay rules (Milestone 1: company
 * standard hours + punch rounding + the actual-vs-paid transparency toggle).
 * Reads/writes the `hours_rules` JSON policy setting. The server engine
 * (server/utils/hoursRules.js) is the source of truth for how the policy is
 * evaluated; this form just edits the document and POSTs it back.
 */

const DOW = [1, 2, 3, 4, 5, 6, 0]; // Mon…Sat, Sun last (display order)

// Presets fill the whole form. A country is just a saved policy — adding one is
// authoring a preset here, not writing code.
const PRESETS = {
  off: () => ({ ...blankForm(), enabled: false }),
  honduras: () => ({
    enabled: true,
    stdStart: '07:00', stdEnd: '16:00', stdBreak: '60',
    workDays: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 0: false },
    inRef: 'schedule', inInterval: '60', inGrace: '15', inDir: 'against_worker',
    outRef: 'schedule', outInterval: '60', outGrace: '30', outDir: 'toward_worker',
    showActualAndPaid: true,
  }),
  us_quarter: () => ({
    ...blankForm(),
    enabled: true,
    inRef: 'clock', inInterval: '15', inGrace: '0', inDir: 'nearest',
    outRef: 'clock', outInterval: '15', outGrace: '0', outDir: 'nearest',
    showActualAndPaid: true,
  }),
};

function blankForm() {
  return {
    enabled: false,
    stdStart: '07:00', stdEnd: '16:00', stdBreak: '60',
    workDays: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: false, 0: false },
    inRef: 'schedule', inInterval: '15', inGrace: '0', inDir: 'off',
    outRef: 'schedule', outInterval: '15', outGrace: '0', outDir: 'off',
    showActualAndPaid: true,
  };
}

// Policy document → flat form state (pick a representative working day).
function policyToForm(raw) {
  if (!raw) return blankForm();
  let p;
  try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return blankForm(); }
  if (!p || typeof p !== 'object') return blankForm();
  const f = blankForm();
  f.enabled = p.enabled === true;
  const sh = p.standardHours || {};
  const days = Object.keys(sh).filter(k => sh[k] && sh[k].start);
  if (days.length) {
    const rep = sh[days[0]];
    f.stdStart = rep.start || f.stdStart;
    f.stdEnd = rep.end || f.stdEnd;
    f.stdBreak = String(rep.unpaidBreakMin ?? f.stdBreak);
    f.workDays = { 0: false, 1: false, 2: false, 3: false, 4: false, 5: false, 6: false };
    days.forEach(d => { f.workDays[d] = true; });
  }
  const ci = (p.rounding && p.rounding.clockIn) || {};
  const co = (p.rounding && p.rounding.clockOut) || {};
  if (ci.reference) f.inRef = ci.reference;
  if (ci.direction) f.inDir = ci.direction;
  if (ci.intervalMin != null) f.inInterval = String(ci.intervalMin);
  if (ci.graceMin != null) f.inGrace = String(ci.graceMin);
  if (co.reference) f.outRef = co.reference;
  if (co.direction) f.outDir = co.direction;
  if (co.intervalMin != null) f.outInterval = String(co.intervalMin);
  if (co.graceMin != null) f.outGrace = String(co.graceMin);
  f.showActualAndPaid = p.display ? p.display.showActualAndPaid !== false : true;
  return f;
}

// Flat form state → policy document.
function formToPolicy(f) {
  const standardHours = {};
  const day = { start: f.stdStart, end: f.stdEnd, unpaidBreakMin: parseInt(f.stdBreak, 10) || 0 };
  Object.keys(f.workDays).forEach(d => { if (f.workDays[d]) standardHours[d] = { ...day }; });
  return {
    version: 1,
    enabled: !!f.enabled,
    standardHours,
    rounding: {
      clockIn:  { reference: f.inRef,  intervalMin: parseInt(f.inInterval, 10) || 15,  graceMin: parseInt(f.inGrace, 10) || 0,  direction: f.inDir },
      clockOut: { reference: f.outRef, intervalMin: parseInt(f.outInterval, 10) || 15, graceMin: parseInt(f.outGrace, 10) || 0, direction: f.outDir },
    },
    premiums: {},
    display: { showActualAndPaid: !!f.showActualAndPaid },
  };
}

export default function HoursRulesSettings({ settings, onSettingsUpdated }) {
  const t = useT();
  const [form, setForm] = useState(() => policyToForm(settings?.hours_rules));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setSaved(false); };
  const toggleDay = (d) => setForm(f => ({ ...f, workDays: { ...f.workDays, [d]: !f.workDays[d] } }));
  const applyPreset = (key) => { if (PRESETS[key]) { setForm(PRESETS[key]()); setSaved(false); } };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const policy = formToPolicy(form);
      const r = await api.patch('/admin/settings', { hours_rules: JSON.stringify(policy) });
      onSettingsUpdated?.(r.data);
      await invalidateCache?.('settings');
      setSaved(true);
    } catch (err) {
      setError(err?.response?.data?.error || t.hrSaveFailed);
      silentError('hoursrules')(err);
    } finally {
      setSaving(false);
    }
  };

  const schedRule = form.inRef === 'schedule' || form.outRef === 'schedule';

  return (
    <div style={s.card}>
      <div style={s.headRow}>
        <div>
          <h3 style={s.title}>{t.hrTitle}</h3>
          <p style={s.sub}>{t.hrDesc}</p>
        </div>
        <label style={s.switchWrap}>
          <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} style={{ display: 'none' }} />
          <span style={{ ...s.switch, background: form.enabled ? '#059669' : '#d1d5db' }}>
            <span style={{ ...s.knob, transform: form.enabled ? 'translateX(20px)' : 'translateX(0)' }} />
          </span>
          <span style={s.switchLabel}>{form.enabled ? t.hrEnabled : t.hrDisabled}</span>
        </label>
      </div>

      <div style={s.presetRow}>
        <span style={s.label}>{t.hrPreset}</span>
        <button type="button" style={s.presetBtn} onClick={() => applyPreset('honduras')}>{t.hrPresetHonduras}</button>
        <button type="button" style={s.presetBtn} onClick={() => applyPreset('us_quarter')}>{t.hrPresetUS}</button>
        <button type="button" style={s.presetBtn} onClick={() => applyPreset('off')}>{t.hrPresetOff}</button>
      </div>

      {form.enabled && (
        <>
          {schedRule && (
            <section style={s.section}>
              <h4 style={s.h4}>{t.hrStandardHours}</h4>
              <p style={s.hint}>{t.hrStandardHint}</p>
              <div style={s.grid}>
                <Field label={t.hrStart}><input type="time" style={s.input} value={form.stdStart} onChange={e => set('stdStart', e.target.value)} /></Field>
                <Field label={t.hrEnd}><input type="time" style={s.input} value={form.stdEnd} onChange={e => set('stdEnd', e.target.value)} /></Field>
                <Field label={t.hrBreak}><input type="number" min="0" step="5" style={s.input} value={form.stdBreak} onChange={e => set('stdBreak', e.target.value)} /></Field>
              </div>
              <div style={s.days}>
                {DOW.map(d => (
                  <button key={d} type="button" onClick={() => toggleDay(d)}
                    style={{ ...s.dayBtn, ...(form.workDays[d] ? s.dayOn : {}) }}>
                    {t[`hrDay${d}`]}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section style={s.section}>
            <h4 style={s.h4}>{t.hrRounding}</h4>
            <EdgeEditor t={t} title={t.hrClockIn} prefix="in" form={form} set={set} />
            <EdgeEditor t={t} title={t.hrClockOut} prefix="out" form={form} set={set} />
          </section>

          <section style={s.section}>
            <label style={s.checkRow}>
              <input type="checkbox" checked={form.showActualAndPaid} onChange={e => set('showActualAndPaid', e.target.checked)} />
              <span>{t.hrTransparency}</span>
            </label>
            <p style={s.hint}>{t.hrTransparencyHint}</p>
          </section>
        </>
      )}

      {error && <p role="alert" style={s.error}>{error}</p>}
      <div style={s.actions}>
        <button style={{ ...s.saveBtn, ...(saving ? { opacity: 0.6 } : {}) }} onClick={save} disabled={saving}>
          {saving ? t.hrSaving : t.hrSave}
        </button>
        {saved && <span style={s.savedMsg}>{t.hrSaved}</span>}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      {children}
    </div>
  );
}

function EdgeEditor({ t, title, prefix, form, set }) {
  const dir = form[`${prefix}Dir`];
  const ref = form[`${prefix}Ref`];
  return (
    <div style={s.edge}>
      <div style={s.edgeTitle}>{title}</div>
      <div style={s.grid}>
        <Field label={t.hrDirection}>
          <select style={s.input} value={dir} onChange={e => set(`${prefix}Dir`, e.target.value)}>
            <option value="off">{t.hrDirOff}</option>
            <option value="against_worker">{t.hrDirAgainst}</option>
            <option value="toward_worker">{t.hrDirToward}</option>
            <option value="nearest">{t.hrDirNearest}</option>
          </select>
        </Field>
        {dir !== 'off' && (
          <>
            <Field label={t.hrReference}>
              <select style={s.input} value={ref} onChange={e => set(`${prefix}Ref`, e.target.value)}>
                <option value="schedule">{t.hrRefSchedule}</option>
                <option value="clock">{t.hrRefClock}</option>
              </select>
            </Field>
            <Field label={t.hrInterval}>
              <input type="number" min="1" step="1" style={s.input} value={form[`${prefix}Interval`]} onChange={e => set(`${prefix}Interval`, e.target.value)} />
            </Field>
            {ref === 'schedule' && (
              <Field label={t.hrGrace}>
                <input type="number" min="0" step="1" style={s.input} value={form[`${prefix}Grace`]} onChange={e => set(`${prefix}Grace`, e.target.value)} />
              </Field>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', marginBottom: 24 },
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  title: { fontSize: 17, fontWeight: 700, margin: 0 },
  sub: { fontSize: 13, color: '#6b7280', margin: '6px 0 0', lineHeight: 1.5, maxWidth: 560 },
  switchWrap: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', whiteSpace: 'nowrap' },
  switch: { position: 'relative', width: 44, height: 24, borderRadius: 999, transition: 'background 0.15s', display: 'inline-block', flexShrink: 0 },
  knob: { position: 'absolute', top: 2, left: 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'transform 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' },
  switchLabel: { fontSize: 13, fontWeight: 600, color: '#374151' },
  presetRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 4px', flexWrap: 'wrap' },
  presetBtn: { background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 999, padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  section: { marginTop: 22, paddingTop: 18, borderTop: '1px solid #f1f5f9' },
  h4: { fontSize: 14, fontWeight: 700, margin: '0 0 4px' },
  hint: { fontSize: 12, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 },
  grid: { display: 'flex', gap: 14, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  input: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, minWidth: 90 },
  days: { display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' },
  dayBtn: { padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', background: '#fff', color: '#9ca3af', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  dayOn: { background: '#ecfdf5', borderColor: '#059669', color: '#047857' },
  edge: { marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 8 },
  edgeTitle: { fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 8 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, marginTop: 12 },
  actions: { display: 'flex', alignItems: 'center', gap: 14, marginTop: 20 },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  savedMsg: { fontSize: 13, color: '#059669', fontWeight: 600 },
};
