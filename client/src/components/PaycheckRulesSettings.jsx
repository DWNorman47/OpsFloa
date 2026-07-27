import React, { useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { invalidateCache } from '../offlineDb';
import { silentError } from '../errorReporter';

/**
 * Paycheck Rules — named rulesets describing WHEN paychecks are issued (pay
 * schedule) and HOW/WHEN deductions apply. Edits the `paycheck_rules` settings
 * JSON and PATCHes it back. Rulesets get assigned to employee types + consumed by
 * the pay engine LATER; this is the builder + storage only. Modeled on the custom
 * Hours & Rules / Deductions sections. Money is stored in CENTS; the UI edits
 * dollars. See server/constants/paycheckRuleEnums.js + docs/plans/paycheck-rules.md.
 */

const rid = () => 'pr_' + Math.random().toString(36).slice(2, 9);

const centsToDollars = c => (c > 0 ? String(c / 100) : '');
const dollarsToCents = s => { const n = parseFloat(s); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
const money = v => '$' + Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// Company deductions (id + name) parsed from the sibling `deductions` setting, so
// a ruleset can scope itself to a subset of them.
function companyDeductions(raw) {
  if (!raw) return [];
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const items = Array.isArray(o) ? o : (o && Array.isArray(o.items) ? o.items : []);
    return items.map(it => ({ id: it.id, name: it.name })).filter(d => d.id && d.name);
  } catch { return []; }
}

// policy ruleset → flat form row (cents → dollar strings)
function toForm(r) {
  const s = r.schedule || {}, d = r.deductions || {}, g = d.group || {}, cap = d.cap || {};
  return {
    id: r.id || rid(),
    name: r.name || '',
    frequency: s.frequency || 'biweekly',
    payWeekday: s.payWeekday == null ? 4 : s.payWeekday,
    anchorDate: s.anchorDate || '',
    day1: s.daysOfMonth && s.daysOfMonth[0] != null ? String(s.daysOfMonth[0]) : '15',
    day2: s.daysOfMonth && s.daysOfMonth[1] != null ? String(s.daysOfMonth[1]) : '30',
    lastDay: s.dayOfMonth === 'last',
    dayOfMonth: s.dayOfMonth === 'last' ? '30' : String(s.dayOfMonth || 30),
    weekendShift: s.weekendShift || 'none',
    timing: d.timing || 'every',
    groupBy: g.by || 'pair',
    applyOn: g.applyOn || 'second',
    combineGroup: d.combineGroup !== false,
    exemptAmount: centsToDollars(d.exemptAmountCents || 0),
    capType: cap.type || 'none',
    capAmount: centsToDollars(cap.valueCents || 0),
    capPct: cap.valuePct ? String(cap.valuePct) : '',
    minNet: centsToDollars(d.minNetCents || 0),
    scope: d.scope || 'all',
    selectedDeductionIds: Array.isArray(d.selectedDeductionIds) ? d.selectedDeductionIds : [],
    notes: r.notes || '',
    _open: false,
  };
}

// flat form row → policy ruleset (dollar strings → cents)
function fromForm(f) {
  const dInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null; };
  return {
    id: f.id,
    name: String(f.name || '').trim().slice(0, 120),
    schedule: {
      frequency: f.frequency,
      payWeekday: Number(f.payWeekday),
      anchorDate: /^\d{4}-\d{2}-\d{2}$/.test(f.anchorDate) ? f.anchorDate : null,
      daysOfMonth: [dInt(f.day1), dInt(f.day2)].filter(x => x != null),
      dayOfMonth: f.lastDay ? 'last' : (dInt(f.dayOfMonth) || 30),
      weekendShift: f.weekendShift,
    },
    deductions: {
      timing: f.timing,
      group: { by: f.groupBy, applyOn: f.applyOn },
      combineGroup: !!f.combineGroup,
      exemptAmountCents: dollarsToCents(f.exemptAmount),
      cap: {
        type: f.capType,
        valueCents: f.capType === 'amount' ? dollarsToCents(f.capAmount) : 0,
        valuePct: f.capType === 'percent' ? (parseFloat(f.capPct) || 0) : 0,
      },
      minNetCents: dollarsToCents(f.minNet),
      scope: f.scope,
      selectedDeductionIds: f.scope === 'selected' ? f.selectedDeductionIds : [],
    },
    notes: String(f.notes || '').slice(0, 500),
  };
}

function parse(raw) {
  if (!raw) return [];
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (o && Array.isArray(o.rulesets) ? o.rulesets : []).map(toForm);
  } catch { return []; }
}

