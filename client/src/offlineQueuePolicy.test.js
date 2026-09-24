import { describe, expect, test } from 'vitest';
import {
  LARGE_QUEUE_BODY_CHARS,
  MAX_NETWORK_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  countsTowardBackoff,
  isAbortTimeout,
  isAuthPaused,
  isTokenExpired,
  replayLane,
  requestTimeoutMs,
  tokenSig,
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

describe('slow uplinks + large bodies', () => {
  test('timeout scales with body size, capped', () => {
    expect(requestTimeoutMs(0)).toBe(NETWORK_TIMEOUT_MS);
    expect(requestTimeoutMs(200)).toBeGreaterThanOrEqual(NETWORK_TIMEOUT_MS);
    // ~4 MB of base64 photos gets minutes, not 15 s
    expect(requestTimeoutMs(4 * 1024 * 1024)).toBeGreaterThan(4 * 60 * 1000);
    expect(requestTimeoutMs(500 * 1024 * 1024)).toBe(MAX_NETWORK_TIMEOUT_MS);
  });

  test('only a timeout on a LARGE body counts toward backoff', () => {
    expect(countsTowardBackoff({ timedOut: true, bodyChars: LARGE_QUEUE_BODY_CHARS })).toBe(true);
    expect(countsTowardBackoff({ timedOut: true, bodyChars: 300 })).toBe(false);
    expect(countsTowardBackoff({ timedOut: false, bodyChars: LARGE_QUEUE_BODY_CHARS * 4 })).toBe(false);
    expect(isAbortTimeout({ name: 'TimeoutError' })).toBe(true);
    expect(isAbortTimeout(new TypeError('Failed to fetch'))).toBe(false);
  });

  test('field creates get their own lane; punches share the ordered lane', () => {
    expect(replayLane({ id: 1, type: 'clock' })).toBe('ordered');
    expect(replayLane({ id: 2, type: 'time-entry' })).toBe('ordered');
    expect(replayLane({ id: 3, type: 'field' })).toBe('field:3');
    expect(replayLane({ id: 3, type: 'field' })).not.toBe(replayLane({ id: 4, type: 'field' }));
  });
});

describe('auth pause (shared phone)', () => {
  const jwt = (payload) => `Bearer h.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.signature-${payload.id}-${payload.exp}`;

  test('expired saved tokens are detected; unknown exp is not "expired"', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(isTokenExpired(jwt({ id: 1, exp: now / 1000 - 60 }), now)).toBe(true);
    expect(isTokenExpired(jwt({ id: 1, exp: now / 1000 + 60 }), now)).toBe(false);
    expect(isTokenExpired('garbage', now)).toBe(false);
  });

  test('an item rejected with a token stays paused for that token and resumes with a new one', () => {
    const oldTok = jwt({ id: 1, exp: 1 });
    const newTok = jwt({ id: 1, exp: 2 });
    const item = { id: 9, auth_failed_sig: tokenSig(oldTok) };
    expect(isAuthPaused(item, oldTok)).toBe(true);
    expect(isAuthPaused(item, newTok)).toBe(false);
    expect(isAuthPaused({ id: 9 }, oldTok)).toBe(false);
  });
});
