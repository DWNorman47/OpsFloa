async function projectBelongsToCompany(db, projectId, companyId) {
  if (projectId == null || projectId === '') return true;
  const result = await db.query(
    'SELECT 1 FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return result.rowCount > 0;
}

async function userBelongsToCompany(db, userId, companyId) {
  if (userId == null || userId === '') return true;
  const result = await db.query(
    'SELECT 1 FROM users WHERE id = $1 AND company_id = $2',
    [userId, companyId]
  );
  return result.rowCount > 0;
}

async function clientBelongsToCompany(db, clientId, companyId) {
  if (clientId == null || clientId === '') return true;
  const result = await db.query(
    'SELECT 1 FROM clients WHERE id = $1 AND company_id = $2',
    [clientId, companyId]
  );
  return result.rowCount > 0;
}

module.exports = { projectBelongsToCompany, userBelongsToCompany, clientBelongsToCompany };
