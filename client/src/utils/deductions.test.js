import { describe, expect, it } from 'vitest';
import { deductionId } from './deductions';

describe('deductionId', () => {
  it('preserves explicit ids', () => {
    expect(deductionId({ id: 'tax-1', name: 'Tax', kind: 'percent', value: 5 })).toBe('tax-1');
  });

  it('matches the server fallback for an id-less legacy deduction', () => {
    expect(deductionId({ name: 'Union dues', kind: 'fixed', value: 20 }))
      .toBe('legacy:Union dues:fixed:20');
  });
});
