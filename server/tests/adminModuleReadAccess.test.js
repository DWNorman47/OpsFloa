const fs = require('fs');
const path = require('path');

test('admin-only module reads do not fall back to authentication alone', () => {
  const files = {
    subcontractors: fs.readFileSync(path.join(__dirname, '../routes/subcontractors.js'), 'utf8'),
    lienWaivers: fs.readFileSync(path.join(__dirname, '../routes/lienWaivers.js'), 'utf8'),
    submittals: fs.readFileSync(path.join(__dirname, '../routes/submittals.js'), 'utf8'),
    closeout: fs.readFileSync(path.join(__dirname, '../routes/closeout.js'), 'utf8'),
  };

  expect(files.subcontractors).toContain("router.get('/subcontractors', requireAdmin");
  expect(files.subcontractors).toContain("router.get('/subcontractors/compliance', requireAdmin");
  expect(files.lienWaivers).toContain("router.get('/lien-waivers', requireAdmin");
  expect(files.lienWaivers).toContain("router.get('/lien-waivers/:id', requireAdmin");
  expect(files.submittals).toContain("router.get('/submittals', requireAdmin");
  expect(files.submittals).toContain("router.get('/submittals/:id', requireAdmin");
  expect(files.closeout).toContain("router.get('/closeout-template', requireAdmin");
  expect(files.closeout).toContain("router.get('/projects/:id/closeout', requireAdmin");
  expect(files.closeout).toContain("router.get('/warranties-expiring', requireAdmin");
});
