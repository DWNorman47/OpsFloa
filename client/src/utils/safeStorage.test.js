import { describe, test, expect } from 'vitest';
import { safeSession, safeLocal } from './safeStorage';

// Simulate the real failure: the storage PROPERTY GETTER throws a SecurityError
// (what a storage-blocked / partitioned browser does), not just getItem.
function denyStorage(prop) {
  const original = Object.getOwnPropertyDescriptor(window, prop);
  Object.defineProperty(window, prop, {
    configurable: true,
    get() { throw new DOMException('access denied', 'SecurityError'); },
  });
  return () => Object.defineProperty(window, prop, original);
}

describe('safeStorage degrades instead of throwing', () => {
  test('getItem returns null when the storage getter is denied', () => {
    const restore = denyStorage('sessionStorage');
    try {
      expect(() => safeSession.getItem('tc_token')).not.toThrow();
      expect(safeSession.getItem('tc_token')).toBeNull();
    } finally { restore(); }
  });

  test('setItem / removeItem are silent no-ops when denied', () => {
    const restore = denyStorage('localStorage');
    try {
      expect(() => safeLocal.setItem('tc_token', 'x')).not.toThrow();
      expect(() => safeLocal.removeItem('tc_token')).not.toThrow();
    } finally { restore(); }
  });

  test('reads and writes normally when storage is available', () => {
    safeLocal.setItem('k', 'v');
    expect(safeLocal.getItem('k')).toBe('v');
    safeLocal.removeItem('k');
    expect(safeLocal.getItem('k')).toBeNull();
  });
});
