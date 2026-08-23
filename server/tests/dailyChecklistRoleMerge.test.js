/**
 * appendAssembledItems: two assignments that share an item label but target DIFFERENT
 * team-member-types must MERGE into one row whose role_ids is the union — not drop the
 * second (which used to hide the item from that crew entirely).
 */

const { appendAssembledItems } = require('../utils/dailyChecklistCore');

function makeClient({ assigned = [], recurring = [], carry = [] }) {
  const inserts = []; // { text, roleIds }
  const roleUpdates = []; // { id, roleIds }
  let nextId = 1;
  const query = jest.fn(async (sql, params) => {
    if (/FROM daily_checklist_recurring_items/.test(sql)) return { rows: recurring };
    if (/FROM daily_checklist_assignments/.test(sql)) return { rows: assigned };
    if (/status = 'completed' ORDER BY/.test(sql)) return { rows: carry.length ? [{ id: 77 }] : [] };
    if (/checked = false/.test(sql)) return { rows: carry };
    if (/UPDATE daily_checklist_items SET role_ids/.test(sql)) {
      roleUpdates.push({ id: params[params.length - 1], roleIds: /= NULL/.test(sql) ? null : params[0] });
      return { rows: [] };
    }
    if (/INSERT INTO daily_checklist_items/.test(sql)) {
      inserts.push({ text: params[1], roleIds: params[5] });
      return { rows: [{ id: nextId++ }] };
    }
    return { rows: [] };
  });
  return { query, inserts, roleUpdates };
}

const item = (label) => ({ label, type: 'check' });

test('same label + mode, different role sets → one item, role_ids unioned', async () => {
  const c = makeClient({ assigned: [
    { role_ids: [1], mode: 'shared', carryover: true, items: [item('Inspect harness')] }, // Laborers
    { role_ids: [2], mode: 'shared', carryover: true, items: [item('Inspect harness')] }, // Foremen
  ] });
  await appendAssembledItems(c, { dayId: 10, companyId: 'co-1', projectId: 5, seen: new Set(), startOrder: 0 });
  // Only ONE insert for the shared label...
  const harness = c.inserts.filter(i => i.text === 'Inspect harness');
  expect(harness).toHaveLength(1);
  expect(harness[0].roleIds).toEqual([1]);
  // ...then a role widen to the union so BOTH crews see it.
  expect(c.roleUpdates).toContainEqual({ id: 1, roleIds: [1, 2] });
});

test('an all-types (recurring) label dominates a role-scoped assignment of the same text', async () => {
  const c = makeClient({
    recurring: [{ text: 'Site walk', kind: 'check' }], // all-types (role_ids NULL)
    assigned: [{ role_ids: [3], mode: 'shared', carryover: true, items: [item('Site walk')] }],
  });
  await appendAssembledItems(c, { dayId: 10, companyId: 'co-1', projectId: 5, seen: new Set(), startOrder: 0 });
  // One insert (all-types); the role-scoped copy merges in and, since the existing is
  // all-types, no widen is needed (already a superset) — no UPDATE.
  expect(c.inserts.filter(i => i.text === 'Site walk')).toHaveLength(1);
  expect(c.inserts.find(i => i.text === 'Site walk').roleIds).toBeNull();
  expect(c.roleUpdates).toHaveLength(0);
});

test('a role-scoped item then an all-types item of the same text → widened to all-types', async () => {
  const c = makeClient({ assigned: [
    { role_ids: [1], mode: 'shared', carryover: true, items: [item('Toolbox talk')] },
    { role_ids: null, mode: 'shared', carryover: true, items: [item('Toolbox talk')] }, // all types
  ] });
  await appendAssembledItems(c, { dayId: 10, companyId: 'co-1', projectId: 5, seen: new Set(), startOrder: 0 });
  expect(c.inserts.filter(i => i.text === 'Toolbox talk')).toHaveLength(1);
  expect(c.roleUpdates).toContainEqual({ id: 1, roleIds: null }); // widened to all-types
});
