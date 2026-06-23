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

  it('marks a guide ready when modules and permissions line up', () => {
    const task = findGuideTask('create-subcontractor-po');
    const availability = getGuideTaskAvailability(task, adminUser, { module_projects: true });

    expect(availability.ready).toBe(true);
  });

  it('warns when the required company module is off', () => {
    const task = findGuideTask('create-subcontractor-po');
    const availability = getGuideTaskAvailability(task, adminUser, { module_projects: false });

    expect(availability.ready).toBe(false);
    expect(availability.missingModules).toContain('Projects');
  });
});
