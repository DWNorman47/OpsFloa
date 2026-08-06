const fs = require('fs');
const path = require('path');
const {
  DAILY_CHECKLIST_STATUSES,
  DAILY_CHECKLIST_STATUS_DEFAULT,
  DAILY_CHECKLIST_SCHEDULE_TYPES,
  DAILY_CHECKLIST_SCHEDULE_TYPE_DEFAULT,
  DAILY_CHECKLIST_ITEM_SOURCES,
  DAILY_CHECKLIST_ITEM_SOURCE_DEFAULT,
  DAILY_CHECKLIST_ITEM_KINDS,
  DAILY_CHECKLIST_ITEM_KIND_DEFAULT,
} = require('../constants/dailyChecklistEnums');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '0163_daily_checklists.sql'),
  'utf8'
) + fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '0166_daily_checklist_item_kind.sql'),
  'utf8'
);

// Pull the value list out of a `col ... CHECK (col IN ('a', 'b'))` clause. `kind` appears in
// two CHECKs (both tables) with identical lists — the first match is representative.
function checkList(column) {
  const re = new RegExp(`${column} IN \\(([^)]*)\\)`);
  const m = migration.match(re);
  if (!m) throw new Error(`no CHECK found for ${column}`);
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort();
}

describe('daily checklist enums', () => {
  test('constant values are what the model expects', () => {
    expect([...DAILY_CHECKLIST_STATUSES].sort()).toEqual(['active', 'canceled', 'completed', 'paused', 'pending']);
    expect([...DAILY_CHECKLIST_SCHEDULE_TYPES].sort()).toEqual(['adhoc', 'calendar', 'ordinal']);
    expect([...DAILY_CHECKLIST_ITEM_SOURCES].sort()).toEqual(['manual', 'recurring', 'rollover', 'scheduled']);
    expect([...DAILY_CHECKLIST_ITEM_KINDS].sort()).toEqual(['check', 'text']);
  });

  test('all constants are frozen', () => {
    expect(Object.isFrozen(DAILY_CHECKLIST_STATUSES)).toBe(true);
    expect(Object.isFrozen(DAILY_CHECKLIST_SCHEDULE_TYPES)).toBe(true);
    expect(Object.isFrozen(DAILY_CHECKLIST_ITEM_SOURCES)).toBe(true);
    expect(Object.isFrozen(DAILY_CHECKLIST_ITEM_KINDS)).toBe(true);
  });

  test('defaults are members of their set', () => {
    expect(DAILY_CHECKLIST_STATUSES).toContain(DAILY_CHECKLIST_STATUS_DEFAULT);
    expect(DAILY_CHECKLIST_SCHEDULE_TYPES).toContain(DAILY_CHECKLIST_SCHEDULE_TYPE_DEFAULT);
    expect(DAILY_CHECKLIST_ITEM_SOURCES).toContain(DAILY_CHECKLIST_ITEM_SOURCE_DEFAULT);
    expect(DAILY_CHECKLIST_ITEM_KINDS).toContain(DAILY_CHECKLIST_ITEM_KIND_DEFAULT);
  });

  // The drift guard db-enums.md warns about: the constant and the DB CHECK must agree.
  test('constants match the migration CHECK constraints', () => {
    expect(checkList('status')).toEqual([...DAILY_CHECKLIST_STATUSES].sort());
    expect(checkList('schedule_type')).toEqual([...DAILY_CHECKLIST_SCHEDULE_TYPES].sort());
    expect(checkList('source')).toEqual([...DAILY_CHECKLIST_ITEM_SOURCES].sort());
    expect(checkList('kind')).toEqual([...DAILY_CHECKLIST_ITEM_KINDS].sort());
  });
});
