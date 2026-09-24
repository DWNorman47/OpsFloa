// index.js isn't importable (it listens on load), so guard the mount order
// statically. A bare `app.use('/api', requireAuth, requirePlan(...), ...)`
// runs its middleware for EVERY /api/* request that reaches it — any
// all-plans route registered after it answers 403 plan_required for
// starter/free companies. That shipped once for /api/settings.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

describe('index.js /api mount order', () => {
  const bareGated = /app\.use\('\/api',\s*requireAuth,\s*requirePlan\(/g;

  test('exactly one bare /api plan-gated mount', () => {
    expect(src.match(bareGated)).toHaveLength(1);
  });

  test.each([
    "app.get('/api/settings'",
    "app.get('/api/company-info'",
    "app.use('/api/availability'",
  ])('%s is registered before the bare plan-gated /api mount', (needle) => {
    const at = src.indexOf(needle);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.search(bareGated));
  });

  test('no route is registered after the bare plan-gated /api mount', () => {
    const tail = src.slice(src.search(bareGated));
    const laterRoutes = tail.match(/app\.(get|post|put|patch|delete|use)\('\/api/g) || [];
    expect(laterRoutes).toHaveLength(1); // the mount itself
  });
});
