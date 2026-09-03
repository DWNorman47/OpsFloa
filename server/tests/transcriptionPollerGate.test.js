/**
 * The transcription sweep must never poll a stuck recording forever, and must not
 * touch the DB beyond what's needed. These cover the reaping/anti-zombie safety that
 * bounds the poller (the rest of the bound — the activeUntil window — is enforced in
 * the cron callback around this function).
 */

let mockConfigured = true;
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));
jest.mock('../services/assemblyai', () => ({ isConfigured: () => mockConfigured, getTranscript: jest.fn() }));
jest.mock('../r2', () => ({ deleteByUrl: jest.fn() }));
jest.mock('../storage', () => ({ decrementStorage: jest.fn() }));
jest.mock('../jobs/runJob', () => ({ runJob: (_name, fn) => fn() }));

const pool = require('../db');
const assemblyai = require('../services/assemblyai');
const { pollProcessingRecordings } = require('../jobs/transcriptionPoller');

beforeEach(() => {
  pool.query.mockReset();
  assemblyai.getTranscript.mockReset();
  mockConfigured = true;
});

test('force-fails a stuck (stale) recording instead of polling it forever', async () => {
  const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h old, well past the stale cutoff
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT id, created_at FROM recordings/.test(sql)) return { rows: [{ id: 7, created_at: OLD }] };
    if (/UPDATE\s+recordings\s+SET status = 'failed'/.test(sql)) return { rowCount: 1 };
    if (/SELECT 1 FROM recordings WHERE status = 'processing'/.test(sql)) return { rows: [] };
    return { rows: [] };
  });

  await pollProcessingRecordings();

  // It was failed, not polled — a dead row can't keep the sweep alive.
  expect(assemblyai.getTranscript).not.toHaveBeenCalled();
  expect(pool.query.mock.calls.some(c => /SET status = 'failed'/.test(c[0]))).toBe(true);
});

test('polls a fresh (recent) processing recording', async () => {
  const NEW = new Date().toISOString();
  assemblyai.getTranscript.mockResolvedValue({ status: 'processing' }); // not done yet
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT id, created_at FROM recordings/.test(sql)) return { rows: [{ id: 9, created_at: NEW }] };
    if (/SELECT id, provider_job_id FROM recordings WHERE id = \$1/.test(sql)) return { rows: [{ id: 9, provider_job_id: 'job-9' }] };
    if (/SELECT 1 FROM recordings WHERE status = 'processing'/.test(sql)) return { rows: [{ ok: 1 }] };
    return { rows: [] };
  });

  await pollProcessingRecordings();

  expect(assemblyai.getTranscript).toHaveBeenCalledWith('job-9');
  expect(pool.query.mock.calls.some(c => /SET status = 'failed'/.test(c[0]))).toBe(false);
});

test('does nothing (and no external calls) when nothing is processing', async () => {
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT id, created_at FROM recordings/.test(sql)) return { rows: [] };
    return { rows: [] };
  });

  await pollProcessingRecordings();

  expect(assemblyai.getTranscript).not.toHaveBeenCalled();
  // Only the single "anything pending?" list query ran — no reap, no recheck.
  expect(pool.query).toHaveBeenCalledTimes(1);
});
