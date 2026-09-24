import { describe, expect, test } from 'vitest';
import { workOrderDisplayName, toLocalInput, fromLocalInput, changedWorkOrderFields } from './WorkOrdersPanel';

describe('workOrderDisplayName', () => {
  test('uses the full_name returned by the workers API', () => {
    expect(workOrderDisplayName({ id: 7, full_name: 'Jordan Lee' })).toBe('Jordan Lee');
  });

  test('continues to support named customers and projects', () => {
    expect(workOrderDisplayName({ id: 9, name: 'Atlas Fleet' })).toBe('Atlas Fleet');
  });
});


describe('work order datetime-local conversion', () => {
  test('toLocalInput renders a UTC timestamp in local wall-clock time', () => {
    const iso = '2026-09-20T15:30:00.000Z';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(toLocalInput(iso)).toBe(expected);
    expect(toLocalInput(null)).toBe('');
  });

  test('fromLocalInput sends an absolute ISO instant (round-trips with toLocalInput)', () => {
    const local = '2026-09-20T08:15';
    const iso = fromLocalInput(local);
    expect(iso).toBe(new Date(local).toISOString());
    expect(toLocalInput(iso)).toBe(local);
    expect(fromLocalInput('')).toBeNull();
  });
});

describe('changedWorkOrderFields', () => {
  test('only includes fields that differ from the opened snapshot', () => {
    const initial = { title: 'A', status: 'open', priority: 'normal', scheduled_at: '2026-09-20T08:15', amount: '' };
    const form = { ...initial, priority: 'high' };
    expect(changedWorkOrderFields(initial, form)).toEqual({ priority: 'high' });
  });

  test('converts a changed scheduled_at to ISO', () => {
    const initial = { scheduled_at: '' };
    const form = { scheduled_at: '2026-09-20T08:15' };
    expect(changedWorkOrderFields(initial, form)).toEqual({ scheduled_at: new Date('2026-09-20T08:15').toISOString() });
  });
});
