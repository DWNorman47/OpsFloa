import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { invalidateCache } from '../offlineDb';
import { silentError } from '../errorReporter';
import HoursRuleBuilder from './HoursRuleBuilder';

/**
 * Admin UI for the configurable work-hour / pay rules (Milestone 1: company
 * standard hours + punch rounding + the actual-vs-paid transparency toggle).
 * Reads/writes the `hours_rules` JSON policy setting. The server engine
 * (server/utils/hoursRules.js) is the source of truth for how the policy is
 * evaluated; this form just edits the document and POSTs it back.
 */

const DOW = [1, 2, 3, 4, 5, 6, 0]; // Mon…Sat, Sun last (display order)

// Presets now emit the equivalent CUSTOM RULES (the fixed slots stay off), so
// clicking one builds a matching rule list you can then tweak. A country is just
// a saved policy — adding one is authoring rules here, not writing code.
const EVERY = { kind: 'every_day' };
const PRESETS = {
  off: () => ({ ...blankForm(), enabled: false }),
  honduras: () => ({
    ...blankForm(),
    enabled: true,
    stdStart: '07:00', stdEnd: '16:00', stdBreak: '60',
    workDays: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 0: false },
    showActualAndPaid: true,
    rules: [
      { id: 'p1', type: 'round', when: EVERY, edge: 'in',  reference: 'schedule', direction: 'against_worker', intervalMin: 60, graceMin: 15 },
      { id: 'p2', type: 'round', when: EVERY, edge: 'out', reference: 'schedule', direction: 'toward_worker',  intervalMin: 60, graceMin: 30 },
      { id: 'p3', type: 'rest_day', when: { kind: 'weekdays', days: [0] }, mult: 2 },
      { id: 'p4', type: 'night_diff', when: EVERY, fromHour: 19, toHour: 5, pct: 25 },
    ],
  }),
  us_quarter: () => ({
    ...blankForm(),
    enabled: true,
    showActualAndPaid: true,
    rules: [
      { id: 'p1', type: 'round', when: EVERY, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15, graceMin: 0 },
    ],
  }),
  california: () => ({
    ...blankForm(),
    enabled: true,
    showActualAndPaid: true,
    rules: [
      { id: 'p1', type: 'round', when: EVERY, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15, graceMin: 0 },
      { id: 'p2', type: 'ot_tier', when: EVERY, basis: 'day', afterHours: 8,  mult: 1.5 },
      { id: 'p3', type: 'ot_tier', when: EVERY, basis: 'day', afterHours: 12, mult: 2 },
      { id: 'p4', type: 'seventh_day', when: EVERY, firstHours: 8, firstMult: 1.5, afterMult: 2 },
    ],
  }),
};

function blankForm() {
  return {
    enabled: false,
    stdStart: '07:00', stdEnd: '16:00', stdBreak: '60',
    workDays: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: false, 0: false },
    inRef: 'schedule', inInterval: '15', inGrace: '0', inDir: 'off',
    outRef: 'schedule', outInterval: '15', outGrace: '0', outDir: 'off',
    otMode: 'off', otBands: [],
    sd7Enabled: false, sd7First: '8', sd7FirstMult: '1.5', sd7AfterMult: '2',
    restDayMult: '', minDailyHours: '',
    nightEnabled: false, nightFrom: '19', nightTo: '5', nightPct: '25',
    showActualAndPaid: true,
    // The open-ended half of the policy. Everything above is a fixed slot; this
    // is a list the company writes itself. Kept in policy shape so saving is a
    // pass-through — a second form shape would be one more thing to drift.
    rules: [],
    // Per-role overrides: [{ roleId, addToStandard, rules }]. Empty = every
    // worker uses the Standard Rules above (today's behaviour).
    roleRules: [],
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
  // Rules round-trip untouched. The server's parseRules drops anything it can't
  // read, so a rule that survived a save is already a shape this can hand back.
  f.rules = Array.isArray(p.rules) ? p.rules : [];
  f.roleRules = Array.isArray(p.roleRules)
    ? p.roleRules
        .map(r => ({
          // roleIds is the new multi-role shape; fold in the legacy single roleId.
          roleIds: (Array.isArray(r.roleIds) ? r.roleIds : (r.roleId != null ? [r.roleId] : []))
            .map(Number).filter(Number.isInteger),
          addToStandard: r.addToStandard !== false,
          rules: Array.isArray(r.rules) ? r.rules : [],
        }))
        .filter(r => r.roleIds.length > 0)
    : [];
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
  const ot = p.overtime || {};
  const toBands = list => list.map(b => ({ afterHours: String(b.afterHours), mult: String(b.mult) }));
  if (Array.isArray(ot.dailyBands) && ot.dailyBands.length) { f.otMode = 'day'; f.otBands = toBands(ot.dailyBands); }
  else if (Array.isArray(ot.weeklyBands) && ot.weeklyBands.length) { f.otMode = 'week'; f.otBands = toBands(ot.weeklyBands); }
  const sdc = ot.seventhDay;
  if (sdc && sdc.enabled) {
    f.sd7Enabled = true;
    if (sdc.firstHoursThreshold != null) f.sd7First = String(sdc.firstHoursThreshold);
    if (sdc.firstMult != null) f.sd7FirstMult = String(sdc.firstMult);
    if (sdc.afterMult != null) f.sd7AfterMult = String(sdc.afterMult);
  }
  const prem = p.premiums || {};
  if (prem.restDayMult != null) f.restDayMult = String(prem.restDayMult);
  if (prem.minDailyHours != null) f.minDailyHours = String(prem.minDailyHours);
  const nd = prem.nightDifferential;
  if (nd && parseFloat(nd.pct) > 0) {
    f.nightEnabled = true;
    if (nd.fromHour != null) f.nightFrom = String(nd.fromHour);
    if (nd.toHour != null) f.nightTo = String(nd.toHour);
    if (nd.pct != null) f.nightPct = String(nd.pct);
  }
  f.showActualAndPaid = p.display ? p.display.showActualAndPaid !== false : true;
  return f;
}

