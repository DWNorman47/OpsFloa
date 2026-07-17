import React, { useState } from 'react';
import { useT } from '../hooks/useT';

/**
 * The rule list editor inside Hours Rules.
 *
 * The policy's other half (rounding, tiers, premiums) is fixed-slot: a closed
 * vocabulary that covers a lot of real rules and nothing it wasn't designed
 * for. This is the open half — a company writes as many small rules as it needs
 * and they compose.
 *
 * The engine (server/utils/hoursRules.js) is the source of truth for what a
 * rule means. This screen only has to produce a rule the engine can read, and
 * to make the result legible before it reaches an invoice — hence the plain
 * English summary on every row. A list of rules that compose is not something
 * you can read off the raw fields.
 */

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Mirrors the engine's RULE_TYPES / RULE_WHEN_KINDS. A value that isn't in the
// engine's list is dropped on parse, so these must stay in step.
const WHEN_KINDS = ['every_day', 'weekdays', 'month_days', 'month_weekdays', 'nth_days', 'months', 'nth_months', 'month_weeks', 'nth_weeks'];

function blankRule() {
  return {
    id: `r${Math.random().toString(36).slice(2, 8)}`,
    type: 'clip_start',
    when: { kind: 'every_day' },
    at: '07:00',
    behavior: 'ignore',
    minutes: '30',
    edge: 'after',
    base: 'schedule',
    mode: 'at',
    from: '17:25',
    everyMin: '30',
    trigger: { kind: 'always', hours: '6' },
  };
}

// ── Plain-English summary ────────────────────────────────────────────────────
// Rules compose, so the list is the rule — no single row tells you what a day
// pays. The summaries are what make a stack of five rows readable at all.

