import { describe, expect, test } from 'vitest';
import { workOrderDisplayName } from './WorkOrdersPanel';

describe('workOrderDisplayName', () => {
  test('uses the full_name returned by the workers API', () => {
    expect(workOrderDisplayName({ id: 7, full_name: 'Jordan Lee' })).toBe('Jordan Lee');
  });

  test('continues to support named customers and projects', () => {
    expect(workOrderDisplayName({ id: 9, name: 'Atlas Fleet' })).toBe('Atlas Fleet');
  });
});
