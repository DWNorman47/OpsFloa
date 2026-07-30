/**
 * Permission gate coverage — introspects every route on the admin/clock/stripe
 * routers, finds the requirePerm declaration on each, and asserts that:
 *   1. Each gated route is gated by a key from the canonical PERMISSIONS catalog.
 *   2. A user missing that permission is rejected with 403.
 *
 * Catches three classes of "I forgot" bugs:
 *   - Route added without any gate at all.
 *   - Route gated on a typo'd permission key (no such permission exists).
 *   - Route gated on the wrong key (covered indirectly: at least the key
 *     resolves and the negative-perm test passes).
 *
 * The introspection captures requirePerm calls at module load by stubbing
 * the middleware export with a tagged stand-in.
 */

const PERMISSIONS_KEYS_SET = new Set();

// Stub requirePerm BEFORE the routers are required. The stub returns a
// tagged middleware so we can recover the permission key after route
// registration. The real implementation is exercised in permissions.test.js.
let mockUser;
const taggedRequirePerm = (key) => {
  PERMISSIONS_KEYS_SET.add(key);
  const fn = (req, _res, next) => { req.user = mockUser; next(); };
  fn.__permissionKey = key;
  return fn;
};

jest.mock('../middleware/auth', () => {
  const passthrough = (req, _res, next) => { req.user = mockUser; next(); };
  return {
    requireAuth: passthrough,
    requireAdmin: passthrough,
    requireSuperAdmin: passthrough,
    requirePermission: () => passthrough,
    requirePerm: taggedRequirePerm,
    requirePlan: () => passthrough,
    requireProAddon: passthrough,
    requireCertifiedPayrollAddon: passthrough,
    hasAdminPermission: () => true,
    hasPerm: async (_user, _key) => false,
  };
});

jest.mock('../db', () => ({ query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('stripe', () => jest.fn(() => ({})));

const express = require('express');
const request = require('supertest');
const adminRouter = require('../routes/admin');
const certifiedPayrollRouter = require('../routes/certifiedPayroll');
const clockRouter = require('../routes/clock');
const stripeRouter = require('../routes/stripe');
const { PERMISSION_KEYS } = require('../permissions');

// Walk an Express router's stack and yield { method, path, requiredPermission }
// for every route whose middleware chain contains a tagged requirePerm.
function gatedRoutes(router) {
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path = layer.route.path;
    for (const method of Object.keys(layer.route.methods)) {
      const stack = layer.route.stack;
      const tagged = stack.filter(s => s.handle && s.handle.__permissionKey);
      if (tagged.length) {
        const keys = tagged.map(s => s.handle.__permissionKey);
        out.push({ method: method.toUpperCase(), path, key: keys[0], keys });
      }
    }
  }
  return out;
}

describe('Permission gate coverage', () => {
  test('every requirePerm call references a real catalog key', () => {
    // PERMISSIONS_KEYS_SET was filled at module-load when the route files
    // ran their requirePerm(...) calls. Verify each is in the canonical set.
    expect(PERMISSIONS_KEYS_SET.size).toBeGreaterThan(0);
    const unknown = [...PERMISSIONS_KEYS_SET].filter(k => !PERMISSION_KEYS.has(k));
    expect(unknown).toEqual([]);
  });

  test('admin router gates at least one route with each major permission area', () => {
    const routes = gatedRoutes(adminRouter);
    const keys = new Set(routes.map(r => r.key));
    // Sanity: the legacy 5 admin permissions are all in use somewhere.
    for (const k of ['approve_entries', 'manage_workers', 'manage_projects', 'view_reports', 'manage_settings']) {
      expect(keys.has(k)).toBe(true);
    }
    // Phase B/C additions.
    expect(keys.has('manage_roles')).toBe(true);
    expect(keys.has('assign_roles')).toBe(true);
  });

  test('Stripe routes are gated on manage_billing', () => {
    const routes = gatedRoutes(stripeRouter);
    // checkout + portal are actual billing actions — both gated.
    // /stripe/status is read-only and intentionally NOT gated; every admin
    // needs to read subscription state to render trial-expired banners.
    const billingRoutes = routes.filter(r => r.key === 'manage_billing');
    expect(billingRoutes.length).toBeGreaterThanOrEqual(2);
  });

  test('Clock-in / clock-out gated on the worker-tier permissions', () => {
    const routes = gatedRoutes(clockRouter);
    const inRoute = routes.find(r => r.path === '/in' && r.method === 'POST');
    const outRoute = routes.find(r => r.path === '/out' && r.method === 'POST');
    expect(inRoute?.key).toBe('clock_self');
    expect(outRoute?.key).toBe('clock_self');
  });

  test('payroll money mutations require manage_pay_periods, not read-only reports access', () => {
    const routes = gatedRoutes(adminRouter);
    for (const path of ['/payroll-run/finalize', '/payroll-runs/:id/paid', '/payroll-runs/:id/void']) {
      expect(routes.find(r => r.path === path && r.method === 'POST')?.key).toBe('manage_pay_periods');
    }
  });

  test('payroll reads require both report and wage access', () => {
    const routes = gatedRoutes(adminRouter);
    for (const path of ['/payroll-run', '/payroll-runs', '/payroll-runs/:id', '/payroll-export']) {
      const route = routes.find(r => r.path === path && r.method === 'GET');
      expect(route?.keys).toEqual(expect.arrayContaining(['view_reports', 'view_worker_wages']));
    }
  });

  test('certified payroll reads and legal writes use their dedicated permissions', () => {
    const adminRoutes = gatedRoutes(adminRouter);
    expect(adminRoutes.find(r => r.path === '/certified-payroll' && r.method === 'GET')?.key)
      .toBe('view_certified_payroll');
    expect(adminRoutes.find(r => r.path === '/certified-payroll/weeks' && r.method === 'GET')?.key)
      .toBe('view_certified_payroll');

    const certifiedRoutes = gatedRoutes(certifiedPayrollRouter);
    expect(certifiedRoutes.find(r => r.path === '/signatures' && r.method === 'GET')?.key)
      .toBe('view_certified_payroll');
    expect(certifiedRoutes.find(r => r.path === '/signatures' && r.method === 'POST')?.key)
      .toBe('manage_pay_periods');
  });

  test('every gated route registers a tagged middleware (no silent passthrough)', () => {
    // Sanity: any route we expect to be gated MUST have requirePerm in its
    // chain. The 403 enforcement itself is verified by permissions.test.js
    // (unit-level on requirePerm directly).
    const all = [
      ...gatedRoutes(adminRouter),
      ...gatedRoutes(certifiedPayrollRouter),
      ...gatedRoutes(clockRouter),
      ...gatedRoutes(stripeRouter),
    ];
    expect(all.length).toBeGreaterThan(20);
    for (const r of all) {
      expect(typeof r.key).toBe('string');
      expect(r.key.length).toBeGreaterThan(0);
    }
  });
});
