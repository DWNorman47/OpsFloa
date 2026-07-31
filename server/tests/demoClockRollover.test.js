jest.mock('../db', () => ({ connect: jest.fn() }));

const pool = require('../db');
const {
  DEMO_CLOCK_ROLLOVER_HOURS,
  DEMO_SHIFT_HOURS,
  rolloverStaleDemoClocks,
} = require('../services/demoClockRollover');

const NOW = new Date('2026-07-30T18:00:00.000Z');
const OLD_CLOCK_IN = new Date('2026-07-29T15:00:00.000Z');

function clockRow(overrides = {}) {
  return {
    id: 101,
    company_id: 'demo-company',
    user_id: 22,
    project_id: 33,
    clock_in_time: OLD_CLOCK_IN,
    clock_in_lat: '33.4484000',
    clock_in_lng: '-112.0740000',
    timezone: 'America/Phoenix',
    wage_type: 'prevailing',
    notes: 'Route prep',
    clock_source: 'admin',
    clocked_in_by: 7,
    ...overrides,
  };
}

function makeClient(rows) {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };

  client.query.mockImplementation(async sql => {
    if (sql.includes('SELECT ac.*')) {
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  pool.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  pool.connect.mockReset();
});

test('finalizes old Demo Operations clocks as eight-hour entries and restarts them', async () => {
  const client = makeClient([clockRow()]);

  const count = await rolloverStaleDemoClocks({ now: NOW });

  expect(count).toBe(1);
  const calls = client.query.mock.calls;
  const selectCall = calls.find(([sql]) => sql.includes('SELECT ac.*'));
  const insertCall = calls.find(([sql]) => sql.includes('INSERT INTO time_entries'));
  const updateCall = calls.find(([sql]) => sql.includes('UPDATE active_clock'));

  expect(selectCall[0]).toContain('c.is_demo = true');
  expect(selectCall[0]).toContain("c.subscription_status = 'exempt'");
  expect(selectCall[0]).toContain('FOR UPDATE OF ac');
  expect(selectCall[1][0]).toEqual(
    new Date(NOW.getTime() - DEMO_CLOCK_ROLLOVER_HOURS * 60 * 60 * 1000)
  );

  const entry = insertCall[1];
  expect(entry.slice(0, 6)).toEqual([
    'demo-company',
    22,
    33,
    '2026-07-29',
    '08:00:00',
    '16:00:00',
  ]);
  expect(entry[7].getTime() - entry[6].getTime()).toBe(DEMO_SHIFT_HOURS * 60 * 60 * 1000);
  expect(entry.slice(8)).toEqual([
    'prevailing',
    'Route prep',
    '33.4484000',
    '-112.0740000',
    'America/Phoenix',
    'admin',
    7,
  ]);

  expect(updateCall[1]).toEqual([
    new Date('2026-07-30T17:45:00.000Z'),
    '2026-07-30',
    101,
  ]);
  expect(calls[0][0]).toBe('BEGIN');
  expect(calls.at(-1)[0]).toBe('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('commits without creating entries when no qualifying demo clock exists', async () => {
  const client = makeClient([]);

  await expect(rolloverStaleDemoClocks({ now: NOW })).resolves.toBe(0);

  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN',
    expect.stringContaining('SELECT ac.*'),
    'COMMIT',
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('rolls back and releases the connection when a rollover write fails', async () => {
  const client = makeClient([clockRow()]);
  const writeError = new Error('insert failed');
  client.query.mockImplementation(async sql => {
    if (sql.includes('SELECT ac.*')) {
      return { rows: [clockRow()], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO time_entries')) throw writeError;
    return { rows: [], rowCount: 0 };
  });

  await expect(rolloverStaleDemoClocks({ now: NOW })).rejects.toBe(writeError);

  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN',
    expect.stringContaining('SELECT ac.*'),
    expect.stringContaining('INSERT INTO time_entries'),
    'ROLLBACK',
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
});
