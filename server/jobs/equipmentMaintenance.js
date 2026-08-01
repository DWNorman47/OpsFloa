const cron = require('node-cron');
const pool = require('../db');
const logger = require('../logger');
const { sendPushToCompanyAdmins } = require('../push');
const { createInboxItem } = require('../routes/inbox');
const { runJob } = require('./runJob');

async function checkEquipmentMaintenance() {
  // Get all active companies
  const companies = await pool.query(`
      SELECT id, name FROM companies
      WHERE subscription_status IN ('trial', 'active')
    `);

    for (const company of companies.rows) {
      const { id: companyId } = company;
      // Isolate each company: one company's failure must not abort the batch, and must not
      // throw out to runJob — a whole-job retry would re-alert every company already processed.
      try {
      // Find equipment that has reached or exceeded its maintenance interval
      const overdue = await pool.query(`
        SELECT e.id,
               e.name,
               COALESCE(SUM(h.hours), 0)::DECIMAL(10,2) AS total_hours,
               e.maintenance_interval_hours
        FROM equipment_items e
        LEFT JOIN equipment_hours h ON h.equipment_id = e.id
        WHERE e.company_id = $1
          AND e.active = true
          AND e.maintenance_interval_hours IS NOT NULL
          AND e.maintenance_interval_hours > 0
        GROUP BY e.id, e.name, e.maintenance_interval_hours
        HAVING COALESCE(SUM(h.hours), 0) >= e.maintenance_interval_hours
      `, [companyId]);

      if (overdue.rowCount === 0) continue;

      const count = overdue.rowCount;
      const names = overdue.rows.map(r => r.name).join(', ');
      const alertTitle = `${count} equipment item${count !== 1 ? 's' : ''} due for maintenance`;
      const alertBody = `${names} ${count !== 1 ? 'have' : 'has'} reached the maintenance interval`;

      await sendPushToCompanyAdmins(companyId, {
        title: alertTitle,
        body: alertBody,
        url: '/inventory#eq-assets',
      });

      const adminRows = await pool.query(
        `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
        [companyId]
      );
      for (const a of adminRows.rows) {
        createInboxItem(a.id, companyId, 'equipment_maintenance', alertTitle, alertBody, '/inventory#eq-assets');
      }
      } catch (err) {
        logger.error({ err, companyId }, 'equipmentMaintenance: company failed, continuing');
      }
    }
}

function startEquipmentMaintenanceJob() {
  // Run at 8 AM server time every day
  cron.schedule('0 8 * * *', () => runJob('equipmentMaintenance', checkEquipmentMaintenance));
}

module.exports = { startEquipmentMaintenanceJob };
