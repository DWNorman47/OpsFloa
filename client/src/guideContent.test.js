import { describe, expect, it } from 'vitest';
import {
  filterGuideTasks,
  findGuideTask,
  getGuideTaskAvailability,
} from './guideContent';

const adminUser = {
  role: 'admin',
  permissions: ['manage_projects', 'manage_settings', 'manage_inventory'],
};

describe('guideContent', () => {
  it('finds the subcontractor PO guide from plain language', () => {
    const results = filterGuideTasks('make a po for a subcontractor', 'projects');

    expect(results[0].id).toBe('create-subcontractor-po');
  });

  it('prioritizes purchase order guides for short PO searches', () => {
    const results = filterGuideTasks('PO', 'timeclock');
    const topIds = results.slice(0, 4).map(task => task.id);

    expect(topIds).toContain('create-subcontractor-po');
    expect(topIds).toContain('record-subcontractor-payment');
    expect(topIds).toContain('create-inventory-po');
    expect(topIds).toContain('receive-inventory-po');
    expect(results.findIndex(task => task.id === 'lock-pay-period')).toBe(-1);
    expect(results.findIndex(task => task.id === 'run-payroll-export')).toBe(-1);
  });

  it('marks a guide ready when modules and permissions line up', () => {
    const task = findGuideTask('create-subcontractor-po');
    const availability = getGuideTaskAvailability(task, adminUser, { module_projects: true });

    expect(availability.ready).toBe(true);
  });

  it('treats null feature settings as enabled while pages load', () => {
    const task = findGuideTask('create-project');
    const availability = getGuideTaskAvailability(task, adminUser, null);

    expect(availability.ready).toBe(true);
  });

  it('warns when the required company module is off', () => {
    const task = findGuideTask('create-subcontractor-po');
    const availability = getGuideTaskAvailability(task, adminUser, { module_projects: false });

    expect(availability.ready).toBe(false);
    expect(availability.missingModules).toContain('Projects');
  });
});
