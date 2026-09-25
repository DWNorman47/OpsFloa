import { describe, expect, test } from 'vitest';
import { overtimeDisplayRate, wh347SummaryCells } from './CertifiedPayrollPDF';

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

describe('WH-347 deductions / net / gross-all-work cells (29 CFR 5.5(a)(3)(i))', () => {
  test('first classification row carries the worker summary', () => {
    expect(wh347SummaryCells({
      worker_summary: {
        gross_this_project: 360, gross_all_work: 1560, net_wages: 1200,
        deductions: { fica: 119.34, withholding: 200, other: 40.66, total: 360 },
      },
    })).toEqual({ grossAll: '1560.00', fica: '119.34', withholding: '200.00', other: '40.66', totalDed: '360.00', net: '1200.00' });
  });

  test('later classification rows (no summary) render blank cells', () => {
    expect(wh347SummaryCells({ worker_summary: null })).toEqual({ grossAll: '', fica: '', withholding: '', other: '', totalDed: '', net: '' });
  });
});