// Flat form state → policy document.
function formToPolicy(f) {
  const standardHours = {};
  const day = { start: f.stdStart, end: f.stdEnd, unpaidBreakMin: parseInt(f.stdBreak, 10) || 0 };
  Object.keys(f.workDays).forEach(d => { if (f.workDays[d]) standardHours[d] = { ...day }; });
  const overtime = {};
  if (f.otMode !== 'off' && f.otBands.length) {
    const bands = f.otBands
      .map(b => ({ afterHours: parseFloat(b.afterHours), mult: parseFloat(b.mult) }))
      .filter(b => Number.isFinite(b.afterHours) && b.afterHours >= 0 && Number.isFinite(b.mult) && b.mult > 0)
      .sort((a, b) => a.afterHours - b.afterHours);
    if (bands.length) overtime[f.otMode === 'week' ? 'weeklyBands' : 'dailyBands'] = bands;
  }
  if (f.sd7Enabled) {
    overtime.seventhDay = {
      enabled: true,
      firstHoursThreshold: parseFloat(f.sd7First) || 0,
      firstMult: parseFloat(f.sd7FirstMult) || 1.5,
      afterMult: parseFloat(f.sd7AfterMult) || 2,
    };
  }
  const premiums = {};
  const rdm = parseFloat(f.restDayMult);
  if (Number.isFinite(rdm) && rdm > 0) premiums.restDayMult = rdm;
  const mdh = parseFloat(f.minDailyHours);
  if (Number.isFinite(mdh) && mdh > 0) premiums.minDailyHours = mdh;
  if (f.nightEnabled) {
    premiums.nightDifferential = {
      fromHour: parseInt(f.nightFrom, 10) || 0,
      toHour: parseInt(f.nightTo, 10) || 0,
      pct: parseFloat(f.nightPct) || 0,
    };
  }
  const roleRules = (Array.isArray(f.roleRules) ? f.roleRules : [])
    .map(r => ({
      roleIds: [...new Set((Array.isArray(r.roleIds) ? r.roleIds : []).map(Number).filter(Number.isInteger))],
      addToStandard: r.addToStandard !== false,
      rules: Array.isArray(r.rules) ? r.rules : [],
    }))
    .filter(r => r.roleIds.length > 0); // a section with no roles selected is dropped
  return {
    version: 1,
    enabled: !!f.enabled,
    rules: Array.isArray(f.rules) ? f.rules : [],
    roleRules,
    standardHours,
    rounding: {
      clockIn:  { reference: f.inRef,  intervalMin: parseInt(f.inInterval, 10) || 15,  graceMin: parseInt(f.inGrace, 10) || 0,  direction: f.inDir },
      clockOut: { reference: f.outRef, intervalMin: parseInt(f.outInterval, 10) || 15, graceMin: parseInt(f.outGrace, 10) || 0, direction: f.outDir },
    },
    overtime,
    premiums,
    display: { showActualAndPaid: !!f.showActualAndPaid },
  };
}

