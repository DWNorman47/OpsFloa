import { describe, expect, test } from 'vitest';
import { splitQueueCounts } from './OfflineContext';

describe('splitQueueCounts (shared phone)', () => {
  test("only the signed-in user's items count as theirs; the rest are another user's", () => {
    const counts = { count: 5, byScope: { 'co:1': 2, 'co:2': 3 } };
    expect(splitQueueCounts(counts, 'co:1')).toEqual({ queueCount: 2, otherUserQueueCount: 3 });
    expect(splitQueueCounts(counts, 'co:9')).toEqual({ queueCount: 0, otherUserQueueCount: 5 });
  });

  test('items with no user count as mine; an older SW without per-user counts → all mine', () => {
    expect(splitQueueCounts({ count: 3, byScope: { '': 1, 'co:2': 2 } }, 'co:1')).toEqual({ queueCount: 1, otherUserQueueCount: 2 });
    expect(splitQueueCounts({ count: 4, byScope: null }, 'co:1')).toEqual({ queueCount: 4, otherUserQueueCount: 0 });
    expect(splitQueueCounts({ count: 4, byScope: { 'co:1': 4 } }, null)).toEqual({ queueCount: 4, otherUserQueueCount: 0 });
  });
});