function describeWhen(when, t) {
  const w = when || {};
  const days = (w.days || []).map(Number);
  switch (w.kind) {
    case 'weekdays': {
      if (days.length === 7) return t.hrWhenEveryDay;
      // Contract a run of consecutive days: "Mon–Fri" beats "Mon, Tue, Wed…".
      const sorted = [...days].sort((a, b) => a - b);
      const consecutive = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
      if (consecutive) return `${t[`hrDay_${WEEKDAY_KEYS[sorted[0]]}`]}–${t[`hrDay_${WEEKDAY_KEYS[sorted[sorted.length - 1]]}`]}`;
      return sorted.map(d => t[`hrDay_${WEEKDAY_KEYS[d]}`]).join(', ');
    }
    case 'month_days':
      return `${t.hrWhenMonthDays}: ${days.join(', ')}`;
    case 'month_weekdays':
      return (w.patterns || []).map(p =>
        `${p.week === -1 ? t.hrWeekLast : `#${p.week}`} ${t[`hrDay_${WEEKDAY_KEYS[Number(p.weekday)]}`]}`).join(', ');
    case 'months':
      return `${t.hrWhenMonths}: ${(w.months || []).join(', ')}`;
    case 'nth_days':
      return `${t.hrEvery} ${w.every} ${t.hrDaysFrom} ${w.start}`;
    case 'nth_months':
      return `${t.hrEvery} ${w.every} ${t.hrMonthsFrom} ${w.start}`;
    case 'month_weeks':
      return `${t.hrWhenMonthWeeks}: ${(w.weeks || []).map(x => x === -1 ? t.hrWeekLast : `#${x}`).join(', ')}`;
    case 'nth_weeks':
      return `${t.hrEvery} ${w.every} ${t.hrWeeksFrom} ${w.start}`;
    default:
      return t.hrWhenEveryDay;
  }
}

export function describeRule(r, t) {
  const when = describeWhen(r.when, t);
  const mins = r.minutes;
  switch (r.type) {
    case 'clip_start': {
      const b = r.behavior || 'ignore';
      const key = b === 'prevent' ? 'hrSumStartPrevent' : b === 'auto' ? 'hrSumStartAuto' : 'hrSumStartIgnore';
      return `${when} — ${t[key].replace('{time}', r.at)}`;
    }
    case 'clip_end': {
      const b = r.behavior || 'ignore';
      const key = b === 'auto' ? 'hrSumEndAuto' : 'hrSumEndIgnore';
      return `${when} — ${t[key].replace('{time}', r.at)}`;
    }
    case 'add_time':
    case 'remove_time': {
      const verb = r.type === 'add_time' ? t.hrSumAdd : t.hrSumRemove;
      const where = r.base === 'punch' ? t.hrSumOnPunch : t.hrSumOnBaseline;
      const trigger = r.mode === 'every'
        ? t.hrSumEvery.replace('{n}', r.everyMin).replace('{time}', r.from)
        : (r.edge === 'after' ? t.hrSumAfter : t.hrSumBefore).replace('{time}', r.at);
      return `${when} — ${verb.replace('{n}', mins)} ${trigger} (${where})`;
    }
    case 'auto_break':
      return `${when} — ${t.hrSumBreak.replace('{n}', mins)}${
        r.trigger?.kind === 'after_hours' ? ` ${t.hrSumAfterHours.replace('{n}', r.trigger.hours)}` : ''}`;
    default: return when;
  }
}

// ── Editor ───────────────────────────────────────────────────────────────────

export default function HoursRuleBuilder({ rules, onChange }) {
  const t = useT();
  const [draft, setDraft] = useState(null);

  // The engine refuses a policy where Add/Remove Time has no baseline to
  // measure from, so the option is closed off here rather than letting someone
  // build a rule the save will bounce.
  const hasEnd = rules.some(r => r.type === 'clip_end');
  const hasStart = rules.some(r => r.type === 'clip_start');

  const setD = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const setWhen = (k, v) => setDraft(d => ({ ...d, when: { ...d.when, [k]: v } }));

  // The draft carries every field for every type (so switching type keeps what
  // you typed); only the ones this type actually uses are committed. Stored
  // rules are already in policy shape, so saving is a pass-through and there's
  // no second shape to keep in sync.
  const commit = () => { onChange([...rules, coerceDraft(draft)]); setDraft(null); };
  const remove = (id) => onChange(rules.filter(r => r.id !== id));

  const w = draft?.when || {};
  const adjust = draft?.type === 'add_time' || draft?.type === 'remove_time';
  const needsBaseline = adjust && draft?.base === 'schedule'
    && ((draft.edge === 'after' && !hasEnd) || (draft.edge === 'before' && !hasStart));

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.title}>{t.hrRulesTitle}</span>
        {!draft && <button style={s.addBtn} onClick={() => setDraft(blankRule())}>{t.hrAddRule}</button>}
      </div>
      <p style={s.help}>{t.hrRulesHelp}</p>

      {rules.length === 0 && !draft && <p style={s.empty}>{t.hrNoRules}</p>}

      {rules.length > 0 && (
        <div style={s.list}>
          {rules.map(r => (
            <div key={r.id} style={s.row}>
              <span style={s.rowText}>{describeRule(r, t)}</span>
              <button style={s.delBtn} onClick={() => remove(r.id)} aria-label={t.hrRemoveRule}>×</button>
            </div>
          ))}
        </div>
      )}

      {(!hasStart || !hasEnd) && rules.length > 0 && (
        <p style={s.note}>{t.hrNeedsBaselineNote}</p>
      )}

      {draft && (
        <div style={s.draft}>
          {/* ── When ── */}
          <Field label={t.hrWhen}>
            <select style={s.input} value={w.kind} onChange={e => setDraft(d => ({ ...d, when: { kind: e.target.value } }))}>
              {WHEN_KINDS.map(k => <option key={k} value={k}>{t[`hrWhen_${k}`]}</option>)}
            </select>
          </Field>

          {w.kind === 'weekdays' && (
            <Field label={t.hrSelectDays}>
              <div style={s.chips}>
                {WEEKDAY_KEYS.map((k, i) => {
                  const on = (w.days || []).includes(i);
                  return (
                    <button
                      key={k} type="button"
                      style={{ ...s.chip, ...(on ? s.chipOn : {}) }}
                      onClick={() => setWhen('days', on ? (w.days || []).filter(d => d !== i) : [...(w.days || []), i])}
                    >{t[`hrDay_${k}`]}</button>
                  );
                })}
              </div>
            </Field>
          )}

          {w.kind === 'month_days' && (
            <Field label={t.hrSelectMonthDays}>
              <input style={s.input} placeholder="1, 15" value={(w.days || []).join(', ')}
                onChange={e => setWhen('days', parseNumList(e.target.value, 1, 31))} />
            </Field>
          )}

          {w.kind === 'months' && (
            <Field label={t.hrSelectMonths}>
              <input style={s.input} placeholder="1, 7, 12" value={(w.months || []).join(', ')}
                onChange={e => setWhen('months', parseNumList(e.target.value, 1, 12))} />
            </Field>
          )}

          {w.kind === 'month_weekdays' && (
            <>
              <Field label={t.hrWeekOfMonth}>
                <select style={s.input} value={w.patterns?.[0]?.week ?? 1}
                  onChange={e => setWhen('patterns', [{ week: parseInt(e.target.value, 10), weekday: w.patterns?.[0]?.weekday ?? 1 }])}>
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{`#${n}`}</option>)}
                  {/* "Last" is not a fixed nth — a month has four or five of any weekday. */}
                  <option value={-1}>{t.hrWeekLast}</option>
                </select>
              </Field>
              <Field label={t.hrWeekday}>
                <select style={s.input} value={w.patterns?.[0]?.weekday ?? 1}
                  onChange={e => setWhen('patterns', [{ week: w.patterns?.[0]?.week ?? 1, weekday: parseInt(e.target.value, 10) }])}>
                  {WEEKDAY_KEYS.map((k, i) => <option key={k} value={i}>{t[`hrDay_${k}`]}</option>)}
                </select>
              </Field>
            </>
          )}

          {w.kind === 'month_weeks' && (
            <Field label={t.hrSelectWeeks}>
              <div style={s.chips}>
                {[1, 2, 3, 4, 5].map(n => {
                  const on = (w.weeks || []).includes(n);
                  return (
                    <button key={n} type="button" style={{ ...s.chip, ...(on ? s.chipOn : {}) }}
                      onClick={() => setWhen('weeks', on ? (w.weeks || []).filter(x => x !== n) : [...(w.weeks || []), n])}
                    >{`#${n}`}</button>
                  );
                })}
                {(() => {
                  const on = (w.weeks || []).includes(-1);
                  return (
                    <button type="button" style={{ ...s.chip, ...(on ? s.chipOn : {}) }}
                      onClick={() => setWhen('weeks', on ? (w.weeks || []).filter(x => x !== -1) : [...(w.weeks || []), -1])}
                    >{t.hrWeekLast}</button>
                  );
                })()}
              </div>
            </Field>
          )}

          {(w.kind === 'nth_days' || w.kind === 'nth_months' || w.kind === 'nth_weeks') && (
            <>
              {/* An every-Nth pattern is meaningless without an anchor: "every
                  3rd day" isn't a rule until you say which day was the first.
                  The engine drops the rule outright if this is missing. */}
              <Field label={w.kind === 'nth_months' ? t.hrStartMonth : (w.kind === 'nth_weeks' ? t.hrStartWeek : t.hrStartDay)}>
                <input style={s.input} type={w.kind === 'nth_months' ? 'month' : 'date'}
                  value={w.start || ''} onChange={e => setWhen('start', e.target.value)} />
              </Field>
              <Field label={w.kind === 'nth_months' ? t.hrEveryNMonths : (w.kind === 'nth_weeks' ? t.hrEveryNWeeks : t.hrEveryNDays)}>
                <input style={s.input} type="number" min="1" value={w.every || ''}
                  onChange={e => setWhen('every', parseInt(e.target.value, 10) || '')} />
              </Field>
              {w.kind === 'nth_weeks' && <p style={s.hint}>{t.hrNthWeeksHint}</p>}
            </>
          )}

          {/* ── Type ── */}
          <Field label={t.hrRuleType}>
            <select style={s.input} value={draft.type} onChange={e => setD('type', e.target.value)}>
              <option value="clip_start">{t.hrType_clip_start}</option>
              <option value="clip_end">{t.hrType_clip_end}</option>
              <option value="add_time" disabled={!hasStart && !hasEnd}>{t.hrType_add_time}</option>
              <option value="remove_time" disabled={!hasStart && !hasEnd}>{t.hrType_remove_time}</option>
              <option value="auto_break">{t.hrType_auto_break}</option>
            </select>
          </Field>

          {(draft.type === 'clip_start' || draft.type === 'clip_end') && (
            <>
              <Field label={t.hrTime}>
                <input style={s.input} type="time" value={draft.at} onChange={e => setD('at', e.target.value)} />
              </Field>
              {/* David's original three-way choice. Only "ignore" is built —
                  it's pure pay math. Prevent (block the clock-in) and auto
                  (clock them in/out) live in the live clock, not here, so they
                  are shown but disabled rather than silently dropped: the whole
                  point of the question was "what happened to those options". */}
              <Field label={draft.type === 'clip_start' ? t.hrStartBehavior : t.hrEndBehavior}>
                <select style={s.input} value={draft.behavior} onChange={e => setD('behavior', e.target.value)}>
                  <option value="ignore">
                    {draft.type === 'clip_start' ? t.hrBehaviorIgnoreIn : t.hrBehaviorIgnoreOut}
                  </option>
                  {draft.type === 'clip_start' && <option value="prevent" disabled>{t.hrBehaviorPrevent}</option>}
                  <option value={draft.type === 'clip_start' ? 'auto' : 'auto'} disabled>
                    {draft.type === 'clip_start' ? t.hrBehaviorAutoIn : t.hrBehaviorAutoOut}
                  </option>
                </select>
              </Field>
              <p style={s.hint}>{draft.type === 'clip_start' ? t.hrStartVsWorkday : t.hrEndVsWorkday}</p>
            </>
          )}

          {adjust && (
            <>
              <Field label={t.hrEdge}>
                <select style={s.input} value={draft.edge} onChange={e => setD('edge', e.target.value)}>
                  <option value="after">{t.hrEdgeAfter}</option>
                  <option value="before">{t.hrEdgeBefore}</option>
                </select>
              </Field>
              <Field label={t.hrMode}>
                <select style={s.input} value={draft.mode} onChange={e => setD('mode', e.target.value)}>
                  <option value="at">{t.hrModeAt}</option>
                  <option value="every">{t.hrModeEvery}</option>
                </select>
              </Field>
              {draft.mode === 'at' ? (
                <Field label={t.hrThreshold}>
                  <input style={s.input} type="time" value={draft.at} onChange={e => setD('at', e.target.value)} />
                </Field>
              ) : (
                <>
                  <Field label={t.hrFromTime}>
                    <input style={s.input} type="time" value={draft.from} onChange={e => setD('from', e.target.value)} />
                  </Field>
                  <Field label={t.hrEveryMin}>
                    <input style={s.input} type="number" min="1" value={draft.everyMin} onChange={e => setD('everyMin', e.target.value)} />
                  </Field>
                </>
              )}
              <Field label={draft.type === 'add_time' ? t.hrMinutesAdd : t.hrMinutesRemove}>
                <input style={s.input} type="number" min="1" value={draft.minutes} onChange={e => setD('minutes', e.target.value)} />
              </Field>
              <Field label={t.hrBase}>
                <select style={s.input} value={draft.base} onChange={e => setD('base', e.target.value)}>
                  <option value="schedule">{t.hrBaseSchedule}</option>
                  <option value="punch">{t.hrBasePunch}</option>
                </select>
              </Field>
              <p style={s.hint}>{draft.base === 'schedule' ? t.hrBaseScheduleHint : t.hrBasePunchHint}</p>
              {needsBaseline && <p style={s.err}>{t.hrNeedsBaseline}</p>}
            </>
          )}

          {draft.type === 'auto_break' && (
            <>
              <Field label={t.hrBreakMinutes}>
                <input style={s.input} type="number" min="1" value={draft.minutes} onChange={e => setD('minutes', e.target.value)} />
              </Field>
              <Field label={t.hrBreakTrigger}>
                <select style={s.input} value={draft.trigger.kind}
                  onChange={e => setDraft(d => ({ ...d, trigger: { ...d.trigger, kind: e.target.value } }))}>
                  <option value="always">{t.hrBreakAlways}</option>
                  <option value="after_hours">{t.hrBreakAfterHours}</option>
                </select>
              </Field>
              {draft.trigger.kind === 'after_hours' && (
                <Field label={t.hrBreakHours}>
                  <input style={s.input} type="number" min="1" step="0.5" value={draft.trigger.hours}
                    onChange={e => setDraft(d => ({ ...d, trigger: { ...d.trigger, hours: e.target.value } }))} />
                </Field>
              )}
              <p style={s.hint}>{t.hrBreakHint}</p>
            </>
          )}

          <div style={s.preview}>{describeRule(draft, t)}</div>

          <div style={s.actions}>
            <button style={s.saveBtn} onClick={commit} disabled={needsBaseline}>{t.hrAddThisRule}</button>
            <button style={s.cancelBtn} onClick={() => setDraft(null)}>{t.hrCancel}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Draft (all fields, strings from inputs) → the policy rule the engine reads.
function coerceDraft(d) {
  const out = { id: d.id, type: d.type, when: d.when };
  const mins = parseInt(d.minutes, 10) || 0;
  switch (d.type) {
    case 'clip_start':
    case 'clip_end':
      out.at = d.at;
      out.behavior = d.behavior || 'ignore';
      break;
    case 'add_time':
    case 'remove_time':
      out.edge = d.edge;
      out.base = d.base;
      out.mode = d.mode;
      out.minutes = mins;
      if (d.mode === 'every') { out.from = d.from; out.everyMin = parseInt(d.everyMin, 10) || 0; }
      else out.at = d.at;
      break;
    case 'auto_break':
      out.minutes = mins;
      out.trigger = d.trigger?.kind === 'after_hours'
        ? { kind: 'after_hours', hours: parseFloat(d.trigger.hours) || 0 }
        : { kind: 'always' };
      break;
    default:
      break;
  }
  return out;
}

// "1, 15" → [1, 15], silently dropping anything out of range rather than
// storing a value the engine would drop the whole rule over.
function parseNumList(str, lo, hi) {
  return [...new Set(String(str).split(/[,\s]+/)
    .map(x => parseInt(x, 10))
    .filter(n => Number.isInteger(n) && n >= lo && n <= hi))];
}

function Field({ label, children }) {
  return (
    <label style={s.field}>
      <span style={s.label}>{label}</span>
      {children}
    </label>
  );
}

const s = {
  wrap: { marginTop: 20, paddingTop: 18, borderTop: '1px solid #eef0f2' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 15, fontWeight: 700, color: '#111827' },
  help: { fontSize: 12.5, color: '#6b7280', margin: '6px 0 12px', lineHeight: 1.5 },
  empty: { fontSize: 13, color: '#9ca3af', fontStyle: 'italic', margin: '8px 0' },
  list: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f9fafb', border: '1px solid #eef0f2', borderRadius: 7 },
  rowText: { flex: 1, fontSize: 13, color: '#374151' },
  delBtn: { background: 'none', border: 'none', color: '#9ca3af', fontSize: 18, lineHeight: 1, cursor: 'pointer', padding: '0 4px', flexShrink: 0 },
  note: { fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 9px', margin: '0 0 12px' },
  draft: { display: 'flex', flexDirection: 'column', gap: 10, padding: 14, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 9 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  input: { padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  chip: { padding: '5px 11px', border: '1px solid #d1d5db', background: '#fff', borderRadius: 999, fontSize: 12, cursor: 'pointer', color: '#6b7280' },
  chipOn: { background: 'var(--ops-page-accent, #059669)', borderColor: 'transparent', color: '#fff', fontWeight: 600 },
  hint: { fontSize: 11.5, color: '#6b7280', margin: 0, lineHeight: 1.45 },
  err: { fontSize: 12, color: '#b91c1c', margin: 0, fontWeight: 600 },
  preview: { fontSize: 12.5, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6, padding: '7px 10px' },
  actions: { display: 'flex', gap: 8, marginTop: 2 },
  addBtn: { background: 'var(--ops-page-accent, #059669)', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' },
  saveBtn: { background: 'var(--ops-page-accent, #059669)', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #d1d5db', color: '#6b7280', padding: '7px 16px', borderRadius: 7, fontSize: 13, cursor: 'pointer' },
};
