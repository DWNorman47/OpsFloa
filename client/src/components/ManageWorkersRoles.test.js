import { describe, expect, test } from 'vitest';
import { resolveWorkerRoleId } from './ManageWorkers';

const roles = [
  { id: 10, name: 'Admin', is_builtin: true },
  { id: 20, name: 'Owner', is_builtin: true },
  { id: 30, name: 'Worker', is_builtin: true },
];

describe('resolveWorkerRoleId', () => {
  test('preserves an explicit role assignment', () => {
    expect(resolveWorkerRoleId({ role: 'worker', role_id: 77 }, roles)).toBe(77);
  });

  test('maps a legacy worker to the built-in Worker role', () => {
    expect(resolveWorkerRoleId({ role: 'worker', role_id: null }, roles)).toBe(30);
  });

  test('maps a legacy admin to the built-in Admin role', () => {
    expect(resolveWorkerRoleId({ role: 'admin', role_id: null }, roles)).toBe(10);
  });

  test('returns null when the matching built-in role is unavailable', () => {
    expect(resolveWorkerRoleId({ role: 'worker', role_id: null }, [])).toBeNull();
  });
});
