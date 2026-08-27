/**
 * Individual (per-employee) Hours & Pay Rules — `userRules`.
 *
 * The policy grows one additive key, `userRules`: per-EMPLOYEE (users.id) rule sets
 * layered ON TOP of the resolved role/standard rules. `add` mode appends (and can
 * NULLIFY inherited rules by id via `disabledRuleIds`); `replace` mode ignores role +
 * standard entirely. A worker with no matching section — or a null userId — falls back
 * to exactly the role/standard behaviour, so a company that never touches the feature is
 * byte-for-byte unchanged. Precedence: individual > role > standard.
 *
 * These pin the effective-list math, that it flows through both the rounding engine and
 * the OT config, and that it is a strict no-op when `userRules` is absent / no userId.
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const {
  parsePolicy,
  parseUserRules,
  effectiveRulesForWorker,
  roundEntriesForPay,
  otConfigFromSettings,
  otConfigByRoleFactory,
} = require('../utils/hoursRules');
const { computePaid } = require('../utils/paidHours');

const CLIP = { id: 'clip', type: 'clip_start', when: { kind: 'every_day' }, at: '07:00' };       // std: clip to 07:00
const CLIP8 = { id: 'clip-u', type: 'clip_start', when: { kind: 'every_day' }, at: '08:00' };     // changed clone
const LUNCH = { id: 'lunch', type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } };
const ROLE_LUNCH = { ...LUNCH, id: 'role-lunch' };
const OT2 = { id: 't2', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 8, mult: 2 };

const pol = (userRules, rules = [CLIP], roleRules) =>
  parsePolicy(JSON.stringify({ enabled: true, rules, roleRules, userRules }));

describe('parseUserRules — validation & normalization', () => {
  test('normalizes userIds, defaults mode to add, keeps disabledRuleIds, drops junk', () => {
    const p = parsePolicy(JSON.stringify({
      enabled: true,
      userRules: [
        { userId: 5, rules: [] },                                        // legacy single → [5], default add
        { userIds: [7, 7, 'x'], mode: 'replace', rules: [LUNCH] },       // de-dupe, drop non-int, replace
        { userIds: [9], disabledRuleIds: ['clip', 3, ''], rules: [] },   // keep only string ids
        { userIds: [], rules: [] },                                      // no id → dropped
        { rules: [] },                                                   // no id → dropped
        null, 'nope',                                                    // dropped
      ],
    }));
    expect(p.userRules.map(u => u.userIds)).toEqual([[5], [7], [9]]);
    expect(p.userRules[0].mode).toBe('add');
    expect(p.userRules[1].mode).toBe('replace');
    expect(p.userRules[1].rules.map(r => r.id)).toEqual(['lunch']);
    expect(p.userRules[2].disabledRuleIds).toEqual(['clip']);
  });

  test('parseUserRules([]) and non-arrays → []', () => {
    expect(parseUserRules(undefined)).toEqual([]);
    expect(parseUserRules('x')).toEqual([]);
    expect(parseUserRules([])).toEqual([]);
  });
});

describe('effectiveRulesForWorker — precedence individual > role > standard', () => {
  test('no userId or no matching section → inherited unchanged (default path)', () => {
    const p = pol([{ userIds: [5], rules: [LUNCH] }]);
    expect(effectiveRulesForWorker(p, null, null).map(r => r.id)).toEqual(['clip']); // no userId
    expect(effectiveRulesForWorker(p, null, 99).map(r => r.id)).toEqual(['clip']);   // no section for 99
    expect(effectiveRulesForWorker(p, null, 5).map(r => r.id)).toEqual(['clip', 'lunch']); // add
  });

  test('nullify: disabledRuleIds removes an inherited rule', () => {
    const p = pol([{ userIds: [5], disabledRuleIds: ['clip'], rules: [] }]);
    expect(effectiveRulesForWorker(p, null, 5)).toEqual([]);        // clip nullified for person 5
    expect(effectiveRulesForWorker(p, null, 6).map(r => r.id)).toEqual(['clip']); // others keep it
  });

  test('change: tombstone the inherited rule + add an edited clone → clone wins', () => {
    const p = pol([{ userIds: [5], disabledRuleIds: ['clip'], rules: [CLIP8] }]);
    expect(effectiveRulesForWorker(p, null, 5).map(r => r.id)).toEqual(['clip-u']);
  });

  test('replace mode: only the section rules (role + standard ignored)', () => {
    const p = pol([{ userIds: [5], mode: 'replace', rules: [LUNCH] }]);
    expect(effectiveRulesForWorker(p, null, 5).map(r => r.id)).toEqual(['lunch']);
  });

  test('layers over role rules, and can nullify an inherited ROLE rule', () => {
    const p = pol(
      [{ userIds: [5], disabledRuleIds: ['role-lunch', 'clip'], rules: [OT2] }],
      [CLIP],
      [{ roleIds: [10], addToStandard: true, rules: [ROLE_LUNCH] }],
    );
    // worker in role 10: inherited = clip + role-lunch
    expect(effectiveRulesForWorker(p, 10, 99).map(r => r.id)).toEqual(['clip', 'role-lunch']);
    // person 5 in role 10: nullify both inherited, add OT2
    expect(effectiveRulesForWorker(p, 10, 5).map(r => r.id)).toEqual(['t2']);
  });
});

describe('roundEntriesForPay — per-employee override flows through', () => {
  const entries = () => [
    { user_id: 5, work_date: '2026-07-06', start_time: '06:00:00', end_time: '15:00:00', break_minutes: 0 },
    { user_id: 6, work_date: '2026-07-06', start_time: '06:00:00', end_time: '15:00:00', break_minutes: 0 },
  ];

  test('add rule for one person; another person untouched', () => {
    const p = pol([{ userIds: [5], rules: [LUNCH] }]); // person 5 also gets a 60-min lunch
    const paid = roundEntriesForPay(entries(), p, { workerRoleById: {} });
    expect(paid[0].start_time).toBe('07:00:00'); // standard clip applies to both
    expect(paid[0].break_minutes).toBe(60);      // person 5: added lunch
    expect(paid[1].break_minutes).toBe(0);       // person 6: none
  });

  test('change: person 5 clips to 08:00 (tombstone std + clone), person 6 stays 07:00', () => {
    const p = pol([{ userIds: [5], disabledRuleIds: ['clip'], rules: [CLIP8] }]);
    const paid = roundEntriesForPay(entries(), p, { workerRoleById: {} });
    expect(paid[0].start_time).toBe('08:00:00'); // person 5: changed clip
    expect(paid[1].start_time).toBe('07:00:00'); // person 6: standard clip
  });

  test('nullify: person 5 gets no clip (empty standard), person 6 keeps it', () => {
    const p = pol([{ userIds: [5], disabledRuleIds: ['clip'], rules: [] }]);
    const paid = roundEntriesForPay(entries(), p, { workerRoleById: {} });
    expect(paid[0].start_time).toBe('06:00:00'); // person 5: clip nullified → untouched
    expect(paid[1].start_time).toBe('07:00:00'); // person 6: standard clip
  });

  test('processes even with an empty standard list + no role map (user rules alone)', () => {
    const p = pol([{ userIds: [5], rules: [CLIP8] }], []); // no standard, no role rules
    const paid = roundEntriesForPay(entries(), p, {});
    expect(paid[0].start_time).toBe('08:00:00'); // person 5: their own clip
    expect(paid[1].start_time).toBe('06:00:00'); // person 6: nothing → untouched
  });
});

describe('OT config + pricing is per-employee aware', () => {
  const settings = () => ({
    overtime_threshold: 8, overtime_multiplier: 1.5, week_start: 1,
    hours_rules: JSON.stringify({ enabled: true, rules: [], userRules: [{ userIds: [5], rules: [OT2] }] }),
  });

  test('otConfigFromSettings applies a person tier only for that person', () => {
    const s = settings();
    expect(otConfigFromSettings(s, null, 5).tierRules).toHaveLength(1); // person 5 has the 2× tier
    expect(otConfigFromSettings(s, null, 99)).toBeNull();               // no override, no company OT → null
    expect(otConfigFromSettings(s)).toBeNull();                         // standard (empty) → null
  });

  test('otConfigByRoleFactory keys on (role, user)', () => {
    const byRole = otConfigByRoleFactory(settings());
    const first = byRole(null, 5);
    expect(byRole(null, 5)).toBe(first);   // cached per (role,user)
    expect(byRole(null, 99)).toBeNull();   // different user, no override
    expect(byRole()).toBeNull();           // standard
  });

  test('computePaid prices the person tier — person 5 earns 2× past 8h, others do not', () => {
    const day = (uid) => [{ user_id: uid, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time: '17:00:00', break_minutes: 0 }];
    const p5 = computePaid(day(5), settings(), { rule: 'daily', userId: 5 });
    expect(p5.otBands).toEqual([{ hours: 2, mult: 2 }]);
    const p9 = computePaid(day(9), settings(), { rule: 'daily', userId: 9 });
    expect(p9.otBands).not.toEqual([{ hours: 2, mult: 2 }]); // no override → plain threshold
  });
});

describe('no-op guarantee: absent userRules leaves the default path identical', () => {
  test('policy without userRules resolves exactly to role/standard rules', () => {
    const p = parsePolicy(JSON.stringify({ enabled: true, rules: [CLIP], roleRules: [{ roleIds: [10], addToStandard: true, rules: [ROLE_LUNCH] }] }));
    expect(p.userRules).toEqual([]);
    // With any userId, no userRules → identical to inherited role/standard.
    expect(effectiveRulesForWorker(p, 10, 5).map(r => r.id)).toEqual(['clip', 'role-lunch']);
    expect(effectiveRulesForWorker(p, null, 5).map(r => r.id)).toEqual(['clip']);
  });
});
