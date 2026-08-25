# Individual (per-employee) rule overrides — design

Add per-employee overrides to Hours & Pay Rules, after Role Rules. An admin picks an
employee and, for that person, can: **add** a brand-new rule, **nullify** an inherited
rule, **change** an inherited rule, or **replace** their whole rule set. Started 2026-08-21.

Precedence: **individual > role > standard.** Money-critical; opt-in-safe (no `userRules`
present → default path byte-for-byte unchanged).

## Data model (same `settings.hours_rules` JSON, no new table)
Add `userRules[]`, mirroring `roleRules[]` (parsed by a `parseUserRules` twin):
```
userRules: [{
  userIds: [int...],            // usually one employee per set
  mode: 'add' | 'replace',      // 'add' layers on inherited; 'replace' ignores inherited
  disabledRuleIds: [string...], // ids of inherited rules to NULLIFY (add-mode only)
  rules: [ <rule>... ]          // this person's own rules (new, or changed clones)
}]
```
Rule `id`s are stable across saves (`parseRule` keeps `raw.id`; builder assigns `r<rand>`),
so `disabledRuleIds` can reference inherited rules. An override for a deleted user never
matches (free orphan handling, like `roleRules` for deleted roles).

## Engine (hoursRules.js) — one new resolver, threaded through the one chokepoint
- `parseUserRules(raw)` → normalized array (int userIds, mode, string disabledRuleIds, parsed rules).
- `parsePolicy` gains `userRules: parseUserRules(obj.userRules)`.
- `effectiveRulesForWorker(policy, roleId, userId)`:
  1. `inherited = effectiveRulesForRole(policy, roleId)` (standard/role, unchanged);
  2. no matching user section → return inherited (default path, untouched);
  3. `replace` → the section's rules; `add` → `inherited.filter(r => !disabled.has(r.id)).concat(section.rules)`.
- The three role-keyed resolvers gain an optional `userId` and call `effectiveRulesForWorker`
  instead of `effectiveRulesForRole`: `otConfigFromSettings`, `sickRulesFromSettings`,
  and `roundEntriesForPay` (uses `e.user_id`, already in scope). Their memo factories key on
  `(roleId, userId)`. `userId` omitted/undefined ⇒ identical to today.
- Because all four pay surfaces funnel through these, threading `worker.id` alongside the
  existing `worker.role_id` in `payStatement.js` makes overrides apply everywhere at once.

## The three UI actions → mechanism
- **Add a new rule** → append to `userRules[set].rules`. (Trivial.)
- **Nullify an inherited rule** → add its id to `disabledRuleIds`.
- **Change an inherited rule** → clone it into `rules` (new id, editable) + tombstone the
  original id. The clone supersedes.
- **Replace** → `mode:'replace'` (blunt; ignores role+standard entirely).

## UI (HoursRulesSettings.jsx, reusing HoursRuleBuilder)
"Individual Overrides" section after Role Rules (`:402`), a collapsible set per employee:
- **employee picker** (fetch `/admin/workers`, chips like the role picker; one set per employee);
- a **replace-mode** toggle ("use only the rules below; ignore role & standard");
- the **inherited rules** listed with an on/off toggle (off = nullify) + a **Customize** action
  (clone → edit) for change;
- a `<HoursRuleBuilder>` for the person's own new rules.
- `policyToForm`/`formToPolicy` round-trip `userRules`; EN+ES i18n (build enforces parity).

## Guardrails
- 40 KB policy cap (`admin.js:290`) — per-user lists grow faster; add a count guard + clear error.
- Money-critical: engine tests must prove (a) default path unchanged with no userRules, and
  (b) add / nullify / change / replace / precedence each correct, mirroring the `roleRules`
  test rigor. Statement-level test with an override on.
- `docs/db-enums.md` hours_rules section: document `userRules`.

## Phasing
1. Engine + threading + tests (backend; default unchanged). ← first
2. UI + i18n.
