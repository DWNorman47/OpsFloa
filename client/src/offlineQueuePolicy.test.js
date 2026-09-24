import { describe, expect, test } from 'vitest';
import {
  MAX_QUEUE_AGE_MS,
  MAX_REPLAY_ATTEMPTS,
  backoffMs,
  classifyReplayStatus,
  isBackingOff,
  isStuck,
  newIdempotencyKey,
  parseQueueableBody,
  shouldDropOnStatus,
  withFailedAttempt,
} from './offlineQueuePolicy';

describe('classifyReplayStatus', () => {
  test('2xx is done', () => {
    for (const s of [200, 201, 202, 204]) expect(classifyReplayStatus(s)).toBe('done');
  });

  test('409 is already-applied (done) — except a closed job, which is a permanent failure', () => {
    expect(classifyReplayStatus(409)).toBe('done');
    expect(classifyReplayStatus(409, 'already_marked')).toBe('done');
    expect(classifyReplayStatus(409, 'project_frozen')).toBe('drop');
  });

  test('5xx (Render cold start / deploy), 429 and 408 are kept for retry, never dropped', () => {
    for (const s of [500, 502, 503, 504, 429, 408]) {
      expect(classifyReplayStatus(s)).toBe('retry');
      expect(shouldDropOnStatus(s)).toBe(false);
    }
  });

  test('401 keeps the item and pauses for re-auth', () => {
    expect(classifyReplayStatus(401)).toBe('auth');
    expect(shouldDropOnStatus(401)).toBe(false);
  });

  test('permanent client errors are dropped (and reported by the SW)', () => {
    for (const s of [400, 403, 404, 410, 413, 422]) expect(shouldDropOnStatus(s)).toBe(true);
  });

  test('unexpected statuses (redirect / opaque 0) are retried rather than lost', () => {
    expect(classifyReplayStatus(0)).toBe('retry');
    expect(classifyReplayStatus(302)).toBe('retry');
  });
});

describe('backoff + poison cap', () => {
  test('backoff grows exponentially and is capped', () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(2)).toBe(10000);
    expect(backoffMs(3)).toBe(20000);
    expect(backoffMs(50)).toBe(10 * 60 * 1000);
  });

  test('withFailedAttempt counts server failures and schedules the next try', () => {
    const now = 1_000_000;
    const next = withFailedAttempt({ id: 1, attempts: 0 }, { status: 503, now });
    expect(next).toMatchObject({ id: 1, attempts: 1, last_status: 503, last_attempt_at: now, next_attempt_at: now + 5000 });
    expect(isBackingOff(next, now + 1000)).toBe(true);
    expect(isBackingOff(next, now + 5001)).toBe(false);
  });

  test('network errors do not count toward the cap or add backoff', () => {
    const next = withFailedAttempt({ id: 1, attempts: 2 }, { now: 5, countAttempt: false });
    expect(next.attempts).toBe(2);
    expect(next.next_attempt_at).toBeNull();
  });

  test('an item becomes stuck at the attempt cap', () => {
    expect(isStuck({ attempts: MAX_REPLAY_ATTEMPTS - 1 })).toBe(false);
    expect(isStuck({ attempts: MAX_REPLAY_ATTEMPTS })).toBe(true);
  });

  test('an old item is stuck only once it has actually been tried', () => {
    const now = Date.parse('2026-09-24T00:00:00Z');
    const old = new Date(now - MAX_QUEUE_AGE_MS - 1000).toISOString();
    expect(isStuck({ attempts: 0, queued_at: old }, now)).toBe(false); // e.g. device offline a week
    expect(isStuck({ attempts: 1, queued_at: old }, now)).toBe(true);
    expect(isStuck({ attempts: 1, queued_at: new Date(now).toISOString() }, now)).toBe(false);
  });
});

describe('idempotency key + body parsing', () => {
  test('keys are unique UUIDs (36 chars fits time_entries.client_id)', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(a.length).toBe(36);
  });

  test('empty body queues as {}; JSON parses; non-JSON is refused (not queued as blank)', () => {
    expect(parseQueueableBody('')).toEqual({ ok: true, body: {} });
    expect(parseQueueableBody('{"a":1}')).toEqual({ ok: true, body: { a: 1 } });
    expect(parseQueueableBody('--boundary\r\nContent-Disposition: form-data').ok).toBe(false);
  });
});
