import { describe, expect, test } from 'vitest';
import { overtimeDisplayRate } from './CertifiedPayrollPDF';

describe('certified payroll overtime display rate', () => {
  test('uses the effective rate that reconciles overtime cost and hours', () => {
    expect(overtimeDisplayRate({
      overtime_total: 4,
      overtime_cost: 270,
      rate: 30,
      overtime_multiplier: 1.5,
    })).toBe(67.5);
  });

  test('falls back to base rate times multiplier for legacy report data', () => {
    expect(overtimeDisplayRate({
      overtime_total: 2,
      rate: 30,
      overtime_multiplier: 2,
    })).toBe(60);
  });
});
