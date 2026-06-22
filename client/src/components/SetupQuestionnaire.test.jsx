import { describe, expect, it } from 'vitest';
import { buildSetupSettings } from './SetupQuestionnaire';

const labels = {
  work: 'Job',
  client: 'Client',
  worker: 'Employee',
  field: 'Service',
};

describe('buildSetupSettings', () => {
  it('keeps a people-only workspace focused', () => {
    const settings = buildSetupSettings({
      work: ['people'],
      team: ['time'],
      manager: ['essentials'],
      labels,
    });

    expect(settings).toMatchObject({
      module_timeclock: true,
      module_team: true,
      module_projects: false,
      module_field: false,
      module_inventory: false,
      module_analytics: false,
      module_financial_reports: false,
      feature_project_integration: false,
      feature_scheduling: false,
      feature_chat: false,
      feature_geolocation: false,
      feature_overtime: false,
      label_work: 'Job',
      label_client: 'Client',
      label_worker: 'Employee',
      label_field: 'Service',
    });
  });

  it('enables the connected tools selected for a broad operation', () => {
    const settings = buildSetupSettings({
      work: ['field', 'inventory', 'people'],
      team: ['time', 'scheduling', 'expenses', 'location'],
      manager: ['performance', 'financial', 'overtime', 'media'],
      labels,
    });

    expect(settings).toMatchObject({
      module_timeclock: true,
      module_team: true,
      module_projects: true,
      module_field: true,
      module_inventory: true,
      module_analytics: true,
      module_financial_reports: true,
      feature_project_integration: true,
      feature_scheduling: true,
      feature_reimbursements: true,
      feature_geolocation: true,
      feature_media_gallery: true,
      feature_overtime: true,
      feature_overtime_alerts: true,
    });
  });

  it('turns projects on when financial project reporting is selected', () => {
    const settings = buildSetupSettings({
      work: ['people'],
      team: ['admin_only'],
      manager: ['financial'],
      labels,
    });

    expect(settings.module_projects).toBe(true);
    expect(settings.module_financial_reports).toBe(true);
    expect(settings.feature_project_integration).toBe(false);
  });

  it('does not force on the time clock when people and time is selected', () => {
    const settings = buildSetupSettings({
      work: ['people'],
      team: ['admin_only'],
      manager: ['essentials'],
      labels,
    });

    expect(settings.module_team).toBe(true);
    expect(settings.module_timeclock).toBe(false);
  });

  it('keeps shared media off without field work', () => {
    const settings = buildSetupSettings({
      work: ['projects', 'people'],
      team: ['time'],
      manager: ['media'],
      labels,
    });

    expect(settings.module_field).toBe(false);
    expect(settings.feature_media_gallery).toBe(false);
  });
});
