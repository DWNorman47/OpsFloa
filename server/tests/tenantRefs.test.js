jest.mock('../db', () => ({ query: jest.fn() }));

const pool = require('../db');
const { projectBelongsToCompany, userBelongsToCompany } = require('../utils/tenantRefs');

beforeEach(() => pool.query.mockReset());

test('project lookup includes the caller company', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1 });
  await expect(projectBelongsToCompany(pool, 17, 'co-1')).resolves.toBe(true);
  expect(pool.query).toHaveBeenCalledWith(
    'SELECT 1 FROM projects WHERE id = $1 AND company_id = $2',
    [17, 'co-1']
  );
});

test('user lookup rejects a user outside the caller company', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0 });
  await expect(userBelongsToCompany(pool, 42, 'co-1')).resolves.toBe(false);
  expect(pool.query).toHaveBeenCalledWith(
    'SELECT 1 FROM users WHERE id = $1 AND company_id = $2',
    [42, 'co-1']
  );
});

test('empty optional references do not query the database', async () => {
  await expect(projectBelongsToCompany(pool, null, 'co-1')).resolves.toBe(true);
  await expect(userBelongsToCompany(pool, '', 'co-1')).resolves.toBe(true);
  expect(pool.query).not.toHaveBeenCalled();
});