const PRESETS = {
  biweekly: () => ({ ...toForm({}), id: rid(), frequency: 'biweekly', payWeekday: 4, timing: 'grouped', groupBy: 'pair', applyOn: 'second', combineGroup: true, exemptAmount: '11000', _open: true }),
  semimonthly: () => ({ ...toForm({}), id: rid(), frequency: 'semimonthly', day1: '15', day2: '30', timing: 'grouped', groupBy: 'month', applyOn: 'last', combineGroup: true, exemptAmount: '11000', _open: true }),
};

function describe(f, t) {
  const wd = (t.pcrWeekdays && t.pcrWeekdays[f.payWeekday]) || '';
  let sched;
  if (f.frequency === 'weekly') sched = `${t.pcrFreqWeekly} · ${wd}`;
  else if (f.frequency === 'biweekly') sched = `${t.pcrFreqBiweekly} · ${wd}`;
  else if (f.frequency === 'semimonthly') sched = `${t.pcrFreqSemimonthly} · ${f.day1 || '–'} & ${f.day2 || '–'}`;
  else sched = `${t.pcrFreqMonthly} · ${f.lastDay ? t.pcrLastDay : (f.dayOfMonth || '–')}`;

  let ded;
  if (f.timing === 'every') ded = t.pcrTimingEvery;
  else {
    const applyName = { first: t.pcrApplyFirst, second: t.pcrApplySecond, last: t.pcrApplyLast }[f.applyOn];
    const byName = { pair: t.pcrGroupPair, month: t.pcrGroupMonth }[f.groupBy];
    ded = `${applyName} · ${byName}`;
    if (parseFloat(f.exemptAmount) > 0) ded += ` · −${money(f.exemptAmount)}`;
  }
  return `${sched}  —  ${ded}`;
}

