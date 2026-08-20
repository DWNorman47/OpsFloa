/**
 * autoStartDay — the clock-in trigger's core. No HTTP; drive it with a mock client.
 * Precedence (calendar today → ordinal N → top of queue → adhoc) and item assembly
 * (recurring + rollover, deduped) must hold, and it must no-op when a day is already active.
 */

const { autoStartDay } = require('../utils/dailyChecklistCore');

// A mock pg client whose query() dispatches on the SQL text. `plan` overrides which rows
// each logical query returns; `inserted` captures item inserts.
function makeClient(plan = {}) {
  const inserted = [];
  const client = {
    inserted,
    query: jest.fn(async (sql, params) => {
      if (/status = 'active'/.test(sql) && /SELECT id FROM/.test(sql)) return { rows: plan.active || [] };
      if (/SET status = 'paused'/.test(sql)) return {};
      if (/MAX\(day_number\)/.test(sql)) return { rows: [{ n: plan.dayNumber || 1 }] };
      if (/CURRENT_DATE::text/.test(sql)) return { rows: [{ d: '2026-08-05' }] };
      if (/schedule_type = 'calendar'/.test(sql)) return { rows: plan.calendar || [] };
      if (/schedule_type = 'ordinal'/.test(sql)) return { rows: plan.ordinal || [] };
      if (/status IN \('pending','paused'\) ORDER BY queue_order/.test(sql)) return { rows: plan.queue || [] };
      if (/UPDATE daily_checklists SET status = 'active'/.test(sql)) return { rows: [{ id: (plan.chosenId || 30), status: 'active', day_number: plan.dayNumber || 1 }] };
      if (/INSERT INTO daily_checklists/.test(sql)) return { rows: [{ id: 99, status: 'active', schedule_type: 'adhoc' }] };
      if (/SELECT text, order_index FROM daily_checklist_items/.test(sql)) return { rows: plan.existingItems || [] };
      if (/FROM daily_checklist_recurring_items/.test(sql)) return { rows: plan.recurring || [] };
      if (/status = 'completed' ORDER BY/.test(sql)) return { rows: plan.completedDay || [] };
      if (/checked = false/.test(sql)) return { rows: plan.carry || [] };
      if (/INSERT INTO daily_checklist_items/.test(sql)) { inserted.push({ text: params[1], source: params[4] }); return { rows: [{ id: inserted.length }] }; }
      return { rows: [] };
    }),
  };
  return client;
}

const opts = { companyId: 'co-1', projectId: 7, userId: 5, workDate: '2026-08-05' };

test('no-op when a day is already active', async () => {
  const client = makeClient({ active: [{ id: 42 }] });
  const r = await autoStartDay(client, opts);
  expect(r).toEqual({ started: false, dayId: 42 });
  expect(client.query.mock.calls.map(c => c[0]).join('\n')).not.toMatch(/INSERT INTO daily_checklists/);
});

test('resumes the top of the queue and appends recurring deduped', async () => {
  const client = makeClient({
    queue: [{ id: 30, status: 'pending' }],
    chosenId: 30,
    existingItems: [{ text: 'Prepared A', order_index: 0 }],
    recurring: [{ text: 'Prepared A' }, { text: 'Recurring B' }],
  });
  const r = await autoStartDay(client, opts);
  expect(r).toEqual({ started: true, dayId: 30 });
  expect(client.inserted).toEqual([{ text: 'Recurring B', source: 'recurring' }]); // 'Prepared A' deduped
});

test('creates an adhoc day (with recurring + rollover) when nothing is queued', async () => {
  const client = makeClient({
    recurring: [{ text: 'Sweep' }],
    completedDay: [{ id: 50 }],
    carry: [{ text: 'Sweep' }, { text: 'Fix rail' }], // 'Sweep' dups recurring
  });
  const r = await autoStartDay(client, opts);
  expect(r.started).toBe(true);
  expect(r.dayId).toBe(99); // adhoc insert
  expect(client.inserted).toEqual([
    { text: 'Sweep', source: 'recurring' },
    { text: 'Fix rail', source: 'rollover' },
  ]);
});

test('a calendar plan dated today wins over the queue', async () => {
  const client = makeClient({
    calendar: [{ id: 12, status: 'pending' }],
    queue: [{ id: 30 }],
    chosenId: 12,
  });
  const r = await autoStartDay(client, opts);
  expect(r.dayId).toBe(12);
});
