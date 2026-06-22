const {
  CLOSEOUT_STATUSES,
  CLOSEOUT_TERMINAL_STATUSES,
  CLOSEOUT_ITEM_STATUSES,
  CLOSEOUT_ITEM_DONE_STATUSES,
  CLOSEOUT_ITEM_CATEGORIES,
  DEFAULT_CHECKLIST,
} = require('../constants/closeoutEnums');

describe('CLOSEOUT_STATUSES', () => {
  test('matches the migration 0111 CHECK constraint', () => {
    expect([...CLOSEOUT_STATUSES].sort()).toEqual(
      ['closed', 'final_complete', 'in_progress', 'open', 'reopened', 'substantially_complete']
    );
  });
  test('is frozen', () => {
    expect(Object.isFrozen(CLOSEOUT_STATUSES)).toBe(true);
  });
});

describe('CLOSEOUT_TERMINAL_STATUSES', () => {
  test('contains exactly closed (the only truly terminal state)', () => {
    expect([...CLOSEOUT_TERMINAL_STATUSES]).toEqual(['closed']);
  });
  test('every value is a valid status', () => {
    for (const s of CLOSEOUT_TERMINAL_STATUSES) {
      expect(CLOSEOUT_STATUSES).toContain(s);
    }
  });
});

describe('CLOSEOUT_ITEM_STATUSES', () => {
  test('matches the migration 0111 CHECK constraint', () => {
    expect([...CLOSEOUT_ITEM_STATUSES].sort()).toEqual(
      ['done', 'in_progress', 'n_a', 'pending', 'waived']
    );
  });
});

describe('CLOSEOUT_ITEM_DONE_STATUSES', () => {
  test('contains done + waived + n_a (the three that count as complete for gating)', () => {
    expect([...CLOSEOUT_ITEM_DONE_STATUSES].sort()).toEqual(['done', 'n_a', 'waived']);
  });
  test('every value is a valid item status', () => {
    for (const s of CLOSEOUT_ITEM_DONE_STATUSES) {
      expect(CLOSEOUT_ITEM_STATUSES).toContain(s);
    }
  });
  test('does NOT include in_progress (that does not satisfy gating)', () => {
    expect(CLOSEOUT_ITEM_DONE_STATUSES).not.toContain('in_progress');
  });
});

describe('CLOSEOUT_ITEM_CATEGORIES', () => {
  test('matches the migration 0111 CHECK constraint', () => {
    expect([...CLOSEOUT_ITEM_CATEGORIES].sort()).toEqual(
      ['as_builts', 'certificate_substantial', 'custom', 'final_inspection',
       'final_invoice', 'lien_waiver_to_owner', 'lien_waivers_subs',
       'o_and_m', 'punchlist', 'retainage_release', 'warranty']
    );
  });
});

describe('DEFAULT_CHECKLIST', () => {
  test('seeds 10 items by default (matches plan)', () => {
    expect(DEFAULT_CHECKLIST).toHaveLength(10);
  });

  test('every item has a category that is a valid CLOSEOUT_ITEM_CATEGORIES value', () => {
    for (const item of DEFAULT_CHECKLIST) {
      expect(CLOSEOUT_ITEM_CATEGORIES).toContain(item.category);
    }
  });

  test('items are unique by category (default checklist has no duplicates)', () => {
    const cats = DEFAULT_CHECKLIST.map(i => i.category);
    expect(new Set(cats).size).toBe(cats.length);
  });

  test('sort_order is monotonically increasing (renders in defined order)', () => {
    for (let i = 1; i < DEFAULT_CHECKLIST.length; i++) {
      expect(DEFAULT_CHECKLIST[i].sort_order).toBeGreaterThan(DEFAULT_CHECKLIST[i - 1].sort_order);
    }
  });

  test('every item has either an auto_source or no auto_source (no malformed entries)', () => {
    for (const item of DEFAULT_CHECKLIST) {
      expect(item).toHaveProperty('category');
      expect(item).toHaveProperty('title');
      // auto_source is optional but must be a string when present
      if (item.auto_source !== undefined && item.auto_source !== null) {
        expect(typeof item.auto_source).toBe('string');
      }
    }
  });

  test('punchlist and lien_waivers items have auto_source set (read live from other modules)', () => {
    const punchlist = DEFAULT_CHECKLIST.find(i => i.category === 'punchlist');
    expect(punchlist?.auto_source).toBe('punchlist');
    const subsWaivers = DEFAULT_CHECKLIST.find(i => i.category === 'lien_waivers_subs');
    expect(subsWaivers?.auto_source).toBe('lien_waivers');
    const ownerWaiver = DEFAULT_CHECKLIST.find(i => i.category === 'lien_waiver_to_owner');
    expect(ownerWaiver?.auto_source).toBe('lien_waivers');
    const finalInvoice = DEFAULT_CHECKLIST.find(i => i.category === 'final_invoice');
    expect(finalInvoice?.auto_source).toBe('invoices');
    const retainage = DEFAULT_CHECKLIST.find(i => i.category === 'retainage_release');
    expect(retainage?.auto_source).toBe('invoices');
  });
});
