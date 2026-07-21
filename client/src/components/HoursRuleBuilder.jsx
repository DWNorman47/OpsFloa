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

// Indexed by the engine's weekday number (JS getDay: Sunday=0). This stays in
// this order — the index IS the stored day value, so reordering it would
// silently remap every rule.
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Display order only: Monday first, Sunday last. Buttons/options and the summary
// iterate this; the values they carry are still the WEEKDAY_KEYS index.
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const dayRank = d => WEEKDAY_DISPLAY_ORDER.indexOf(d);

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
    anchor: 'clock',
    stack: false,
    from: '17:25',
    to: '19:00',       // window_mult end time (from doubles as its start)
    everyMin: '30',
    offsetMin: '25',
    trigger: { kind: 'always', hours: '6' },
    // round-rule fields
    roundEdge: 'both',
    reference: 'schedule',
    direction: 'nearest',
    intervalMin: '15',
    graceMin: '0',
    // ot_tier fields
    basis: 'day',
    afterHours: '8',
    mult: '1.5',
    // premium fields (rest_day reuses mult; others below)
    minHours: '4',
    firstHours: '8',
    firstMult: '1.5',
    afterMult: '2',
    fromHour: '22',
    toHour: '5',
    pct: '10',
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
      // Sort and contract in DISPLAY order (Mon→Sun), so "Mon–Fri" beats
      // "Mon, Tue, Wed…" and Sat+Sun reads "Sat, Sun".
      const sorted = [...days].sort((a, b) => dayRank(a) - dayRank(b));
      const consecutive = sorted.length > 2 && sorted.every((d, i) => i === 0 || dayRank(d) === dayRank(sorted[i - 1]) + 1);
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
      const where = (r.base === 'punch' ? t.hrSumOnPunch : t.hrSumOnBaseline)
        + (r.stack ? `, ${t.hrSumStacks}` : '');
      let trigger;
      if (r.anchor === 'schedule') {
        const rel = r.edge === 'after' ? t.hrSumPast : t.hrSumBeforeRel;
        const anchorTxt = r.edge === 'after' ? t.hrSumSchedEnd : t.hrSumSchedStart;
        trigger = (r.mode === 'every' ? t.hrSumEverySched : t.hrSumAtSched)
          .replace('{n}', r.everyMin).replace('{m}', r.offsetMin)
          .replace('{rel}', rel).replace('{anchor}', anchorTxt);
      } else {
        trigger = r.mode === 'every'
          ? t.hrSumEvery.replace('{n}', r.everyMin).replace('{time}', r.from)
          : (r.edge === 'after' ? t.hrSumAfter : t.hrSumBefore).replace('{time}', r.at);
      }
      return `${when} — ${verb.replace('{n}', mins)} ${trigger} (${where})`;
    }
    case 'auto_break':
      return `${when} — ${t.hrSumBreak.replace('{n}', mins)}${
        r.trigger?.kind === 'after_hours' ? ` ${t.hrSumAfterHours.replace('{n}', r.trigger.hours)}` : ''}`;
    case 'round': {
      const edge = r.edge === 'in' ? t.hrRoundInShort : r.edge === 'out' ? t.hrRoundOutShort : t.hrRoundBothShort;
      if (r.direction === 'off') return `${when} — ${t.hrSumRoundOff.replace('{edge}', edge)}`;
      const dir = r.direction === 'toward_worker' ? t.hrDirTowardShort
        : r.direction === 'against_worker' ? t.hrDirAgainstShort : t.hrDirNearestShort;
      const ref = r.reference === 'clock' ? t.hrRefClockShort : t.hrRefScheduleShort;
      const grace = (r.direction !== 'nearest' && Number(r.graceMin) > 0) ? `, ${r.graceMin} ${t.hrGraceShort}` : '';
      return `${when} — ${t.hrSumRound.replace('{edge}', edge).replace('{n}', r.intervalMin).replace('{dir}', dir).replace('{ref}', ref).replace('{grace}', grace)}`;
    }
    case 'ot_tier': {
      const per = r.basis === 'week' ? t.hrOtPerWeekShort : t.hrOtPerDayShort;
      return `${when} — ${t.hrSumOtTier.replace('{n}', r.afterHours).replace('{per}', per).replace('{mult}', r.mult)}`;
    }
    case 'rest_day': return `${when} — ${t.hrSumRestDay.replace('{mult}', r.mult)}`;
    case 'min_daily': return `${when} — ${t.hrSumMinDaily.replace('{n}', r.hours)}`;
    case 'seventh_day': return `${when} — ${t.hrSumSeventh.replace('{a}', r.firstMult).replace('{b}', r.afterMult)}`;
    case 'night_diff': return `${when} — ${t.hrSumNight.replace('{pct}', r.pct).replace('{from}', r.fromHour).replace('{to}', r.toHour)}`;
    case 'window_mult': {
      const wraps = r.to <= r.from ? ` ${t.hrWindowNextDay}` : '';
      return `${when} — ${t.hrSumWindow.replace('{from}', r.from).replace('{to}', r.to).replace('{mult}', r.mult)}${wraps}`;
    }
    default: return when;
  }
}

