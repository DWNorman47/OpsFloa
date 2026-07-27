// Turn the pay engine's `explain` items (from GET /admin/workers/:id/entries?explain=1)
// into human lines + a link to where the rule/setting lives. Rule ids resolve
// against the company's raw hours_rules policy the report already holds. Pure —
// no state, no network. See server/utils/hoursRules.js (the trace producer).

import { describeRule } from '../components/HoursRuleBuilder';

// Where each source is configured. Deep-highlight isn't attempted (by design);
// these open the right screen. Administration ▸ Workspace hosts both Company
// Standards and Hours & Rules; a member's pay settings live on the Team page.
export const SETTINGS_LINKS = {
  hours_rules: '/administration#workspace',
  company_standards: '/administration#workspace',
  employee: '/team',
};

function minToHHMM(min) {
  const m = (((Number(min) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
const hhmm = (s) => (typeof s === 'string' ? s.slice(0, 5) : s);

// Find a rule by id anywhere in the policy — standard list or any role section.
export function findRuleById(hoursRules, id) {
  if (!id || !hoursRules) return null;
  let p;
  try { p = typeof hoursRules === 'string' ? JSON.parse(hoursRules) : hoursRules; } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  const inList = (arr) => (Array.isArray(arr) ? arr.find(r => r && r.id === id) : null);
  return inList(p.rules) || (Array.isArray(p.roleRules) ? p.roleRules.map(rr => inList(rr && rr.rules)).find(Boolean) : null) || null;
}

// One explain item → { text, link } (or null to skip). `policyRaw` is the raw
// hours_rules value; `t` is the i18n bag.
export function renderTraceItem(item, { t, policyRaw }) {
  if (!item || !item.code) return null;
  const ruleText = (id) => { const r = findRuleById(policyRaw, id); return r ? describeRule(r, t) : null; };
  const rulesText = (ids) => (ids || []).map(ruleText).filter(Boolean).join('; ');
  const withRule = (base, extra) => (extra ? `${base} — ${extra}` : base);

  switch (item.code) {
    case 'rounding_in':
    case 'rounding_out': {
      const which = item.code === 'rounding_in' ? t.trClockIn : t.trClockOut;
      const base = t.trRounding.replace('{which}', which).replace('{from}', hhmm(item.fromTime)).replace('{to}', hhmm(item.toTime));
      const via = item.ruleId ? ruleText(item.ruleId) : t.trRoundingGlobal;
      return { text: withRule(base, via), link: SETTINGS_LINKS.hours_rules };
    }
    case 'clip_start':
    case 'clip_end': {
      const which = item.code === 'clip_start' ? t.trClockIn : t.trClockOut;
      const base = t.trClip.replace('{which}', which).replace('{to}', minToHHMM(item.toMin));
      return { text: withRule(base, rulesText(item.ruleIds)), link: SETTINGS_LINKS.hours_rules };
    }
    case 'add_time':
    case 'remove_time': {
      const sign = item.deltaMin > 0 ? '+' : '−';
      const base = t.trAdjust.replace('{sign}', sign).replace('{n}', Math.abs(item.deltaMin));
      return { text: withRule(base, rulesText(item.ruleIds)), link: SETTINGS_LINKS.hours_rules };
    }
    case 'auto_break': {
      const base = t.trBreak.replace('{n}', item.addedMin).replace('{total}', item.breakMin);
      return { text: withRule(base, rulesText(item.ruleIds)), link: SETTINGS_LINKS.hours_rules };
    }
    case 'overtime': {
      // Explain WHY the overtime applies, not a blanket "over Nh daily".
      const n = item.otHours;
      let text, link = SETTINGS_LINKS.hours_rules;
      switch (item.reason) {
        case 'override':    text = t.trOvertimeOverride.replace('{n}', n); link = null; break; // per-entry, not a rule
        case 'rest_day':    text = t.trOvertimeRestDay.replace('{n}', n); break;
        case 'seventh_day': text = t.trOvertimeSeventh.replace('{n}', n); break;
        case 'window':      text = t.trOvertimeWindow.replace('{n}', n); break;
        case 'total':       text = t.trOvertimeTotal.replace('{n}', n); link = null; break; // aggregate rollup
        default:            text = t.trOvertime.replace('{n}', n).replace('{th}', item.threshold)
          .replace('{rule}', item.rule === 'weekly' ? t.trWeekly : t.trDaily);
      }
      return { text, link };
    }
    case 'wage_type':
      return { text: t.trPrevailing, link: SETTINGS_LINKS.company_standards };
    default:
      return null;
  }
}

// The per-day sick/vacation breakdown (leave_detail) → one line each.
export function renderLeaveDetail(d, { t, policyRaw }) {
  if (!d) return null;
  const src = {
    schedule: t.trLeaveSchedule,
    rule: d.ruleId ? (findRuleById(policyRaw, d.ruleId) ? describeRule(findRuleById(policyRaw, d.ruleId), t) : t.trLeaveRule) : t.trLeaveRule,
    default: t.trLeaveDefault,
    partial: t.trLeavePartial,
  }[d.source] || d.source;
  return { text: `${d.date} · ${d.hours}h — ${src}`, link: d.source === 'default' || d.source === 'schedule' ? SETTINGS_LINKS.company_standards : SETTINGS_LINKS.hours_rules };
}
