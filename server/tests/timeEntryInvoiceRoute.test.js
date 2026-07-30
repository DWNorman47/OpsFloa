let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = mockCurrentUser;
    next();
  },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../push', () => ({
  sendPushToUser: jest.fn(),
  sendPushToCompanyAdmins: jest.fn(),
}));
jest.mock('../routes/inbox', () => ({
  createInboxItem: jest.fn(),
}));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../failureLog', () => ({ logFailure: jest.fn() }));
jest.mock('../utils/paidHours', () => ({ loadSettings: jest.fn() }));
jest.mock('../utils/payStatement', () => ({
  workerStatement: jest.fn(),
  workerPeriodStatements: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { loadSettings } = require('../utils/paidHours');
const { workerStatement } = require('../utils/payStatement');
const timeEntries = require('../routes/timeEntries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error: jest.fn() };
    next();
  });
  app.use('/api/time-entries', timeEntries);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentUser = {
    id: 7,
    company_id: 'co-1',
    full_name: 'Worker Seven',
    role: 'worker',
  };
});

test('invoice statement rejects invalid or oversized periods before querying payroll data', async () => {
  const invalid = await request(makeApp())
    .get('/api/time-entries/invoice-statement?from=not-a-date&to=2026-07-07');
  expect(invalid.status).toBe(400);

  const oversized = await request(makeApp())
    .get('/api/time-entries/invoice-statement?from=2026-01-01&to=2026-02-15');
  expect(oversized.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
  expect(workerStatement).not.toHaveBeenCalled();
});

test('invoice statement uses the canonical pay engine for the authenticated worker only', async () => {
  const worker = {
    id: 7,
    full_name: 'Worker Seven',
    invoice_name: 'Seven Services',
    email: 'seven@example.com',
    hourly_rate: '25.00',
    rate_type: 'hourly',
    overtime_rule: 'weekly',
    role_id: 3,
    guaranteed_weekly_hours: '40',
  };
  const settings = { week_start: 1, overtime_multiplier: 1.5 };
  const statement = {
    worker,
    period: { from: '2026-07-06', to: '2026-07-12' },
    entries: [],
    hours: { regular: 40, overtime: 2 },
    totals: { totalCost: 1075 },
  };
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [worker] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ plan: 'pro', subscription_status: 'active' }] });
  loadSettings.mockResolvedValue(settings);
  workerStatement.mockResolvedValue(statement);

  const res = await request(makeApp())
    .get('/api/time-entries/invoice-statement?from=2026-07-06&to=2026-07-12');

  expect(res.status).toBe(200);
  expect(res.body.totals.totalCost).toBe(1075);
  expect(pool.query.mock.calls[0][0]).toContain('WHERE id=$1 AND company_id=$2');
  expect(pool.query.mock.calls[0][1]).toEqual([7, 'co-1']);
  expect(workerStatement).toHaveBeenCalledWith({
    companyId: 'co-1',
    worker,
    settings,
    from: '2026-07-06',
    to: '2026-07-12',
    explain: true,
  });
});