// ── Editor ───────────────────────────────────────────────────────────────────

export default function HoursRuleBuilder({ rules, onChange, title, help }) {
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
  // Commit replaces the rule in place when its id already exists (editing) and
  // appends otherwise (adding a new one) — same button, both flows.
  const commit = () => {
    const rule = coerceDraft(draft);
    onChange(rules.some(r => r.id === rule.id) ? rules.map(r => (r.id === rule.id ? rule : r)) : [...rules, rule]);
    setDraft(null);
  };
  const remove = (id) => onChange(rules.filter(r => r.id !== id));
  // Load an existing rule into the draft. A stored rule only carries the fields
  // its type uses, so merge it onto a blank draft to fill the rest (keeping its
  // id so commit replaces it, not appends a copy).
  const edit = (rule) => setDraft({
    ...blankRule(),
    ...rule,
    when: { ...(rule.when || { kind: 'every_day' }) },
    trigger: { ...blankRule().trigger, ...(rule.trigger || {}) },
  });
  const editing = !!draft && rules.some(r => r.id === draft.id);

  const w = draft?.when || {};
  const adjust = draft?.type === 'add_time' || draft?.type === 'remove_time';
  // Schedule-based, but no Start/End Time rule to measure from → the credit falls
  // back to the worker's scheduled hours. Informational now, never a blocker.
  const usesSchedule = adjust && draft?.base === 'schedule'
    && ((draft.edge === 'after' && !hasEnd) || (draft.edge === 'before' && !hasStart));
  // Any SAVED adjust rule that will lean on that fallback (drives the FYI banner).
  const scheduleFallbackInUse = rules.some(r =>
    (r.type === 'add_time' || r.type === 'remove_time') && r.base === 'schedule'
    && ((r.edge === 'after' && !hasEnd) || (r.edge === 'before' && !hasStart)));

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.title}>{title || t.hrRulesTitle}</span>
        {!draft && <button style={s.addBtn} onClick={() => setDraft(blankRule())}>{t.hrAddRule}</button>}
      </div>
      <p style={s.help}>{help || t.hrRulesHelp}</p>

      {rules.length === 0 && !draft && <p style={s.empty}>{t.hrNoRules}</p>}

      {rules.length > 0 && (
        <div style={s.list}>
          {rules.map(r => (
            <div key={r.id} style={s.row}>
              <span style={s.rowText}>{describeRule(r, t)}</span>
              {!draft && <button style={s.editBtn} onClick={() => edit(r)}>{t.hrEdit}</button>}
              {!draft && <button style={s.delBtn} onClick={() => remove(r.id)} aria-label={t.hrRemoveRule}>×</button>}
            </div>
          ))}
        </div>
      )}

      {scheduleFallbackInUse && (
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
                {WEEKDAY_DISPLAY_ORDER.map(i => {
                  const k = WEEKDAY_KEYS[i];
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
                  {WEEKDAY_DISPLAY_ORDER.map(i => <option key={WEEKDAY_KEYS[i]} value={i}>{t[`hrDay_${WEEKDAY_KEYS[i]}`]}</option>)}
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
              <option value="add_time">{t.hrType_add_time}</option>
              <option value="remove_time">{t.hrType_remove_time}</option>
              <option value="auto_break">{t.hrType_auto_break}</option>
              <option value="round">{t.hrType_round}</option>
              <option value="ot_tier">{t.hrType_ot_tier}</option>
              <option value="rest_day">{t.hrType_rest_day}</option>
              <option value="min_daily">{t.hrType_min_daily}</option>
              <option value="seventh_day">{t.hrType_seventh_day}</option>
              <option value="night_diff">{t.hrType_night_diff}</option>
              <option value="window_mult">{t.hrType_window_mult}</option>
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
              {/* The trigger anchor: a set clock time, or an offset off each
                  worker's own scheduled end/start (so it adapts to any shift). */}
              <Field label={t.hrAnchor}>
                <select style={s.input} value={draft.anchor} onChange={e => setD('anchor', e.target.value)}>
                  <option value="clock">{t.hrAnchorClock}</option>
                  <option value="schedule">{draft.edge === 'after' ? t.hrAnchorSchedEnd : t.hrAnchorSchedStart}</option>
                </select>
              </Field>
              {draft.anchor === 'schedule' ? (
                <>
                  <Field label={draft.edge === 'after' ? t.hrOffsetAfter : t.hrOffsetBefore}>
                    <input style={s.input} type="number" min="0" value={draft.offsetMin} onChange={e => setD('offsetMin', e.target.value)} />
                  </Field>
                  {draft.mode === 'every' && (
                    <Field label={t.hrEveryMin}>
                      <input style={s.input} type="number" min="1" value={draft.everyMin} onChange={e => setD('everyMin', e.target.value)} />
                    </Field>
                  )}
                  <p style={s.hint}>{t.hrAnchorSchedHint}</p>
                </>
              ) : draft.mode === 'at' ? (
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
              <Field label={draft.type === 'remove_time' ? t.hrBaseRemove : t.hrBase}>
                <select style={s.input} value={draft.base} onChange={e => setD('base', e.target.value)}>
                  <option value="schedule">{t.hrBaseSchedule}</option>
                  <option value="punch">{t.hrBasePunch}</option>
                </select>
              </Field>
              <p style={s.hint}>{draft.base === 'schedule' ? t.hrBaseScheduleHint : t.hrBasePunchHint}</p>
              {/* Only 'at' rules combine into a stack; how they combine when more
                  than one fires — biggest wins vs. add on top — is asked here. */}
              {draft.mode === 'at' && (
                <>
                  <Field label={t.hrStack}>
                    <select style={s.input} value={draft.stack ? 'add' : 'replace'} onChange={e => setD('stack', e.target.value === 'add')}>
                      <option value="replace">{t.hrStackReplace}</option>
                      <option value="add">{t.hrStackAdd}</option>
                    </select>
                  </Field>
                  <p style={s.hint}>{t.hrStackHint}</p>
                </>
              )}
              {usesSchedule && <p style={s.hint}>{t.hrNeedsBaseline}</p>}
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

          {draft.type === 'round' && (
            <>
              <Field label={t.hrRoundEdge}>
                <select style={s.input} value={draft.roundEdge} onChange={e => setD('roundEdge', e.target.value)}>
                  <option value="both">{t.hrRoundBoth}</option>
                  <option value="in">{t.hrRoundIn}</option>
                  <option value="out">{t.hrRoundOut}</option>
                </select>
              </Field>
              <Field label={t.hrDirection}>
                <select style={s.input} value={draft.direction} onChange={e => setD('direction', e.target.value)}>
                  <option value="nearest">{t.hrDirNearest}</option>
                  <option value="toward_worker">{t.hrDirToward}</option>
                  <option value="against_worker">{t.hrDirAgainst}</option>
                  <option value="off">{t.hrDirOff}</option>
                </select>
              </Field>
              {draft.direction !== 'off' && (
                <Field label={t.hrInterval}>
                  <input style={s.input} type="number" min="1" value={draft.intervalMin} onChange={e => setD('intervalMin', e.target.value)} />
                </Field>
              )}
              {(draft.direction === 'toward_worker' || draft.direction === 'against_worker') && (
                <Field label={t.hrGrace}>
                  <input style={s.input} type="number" min="0" value={draft.graceMin} onChange={e => setD('graceMin', e.target.value)} />
                </Field>
              )}
              {draft.direction !== 'off' && (
                <Field label={t.hrReference}>
                  <select style={s.input} value={draft.reference} onChange={e => setD('reference', e.target.value)}>
                    <option value="schedule">{t.hrRefSchedule}</option>
                    <option value="clock">{t.hrRefClock}</option>
                  </select>
                </Field>
              )}
              <p style={s.hint}>{draft.direction === 'off' ? t.hrRoundOffHint : t.hrRoundHint}</p>
            </>
          )}

          {draft.type === 'ot_tier' && (
            <>
              <Field label={t.hrOtBasis}>
                <select style={s.input} value={draft.basis} onChange={e => setD('basis', e.target.value)}>
                  <option value="day">{t.hrOtPerDayBasis}</option>
                  <option value="week">{t.hrOtPerWeekBasis}</option>
                </select>
              </Field>
              <Field label={t.hrOtAfterHours}>
                <input style={s.input} type="number" min="0" step="0.5" value={draft.afterHours} onChange={e => setD('afterHours', e.target.value)} />
              </Field>
              <Field label={t.hrOtMult}>
                <input style={s.input} type="number" min="1" step="0.05" value={draft.mult} onChange={e => setD('mult', e.target.value)} />
              </Field>
              <p style={s.hint}>{t.hrOtTierHint}</p>
            </>
          )}

          {draft.type === 'rest_day' && (
            <>
              <Field label={t.hrRestDayMult}>
                <input style={s.input} type="number" min="1" step="0.05" value={draft.mult} onChange={e => setD('mult', e.target.value)} />
              </Field>
              <p style={s.hint}>{t.hrRestRuleHint}</p>
            </>
          )}

          {draft.type === 'min_daily' && (
            <>
              <Field label={t.hrMinDaily}>
                <input style={s.input} type="number" min="0.5" step="0.5" value={draft.minHours} onChange={e => setD('minHours', e.target.value)} />
              </Field>
              <p style={s.hint}>{t.hrMinRuleHint}</p>
            </>
          )}

          {draft.type === 'seventh_day' && (
            <>
              <Field label={t.hrSdFirst}>
                <input style={s.input} type="number" min="0" step="0.5" value={draft.firstHours} onChange={e => setD('firstHours', e.target.value)} />
              </Field>
              <Field label={t.hrSdFirstMult}>
                <input style={s.input} type="number" min="1" step="0.05" value={draft.firstMult} onChange={e => setD('firstMult', e.target.value)} />
              </Field>
              <Field label={t.hrSdAfterMult}>
                <input style={s.input} type="number" min="1" step="0.05" value={draft.afterMult} onChange={e => setD('afterMult', e.target.value)} />
              </Field>
              <p style={s.hint}>{t.hrSeventhDayHint}</p>
            </>
          )}

          {draft.type === 'night_diff' && (
            <>
              <Field label={t.hrNightFrom}>
                <input style={s.input} type="number" min="0" max="24" value={draft.fromHour} onChange={e => setD('fromHour', e.target.value)} />
              </Field>
              <Field label={t.hrNightTo}>
                <input style={s.input} type="number" min="0" max="24" value={draft.toHour} onChange={e => setD('toHour', e.target.value)} />
              </Field>
              <Field label={t.hrNightPct}>
                <input style={s.input} type="number" min="1" step="1" value={draft.pct} onChange={e => setD('pct', e.target.value)} />
              </Field>
              <p style={s.hint}>{t.hrNightDiffHint}</p>
            </>
          )}

          {draft.type === 'window_mult' && (
            <>
              <Field label={t.hrWindowFrom}>
                <input style={s.input} type="time" value={draft.from} onChange={e => setD('from', e.target.value)} />
              </Field>
              <Field label={t.hrWindowTo}>
                <input style={s.input} type="time" value={draft.to} onChange={e => setD('to', e.target.value)} />
              </Field>
              <Field label={t.hrWindowMult}>
                <input style={s.input} type="number" min="1" step="0.05" value={draft.mult} onChange={e => setD('mult', e.target.value)} />
              </Field>
              <p style={s.hint}>{t.hrWindowHint}</p>
              {/* End ≤ start means the window wraps past midnight — surface it so
                  it's never a surprise. Zero-padded HH:MM compares lexically. */}
              {draft.from && draft.to && draft.to <= draft.from && (
                <p style={s.note}>{t.hrWindowWrapWarn.replace('{to}', draft.to)}</p>
              )}
            </>
          )}

          <div style={s.preview}>{describeRule(draft, t)}</div>

          <div style={s.actions}>
            <button style={s.saveBtn} onClick={commit}>{editing ? t.hrSaveRule : t.hrAddThisRule}</button>
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
      out.anchor = d.anchor;
      out.minutes = mins;
      if (d.anchor === 'schedule') {
        out.offsetMin = parseInt(d.offsetMin, 10) || 0;
        if (d.mode === 'every') out.everyMin = parseInt(d.everyMin, 10) || 0;
      } else if (d.mode === 'every') {
        out.from = d.from; out.everyMin = parseInt(d.everyMin, 10) || 0;
      } else {
        out.at = d.at;
      }
      // Stacking is only offered for (and only means anything for) 'at' rules.
      if (d.mode === 'at' && d.stack) out.stack = true;
      break;
    case 'auto_break':
      out.minutes = mins;
      out.trigger = d.trigger?.kind === 'after_hours'
        ? { kind: 'after_hours', hours: parseFloat(d.trigger.hours) || 0 }
        : { kind: 'always' };
      break;
    case 'round':
      out.edge = d.roundEdge;                       // 'in' | 'out' | 'both'
      out.direction = d.direction;                  // nearest | toward_worker | against_worker | off
      out.reference = d.reference;                  // schedule | clock
      out.intervalMin = parseInt(d.intervalMin, 10) || 15;
      out.graceMin = parseInt(d.graceMin, 10) || 0;
      break;
    case 'ot_tier':
      out.basis = d.basis;                          // 'day' | 'week'
      out.afterHours = parseFloat(d.afterHours) || 0;
      out.mult = parseFloat(d.mult) || 1.5;
      break;
    case 'rest_day':
      out.mult = parseFloat(d.mult) || 1.5;
      break;
    case 'min_daily':
      out.hours = parseFloat(d.minHours) || 0;
      break;
    case 'seventh_day':
      out.firstHours = parseFloat(d.firstHours) || 0;
      out.firstMult = parseFloat(d.firstMult) || 1.5;
      out.afterMult = parseFloat(d.afterMult) || 2;
      break;
    case 'night_diff':
      out.fromHour = parseFloat(d.fromHour) || 0;
      out.toHour = parseFloat(d.toHour) || 0;
      out.pct = parseFloat(d.pct) || 0;
      break;
    case 'window_mult':
      out.from = d.from;                            // 'HH:MM' — window start (day-of-week from `when`)
      out.to = d.to;                                // 'HH:MM' — end; ≤ start means it wraps past midnight
      out.mult = parseFloat(d.mult) || 1.5;
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
  editBtn: { background: 'none', border: '1px solid #d1d5db', color: '#374151', fontSize: 12, fontWeight: 600, lineHeight: 1, cursor: 'pointer', padding: '4px 10px', borderRadius: 6, flexShrink: 0 },
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
