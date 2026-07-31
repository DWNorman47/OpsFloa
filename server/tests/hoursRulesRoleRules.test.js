/**
 * Role-specific Hours & Pay Rules.
 *
 * The policy grows one additive key, `roleRules`: a list of per-role rule sets,
 * each flagged add-on (`addToStandard: true`, the effective list is
 * `standard ++ role`) or overwrite (`false`, the role's list replaces standard).
 * A worker whose `role_id` has no section — or is null, or points at a deleted
 * role — falls back to the Standard Rules, so a company that never touches the
 * feature is byte-for-byte unchanged.
 *
 * These tests pin exactly that: the effective-list math, that it flows through
 * both the rounding engine and the (previously company-scalar) OT config, and
 * that the whole thing is a no-op when `roleRules` is absent or no role map is
 * supplied.
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const {
  parsePolicy,
  parseRoleRules,
  effectiveRulesForRole,
  roundEntriesForPay,
  otConfigFromSettings,
  otConfigByRoleFactory,
} = require('../utils/hoursRules');
const { computePaid, laborCostCents } = require('../utils/paidHours');

const CLIP = { id: 'clip', type: 'clip_start', when: { kind: 'every_day' }, at: '07:00' };
const LUNCH = { id: 'lunch', type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } };
const ROLE_CLIP = { id: 'rclip', type: 'clip_start', when: { kind: 'every_day' }, at: '08:00' };

const policy = (roleRules, rules = [CLIP]) =>
  parsePolicy(JSON.stringify({ enabled: true, rules, roleRules }));

describe('parseRoleRules — validation & normalization', () => {
  test('keeps valid entries, drops junk, defaults addToStandard to true', () => {
    const p = parsePolicy(JSON.stringify({
      enabled: true,
      roleRules: [
        { roleId: 5, rules: [] },                                   // default add-on
        { roleId: 7, addToStandard: false, rules: [ROLE_CLIP] },    // overwrite
        { roleId: 'abc', rules: [] },                               // non-int id → dropped
        { rules: [] },                                              // no id → dropped
        null,                                                       // dropped
        'nope',                                                     // dropped
      ],
    }));
    expect(p.roleRules.map(r => r.roleIds)).toEqual([[5], [7]]); // legacy single roleId → [roleId]
    expect(p.roleRules[0].addToStandard).toBe(true);
    expect(p.roleRules[1].addToStandard).toBe(false);
    expect(p.roleRules[1].rules.map(r => r.id)).toEqual(['rclip']);
  });

  test('accepts multi-role roleIds, folds in the legacy roleId, de-dupes', () => {
    const p = parsePolicy(JSON.stringify({
      enabled: true,
      roleRules: [
        { roleIds: [5, 7, 7], rules: [] },   // multi-role, de-duped
        { roleId: 9, rules: [] },            // legacy single → [9]
        { roleIds: ['x', 3.5], rules: [] },  // no valid integer id → dropped
      ],
    }));
    expect(p.roleRules.map(r => r.roleIds)).toEqual([[5, 7], [9]]);
  });

  test('a missing or non-array roleRules is an empty list, never a throw', () => {
    expect(parsePolicy(JSON.stringify({ enabled: true })).roleRules).toEqual([]);
    expect(parseRoleRules(undefined)).toEqual([]);
    expect(parseRoleRules('x')).toEqual([]);
    expect(parseRoleRules([{ roleId: 3.5, rules: [] }])).toEqual([]); // non-integer
  });
});

describe('effectiveRulesForRole — the concat/replace decision', () => {
  const p = policy([
    { roleId: 10, addToStandard: true, rules: [LUNCH] },
    { roleId: 20, addToStandard: false, rules: [ROLE_CLIP] },
  ]);

  test('add-on role gets standard ++ role', () => {
    expect(effectiveRulesForRole(p, 10).map(r => r.id)).toEqual(['clip', 'lunch']);
  });
  test('overwrite role gets only its own rules', () => {
    expect(effectiveRulesForRole(p, 20).map(r => r.id)).toEqual(['rclip']);
  });
  test('a role with no section falls back to standard', () => {
    expect(effectiveRulesForRole(p, 30).map(r => r.id)).toEqual(['clip']);
  });
  test('a section covering multiple roles matches each of them', () => {
    const pm = policy([{ roleIds: [10, 11], addToStandard: true, rules: [LUNCH] }]);
    expect(effectiveRulesForRole(pm, 10).map(r => r.id)).toEqual(['clip', 'lunch']);
    expect(effectiveRulesForRole(pm, 11).map(r => r.id)).toEqual(['clip', 'lunch']);
    expect(effectiveRulesForRole(pm, 12).map(r => r.id)).toEqual(['clip']); // not covered
  });
  test('null role_id (super_admin/legacy) falls back to standard', () => {
    expect(effectiveRulesForRole(p, null).map(r => r.id)).toEqual(['clip']);
  });
  test('a policy with no roleRules always returns standard', () => {
    expect(effectiveRulesForRole(policy([]), 10).map(r => r.id)).toEqual(['clip']);
  });
});

describe('roundEntriesForPay — per-worker effective rules', () => {
  const p = policy([{ roleId: 10, addToStandard: true, rules: [LUNCH] }]);
  const entries = () => [
    { user_id: 1, work_date: '2026-07-06', start_time: '06:00:00', end_time: '15:00:00', break_minutes: 0 },
    { user_id: 2, work_date: '2026-07-06', start_time: '06:00:00', end_time: '15:00:00', break_minutes: 0 },
  ];

  test('add-on worker gets standard clip AND the role lunch; a no-section worker gets clip only', () => {
    const paid = roundEntriesForPay(entries(), p, { workerRoleById: { 1: 10, 2: 20 } });
    expect(paid[0].start_time).toBe('07:00:00'); // standard clip applies to both
    expect(paid[0].break_minutes).toBe(60);      // role add-on lunch — worker 1 only
    expect(paid[1].start_time).toBe('07:00:00');
    expect(paid[1].break_minutes).toBe(0);       // worker 2 (role 20, no section): no lunch
  });

  test('overwrite role replaces standard for that worker', () => {
    const po = policy([{ roleId: 20, addToStandard: false, rules: [ROLE_CLIP] }]);
    const paid = roundEntriesForPay(entries(), po, { workerRoleById: { 1: 10, 2: 20 } });
    expect(paid[0].start_time).toBe('07:00:00'); // worker 1: no section → standard 07:00 clip
    expect(paid[1].start_time).toBe('08:00:00'); // worker 2: overwrite → 08:00 clip, standard ignored
  });

  test('without a role map, everyone gets the standard rules (unchanged behaviour)', () => {
    const paid = roundEntriesForPay(entries(), p);
    expect(paid[0].start_time).toBe('07:00:00');
    expect(paid[0].break_minutes).toBe(0);       // no lunch — role rules dormant with no ctx
    expect(paid[1].break_minutes).toBe(0);
  });

  test('role rules process even when the standard list is empty', () => {
    const po = policy([{ roleId: 10, addToStandard: false, rules: [ROLE_CLIP] }], []);
    const paid = roundEntriesForPay(entries(), po, { workerRoleById: { 1: 10, 2: 20 } });
    expect(paid[0].start_time).toBe('08:00:00'); // role 10: its own clip
    expect(paid[1].start_time).toBe('06:00:00'); // role 20: no section, empty standard → untouched
  });
});

describe('OT config is role-aware', () => {
  const OT2 = { id: 't', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 8, mult: 2 };
  const settings = () => ({
    overtime_threshold: 8, overtime_multiplier: 1.5, week_start: 1,
    hours_rules: JSON.stringify({
      enabled: true,
      rules: [],
      roleRules: [{ roleId: 10, addToStandard: true, rules: [OT2] }],
    }),
  });

  test('otConfigFromSettings applies a role tier only for that role', () => {
    const s = settings();
    expect(otConfigFromSettings(s, 10).tierRules).toHaveLength(1); // role 10 has the 2× tier
    expect(otConfigFromSettings(s, 99)).toBeNull();                // no section, no company OT → null
    expect(otConfigFromSettings(s)).toBeNull();                    // no role → standard (empty) → null
  });

  test('otConfigByRoleFactory memoizes and keys null separately', () => {
    const byRole = otConfigByRoleFactory(settings());
    const first = byRole(10);
    expect(byRole(10)).toBe(first);       // same object, cached
    expect(byRole()).toBeNull();          // standard
    expect(byRole(null)).toBeNull();      // null key == standard
  });

  test('computePaid prices the role tier — a role worker earns 2× past 8h', () => {
    const day = [{ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time: '17:00:00', break_minutes: 0 }];
    // 10h day. Role 10: 8 reg + 2h @ 2×. No role: company has no OT config → plain threshold.
    const role = computePaid(day, settings(), { rule: 'daily', roleId: 10 });
    expect(role.otBands).toEqual([{ hours: 2, mult: 2 }]);
    const noRole = computePaid(day, settings(), { rule: 'daily', roleId: 99 });
    // No section → no tier config; the plain threshold still splits 2h of OT,
    // with mult:null meaning "use the company default multiplier downstream".
    expect(noRole.otBands).toEqual([{ hours: 2, mult: null }]);
  });

  test('laborCostCents pays two roles differently off the same punch', () => {
    const s = settings();
    // 07:00→17:00 = 10h @ $100. Role 10: 8×100 + 2×100×2 = 1200. Role 99: no OT config,
    // but the company multiplier (1.5) still applies past the 8h threshold → 8×100 + 2×100×1.5 = 1100.
    const roleRow = { user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time: '17:00:00', break_minutes: 0, rate: '100', ot_rule: 'daily', role_id: 10 };
    const plainRow = { ...roleRow, user_id: 2, role_id: 99 };
    expect(laborCostCents([roleRow], s)).toBe(120000);
    expect(laborCostCents([plainRow], s)).toBe(110000);
  });
});

describe('backward compatibility — no roleRules is identical to today', () => {
  const s = { enabled: true, rules: [CLIP], display: { showActualAndPaid: true } };
  const p = parsePolicy(JSON.stringify(s));
  const entries = () => [
    { user_id: 1, work_date: '2026-07-06', start_time: '06:00:00', end_time: '15:00:00', break_minutes: 0 },
  ];

  test('roundEntriesForPay yields the same result with and without a role map', () => {
    const without = roundEntriesForPay(entries(), p);
    const withMap = roundEntriesForPay(entries(), p, { workerRoleById: { 1: 10 } });
    expect(withMap).toEqual(without);
  });

  test('an all-off policy with no roleRules still returns the input array by reference', () => {
    const off = parsePolicy(JSON.stringify({ enabled: true, rules: [] }));
    const arr = entries();
    expect(roundEntriesForPay(arr, off, { workerRoleById: { 1: 10 } })).toBe(arr);
  });
});