export default function HoursRulesSettings({ settings, onSettingsUpdated }) {
  const t = useT();
  const [form, setForm] = useState(() => policyToForm(settings?.hours_rules));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // The form seeds from `settings` lazily (above), which is right when this mounts
  // after settings have loaded — the usual case, since the section is collapsed until
  // opened. But a deep-link (report "View") forces the section open on page load, so we
  // can mount while `settings` is still null and seed a blank/disabled form. Re-seed
  // once real settings arrive after such a mount. Guarded so it fires only for that
  // gap (mounted with no settings → first non-null), never clobbering later edits.
  const hydrated = useRef(settings != null);
  useEffect(() => {
    if (hydrated.current || settings == null) return;
    hydrated.current = true;
    setForm(policyToForm(settings.hours_rules));
  }, [settings]);

  // Company roles for the Role Rules picker + name labels. Empty on 403 (an
  // admin without role visibility just can't add role sections; the Standard
  // Rules still work). Any already-saved roleRules keep their id either way.
  const [roles, setRoles] = useState([]);
  useEffect(() => {
    api.get('/admin/roles').then(r => setRoles(r.data || [])).catch(silentError('hoursrules-roles'));
  }, []);

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setSaved(false); };
  const toggleDay = (d) => { setForm(f => ({ ...f, workDays: { ...f.workDays, [d]: !f.workDays[d] } })); setSaved(false); };
  // A preset rewrites only Standard Rules/Hours; role sections are preserved.
  const applyPreset = (key) => { if (PRESETS[key]) { setForm(f => ({ ...PRESETS[key](), roleRules: f.roleRules })); setSaved(false); } };

  const roleName = (id) => roles.find(r => r.id === Number(id))?.name || `#${id}`;
  // Every role id already claimed by any section — a role belongs to at most one
  // section so its effective rule list stays unambiguous.
  const usedRoleIds = new Set(form.roleRules.flatMap(r => r.roleIds || []));
  const addableRoles = roles.filter(r => !usedRoleIds.has(r.id));
  const addRoleSection = () => {
    if (addableRoles.length === 0) return;
    set('roleRules', [...form.roleRules, { roleIds: [], addToStandard: true, rules: [] }]);
  };
  const toggleSectionRole = (idx, rid) => {
    const cur = form.roleRules[idx].roleIds || [];
    updateRoleSection(idx, { roleIds: cur.includes(rid) ? cur.filter(x => x !== rid) : [...cur, rid] });
  };
  const updateRoleSection = (idx, patch) =>
    set('roleRules', form.roleRules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRoleSection = (idx) => set('roleRules', form.roleRules.filter((_, i) => i !== idx));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const policy = formToPolicy(form);
      const r = await api.patch('/admin/settings', {
        hours_rules: JSON.stringify(policy),
        expected_settings: { hours_rules: settings?.hours_rules || '' },
      });
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
  // Any Standard or role rule configured → the company has real rules to protect,
  // so the (overwriting) preset shortcuts are hidden.
  const hasSavedRules = (form.rules?.length || 0) > 0 || (form.roleRules?.length || 0) > 0;

  return (
    <div style={s.card}>
      <div style={s.headRow}>
        <div>
          <p style={s.sub}>{t.hrDesc}</p>
          <p style={s.glossary}>{t.hrGlossary}</p>
        </div>
        <label style={s.switchWrap}>
          <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} style={{ display: 'none' }} />
          <span style={{ ...s.switch, background: form.enabled ? '#059669' : '#d1d5db' }}>
            <span style={{ ...s.knob, transform: form.enabled ? 'translateX(20px)' : 'translateX(0)' }} />
          </span>
          <span style={s.switchLabel}>{form.enabled ? t.hrEnabled : t.hrDisabled}</span>
        </label>
      </div>

      {/* Presets overwrite the Standard Rules/Hours, so once a company has built
          any rules we hide them — a stray "California" tap shouldn't wipe real
          config. They reappear only when the rule list is empty again. */}
      {!hasSavedRules && (
        <div style={s.presetRow}>
          <span style={s.label}>{t.hrPreset}</span>
          <button type="button" style={s.presetBtn} onClick={() => applyPreset('honduras')}>{t.hrPresetHonduras}</button>
          <button type="button" style={s.presetBtn} onClick={() => applyPreset('us_quarter')}>{t.hrPresetUS}</button>
          <button type="button" style={s.presetBtn} onClick={() => applyPreset('california')}>{t.hrPresetCalifornia}</button>
          <button type="button" style={s.presetBtn} onClick={() => applyPreset('off')}>{t.hrPresetOff}</button>
        </div>
      )}

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

          {/* Rounding, Overtime tiers, and Premiums used to live here as fixed
              slots. They're now custom rules in the builder below (a legacy
              policy is migrated to rules on load). The presets and the rule list
              are the single source of truth. */}

          <section style={s.section}>
            <label style={s.checkRow}>
              <input type="checkbox" checked={form.showActualAndPaid} onChange={e => set('showActualAndPaid', e.target.checked)} />
              <span>{t.hrTransparency}</span>
            </label>
            <p style={s.hint}>{t.hrTransparencyHint}</p>
          </section>

          <HoursRuleBuilder rules={form.rules} onChange={rs => set('rules', rs)} title={t.hrStandardRulesTitle} />

          <section style={s.section}>
            <div style={s.headRow}>
              <div>
                <h4 style={s.h4}>{t.hrRoleRulesTitle}</h4>
                <p style={s.hint}>{t.hrRoleRulesHint}</p>
              </div>
              <button type="button" style={s.addTier} onClick={addRoleSection} disabled={addableRoles.length === 0}>
                {t.hrAddRoleRules}
              </button>
            </div>

            {form.roleRules.map((rr, idx) => {
              const selected = rr.roleIds || [];
              // Roles claimed by OTHER sections — shown disabled here so a role
              // can't land in two sections (its effective rule list must be unique).
              const otherUsed = new Set(form.roleRules.flatMap((x, i) => (i === idx ? [] : (x.roleIds || []))));
              const titleNames = selected.map(roleName).join(', ') || t.hrRolePickerLabel;
              const orphanIds = selected.filter(id => !roles.some(r => r.id === id)); // role since-deleted
              return (
                <div key={idx} style={s.roleCard}>
                  <div style={s.roleHead}>
                    <div style={{ ...s.field, flex: 1 }}>
                      <label style={s.label}>{t.hrRolePickerLabel}</label>
                      <div style={s.chipRow}>
                        {roles.map(r => {
                          const on = selected.includes(r.id);
                          const disabled = !on && otherUsed.has(r.id);
                          return (
                            <button key={r.id} type="button" disabled={disabled}
                              title={disabled ? t.hrRoleUsedElsewhere : undefined}
                              style={{ ...(on ? s.chipOn : s.chip), ...(disabled ? s.chipDisabled : {}) }}
                              onClick={() => toggleSectionRole(idx, r.id)}>{r.name}</button>
                          );
                        })}
                        {/* saved-but-since-deleted roles still round-trip as a chip */}
                        {orphanIds.map(id => (
                          <button key={id} type="button" style={s.chipOn} onClick={() => toggleSectionRole(idx, id)}>{`#${id}`}</button>
                        ))}
                      </div>
                    </div>
                    <button type="button" style={s.tierRemove} onClick={() => removeRoleSection(idx)} aria-label={t.hrRemoveRoleRules}>×</button>
                  </div>

                  <label style={s.checkRow}>
                    <input type="checkbox" checked={rr.addToStandard !== false} onChange={e => updateRoleSection(idx, { addToStandard: e.target.checked })} />
                    <span>{t.hrRoleAddOnTop}</span>
                  </label>
                  <p style={s.hint}>{rr.addToStandard !== false ? t.hrRoleAddOnTopHint : t.hrRoleOverwriteHint}</p>

                  <HoursRuleBuilder
                    rules={rr.rules}
                    onChange={rs => updateRoleSection(idx, { rules: rs })}
                    title={titleNames}
                    help={t.hrRoleRulesBuilderHelp}
                  />
                </div>
              );
            })}
          </section>
        </>
      )}

      <div style={s.actions}>
        {saved && <span style={s.savedMsg}>{t.hrSaved}</span>}
        {error && <span role="alert" style={s.error}>{error}</span>}
        <button style={{ ...s.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={save} disabled={saving}>
          {saving ? t.hrSaving : t.hrSave}
        </button>
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

const s = {
  card: {},
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' },
  title: { fontSize: 17, fontWeight: 700, margin: 0 },
  sub: { fontSize: 13, color: '#6b7280', margin: '6px 0 0', lineHeight: 1.5, maxWidth: 560 },
  glossary: { fontSize: 12, color: '#475569', margin: '8px 0 0', lineHeight: 1.5, maxWidth: 620, background: '#f8fafc', border: '1px solid #eef0f2', borderRadius: 6, padding: '7px 11px' },
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
  tierRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  tierLabel: { fontSize: 13, color: '#374151', fontWeight: 600 },
  tierRemove: { background: '#fef2f2', color: '#ef4444', border: '1px solid #fecaca', borderRadius: 6, width: 26, height: 26, fontSize: 15, fontWeight: 700, cursor: 'pointer', lineHeight: 1 },
  addTier: { background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginTop: 4 },
  roleCard: { marginTop: 14, padding: 14, background: '#f8fafc', border: '1px solid #eef0f2', borderRadius: 10 },
  roleHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 },
  chip: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 999, padding: '4px 12px', fontSize: 12.5, cursor: 'pointer' },
  chipOn: { background: '#059669', color: '#fff', border: '1px solid #059669', borderRadius: 999, padding: '4px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' },
  chipDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  edge: { marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 8 },
  edgeTitle: { fontSize: 13, fontWeight: 700, color: '#334155', marginBottom: 8 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  error: { color: '#e53e3e', fontSize: 13 },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '12px 20px', borderTop: '1px solid #f3f4f6', background: '#fafafa', margin: '16px -20px 0' },
  saveBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '7px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  savedMsg: { fontSize: 13, color: '#059669', fontWeight: 600 },
};