export default function PaycheckRulesSettings({ settings, onSettingsUpdated }) {
  const t = useT();
  const [rules, setRules] = useState(() => parse(settings?.paycheck_rules));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const deductionOptions = companyDeductions(settings?.deductions);

  const touch = next => { setRules(next); setSaved(false); };
  const patchRule = (id, patch) => touch(rules.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const addRule = f => touch([...rules, f || { ...toForm({}), id: rid(), _open: true }]);
  const dupRule = id => { const r = rules.find(x => x.id === id); if (r) touch([...rules, { ...r, id: rid(), name: `${r.name || t.pcrUnnamed} (copy)`, _open: true }]); };
  const delRule = id => touch(rules.filter(r => r.id !== id));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const policy = { version: 1, rulesets: rules.map(fromForm) };
      const r = await api.patch('/admin/settings', { paycheck_rules: JSON.stringify(policy) });
      onSettingsUpdated?.(r.data);
      await invalidateCache?.('settings');
      setSaved(true);
    } catch (err) {
      setError(err?.response?.data?.error || t.pcrSaveFailed);
      silentError('paycheck_rules')(err);
    } finally { setSaving(false); }
  };

  return (
    <div style={s.card}>
      <p style={s.desc}>{t.pcrDesc}</p>

      {rules.map(f => (
        <div key={f.id} style={s.ruleset}>
          <div style={s.rsHeader}>
            <button type="button" style={s.expandBtn} onClick={() => patchRule(f.id, { _open: !f._open })} aria-expanded={f._open}>
              {f._open ? '▾' : '▸'}
            </button>
            <div style={s.rsTitleWrap}>
              <div style={s.rsName}>{f.name || t.pcrUnnamed}</div>
              <div style={s.rsSummary}>{describe(f, t)}</div>
            </div>
            <button type="button" style={s.miniBtn} onClick={() => dupRule(f.id)}>{t.pcrDuplicate}</button>
            <button type="button" style={{ ...s.miniBtn, color: '#dc2626' }} onClick={() => delRule(f.id)}>{t.pcrDelete}</button>
          </div>

          {f._open && (
            <div style={s.rsBody}>
              <Field label={t.pcrName}>
                <input style={s.input} value={f.name} placeholder={t.pcrNamePlaceholder}
                  onChange={e => patchRule(f.id, { name: e.target.value })} />
              </Field>

              {/* ── Pay schedule ── */}
              <div style={s.sectionLabel}>{t.pcrSchedule}</div>
              <Field label={t.pcrFrequency}>
                <select style={s.input} value={f.frequency} onChange={e => patchRule(f.id, { frequency: e.target.value })}>
                  <option value="weekly">{t.pcrFreqWeekly}</option>
                  <option value="biweekly">{t.pcrFreqBiweekly}</option>
                  <option value="semimonthly">{t.pcrFreqSemimonthly}</option>
                  <option value="monthly">{t.pcrFreqMonthly}</option>
                </select>
              </Field>

              {(f.frequency === 'weekly' || f.frequency === 'biweekly') && (
                <Field label={t.pcrPayday}>
                  <select style={s.input} value={f.payWeekday} onChange={e => patchRule(f.id, { payWeekday: Number(e.target.value) })}>
                    {(t.pcrWeekdays || []).map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </Field>
              )}
              {f.frequency === 'biweekly' && (
                <Field label={t.pcrAnchorDate} hint={t.pcrAnchorHint}>
                  <input type="date" style={s.input} value={f.anchorDate} onChange={e => patchRule(f.id, { anchorDate: e.target.value })} />
                </Field>
              )}
              {f.frequency === 'semimonthly' && (
                <Field label={t.pcrDaysOfMonth} hint={t.pcrDaysHint}>
                  <div style={s.row}>
                    <input type="number" min="1" max="31" style={s.numInput} value={f.day1} onChange={e => patchRule(f.id, { day1: e.target.value })} />
                    <span style={s.amp}>&amp;</span>
                    <input type="number" min="1" max="31" style={s.numInput} value={f.day2} onChange={e => patchRule(f.id, { day2: e.target.value })} />
                  </div>
                </Field>
              )}
              {f.frequency === 'monthly' && (
                <Field label={t.pcrDayOfMonth}>
                  <div style={s.row}>
                    <input type="number" min="1" max="31" style={s.numInput} disabled={f.lastDay} value={f.dayOfMonth} onChange={e => patchRule(f.id, { dayOfMonth: e.target.value })} />
                    <label style={s.check}>
                      <input type="checkbox" checked={f.lastDay} onChange={e => patchRule(f.id, { lastDay: e.target.checked })} /> {t.pcrLastDay}
                    </label>
                  </div>
                </Field>
              )}
              <Field label={t.pcrWeekendShift}>
                <select style={s.input} value={f.weekendShift} onChange={e => patchRule(f.id, { weekendShift: e.target.value })}>
                  <option value="none">{t.pcrShiftNone}</option>
                  <option value="before">{t.pcrShiftBefore}</option>
                  <option value="after">{t.pcrShiftAfter}</option>
                </select>
              </Field>

              {/* ── Deductions ── */}
              <div style={s.sectionLabel}>{t.pcrDeductions}</div>
              <Field label={t.pcrTiming}>
                <select style={s.input} value={f.timing} onChange={e => patchRule(f.id, { timing: e.target.value })}>
                  <option value="every">{t.pcrTimingEvery}</option>
                  <option value="grouped">{t.pcrTimingGrouped}</option>
                </select>
              </Field>
              {f.timing === 'grouped' && (
                <>
                  <Field label={t.pcrGroupBy}>
                    <select style={s.input} value={f.groupBy} onChange={e => patchRule(f.id, { groupBy: e.target.value })}>
                      <option value="pair">{t.pcrGroupPair}</option>
                      <option value="month">{t.pcrGroupMonth}</option>
                    </select>
                  </Field>
                  <Field label={t.pcrApplyOn}>
                    <select style={s.input} value={f.applyOn} onChange={e => patchRule(f.id, { applyOn: e.target.value })}>
                      <option value="first">{t.pcrApplyFirst}</option>
                      <option value="second">{t.pcrApplySecond}</option>
                      <option value="last">{t.pcrApplyLast}</option>
                    </select>
                  </Field>
                  <label style={{ ...s.check, margin: '2px 0 10px' }}>
                    <input type="checkbox" checked={f.combineGroup} onChange={e => patchRule(f.id, { combineGroup: e.target.checked })} /> {t.pcrCombine}
                  </label>
                </>
              )}
              <Field label={t.pcrExempt} hint={t.pcrExemptHint}>
                <div style={s.row}><span style={s.dollar}>$</span>
                  <input type="number" min="0" step="0.01" style={s.numInput} value={f.exemptAmount} onChange={e => patchRule(f.id, { exemptAmount: e.target.value })} />
                </div>
              </Field>
              <Field label={t.pcrCap}>
                <div style={s.row}>
                  <select style={{ ...s.input, maxWidth: 150 }} value={f.capType} onChange={e => patchRule(f.id, { capType: e.target.value })}>
                    <option value="none">{t.pcrCapNone}</option>
                    <option value="amount">{t.pcrCapAmount}</option>
                    <option value="percent">{t.pcrCapPercent}</option>
                  </select>
                  {f.capType === 'amount' && (<><span style={s.dollar}>$</span><input type="number" min="0" step="0.01" style={s.numInput} value={f.capAmount} onChange={e => patchRule(f.id, { capAmount: e.target.value })} /></>)}
                  {f.capType === 'percent' && (<><input type="number" min="0" max="100" style={s.numInput} value={f.capPct} onChange={e => patchRule(f.id, { capPct: e.target.value })} /><span style={s.amp}>%</span></>)}
                </div>
              </Field>
              <Field label={t.pcrMinNet} hint={t.pcrMinNetHint}>
                <div style={s.row}><span style={s.dollar}>$</span>
                  <input type="number" min="0" step="0.01" style={s.numInput} value={f.minNet} onChange={e => patchRule(f.id, { minNet: e.target.value })} />
                </div>
              </Field>
              <Field label={t.pcrScope}>
                <select style={s.input} value={f.scope} onChange={e => patchRule(f.id, { scope: e.target.value })}>
                  <option value="all">{t.pcrScopeAll}</option>
                  <option value="selected">{t.pcrScopeSelected}</option>
                </select>
              </Field>
              {f.scope === 'selected' && (
                deductionOptions.length === 0
                  ? <p style={s.hint}>{t.pcrScopeNoDeductions}</p>
                  : <div style={s.checkList}>
                      {deductionOptions.map(d => (
                        <label key={d.id} style={s.check}>
                          <input type="checkbox" checked={f.selectedDeductionIds.includes(d.id)}
                            onChange={e => patchRule(f.id, { selectedDeductionIds: e.target.checked ? [...f.selectedDeductionIds, d.id] : f.selectedDeductionIds.filter(x => x !== d.id) })} /> {d.name}
                        </label>
                      ))}
                    </div>
              )}
              <Field label={t.pcrNotes}>
                <input style={s.input} value={f.notes} onChange={e => patchRule(f.id, { notes: e.target.value })} />
              </Field>
            </div>
          )}
        </div>
      ))}

      <div style={s.addRow}>
        <button type="button" style={s.addBtn} onClick={() => addRule()}>+ {t.pcrAddRuleset}</button>
        <span style={s.presetLabel}>{t.pcrPreset}</span>
        <button type="button" style={s.presetBtn} onClick={() => addRule(PRESETS.biweekly())}>{t.pcrPresetBiweekly}</button>
        <button type="button" style={s.presetBtn} onClick={() => addRule(PRESETS.semimonthly())}>{t.pcrPresetSemimonthly}</button>
      </div>

      <p style={s.note}>{t.pcrNote}</p>
      {error && <p role="alert" style={s.error}>{error}</p>}
      <div style={s.actions}>
        <button style={{ ...s.saveBtn, ...(saving ? { opacity: 0.6 } : {}) }} onClick={save} disabled={saving}>
          {saving ? t.pcrSaving : t.pcrSave}
        </button>
        {saved && <span style={s.savedMsg}>{t.pcrSaved}</span>}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      {children}
      {hint && <div style={s.hint}>{hint}</div>}
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' },
  desc: { fontSize: 13, color: '#6b7280', margin: '0 0 14px', lineHeight: 1.5, maxWidth: 640 },
  ruleset: { border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12, overflow: 'hidden' },
  rsHeader: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#f9fafb' },
  expandBtn: { background: 'none', border: 'none', fontSize: 14, cursor: 'pointer', color: '#6b7280', padding: 0, width: 16 },
  rsTitleWrap: { flex: 1, minWidth: 0 },
  rsName: { fontSize: 14, fontWeight: 700, color: '#111827' },
  rsSummary: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  miniBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '3px 9px', fontSize: 12, cursor: 'pointer', color: '#374151' },
  rsBody: { padding: '12px 14px', borderTop: '1px solid #eef0f2' },
  sectionLabel: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#9ca3af', margin: '14px 0 8px' },
  field: { marginBottom: 10 },
  label: { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input: { width: '100%', maxWidth: 320, padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' },
  numInput: { width: 110, padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  amp: { color: '#6b7280', fontSize: 13 },
  dollar: { color: '#6b7280', fontSize: 13 },
  check: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer' },
  checkList: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0 8px' },
  hint: { fontSize: 12, color: '#94a3b8', marginTop: 3, lineHeight: 1.4 },
  addRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 6 },
  addBtn: { background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  presetLabel: { fontSize: 12, color: '#9ca3af' },
  presetBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 7, padding: '6px 11px', fontSize: 12, cursor: 'pointer', color: '#374151' },
  note: { fontSize: 12, color: '#475569', margin: '14px 0 0', lineHeight: 1.5, maxWidth: 640, background: '#f8fafc', border: '1px solid #eef0f2', borderRadius: 6, padding: '7px 11px' },
  error: { color: '#ef4444', fontSize: 13, marginTop: 12 },
  actions: { display: 'flex', alignItems: 'center', gap: 14, marginTop: 18 },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  savedMsg: { fontSize: 13, color: '#059669', fontWeight: 600 },
};
