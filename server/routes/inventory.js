const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth, requirePerm, hasPerm } = require('../middleware/auth');
const { escapeHtml } = require('../utils/htmlEscape');
const { formatCurrency, companyCurrency } = require('../currency');
const { uploadBase64 } = require('../r2');
const { checkStorageLimit, incrementStorage } = require('../storage');
const { sendPushToCompanyAdmins } = require('../push');
const { createInboxItemBatch } = require('./inbox');
const { getAdvancedSettings, ADVANCED_DEFAULTS } = require('./admin');
const { applySettingsRows, ADMIN_SETTINGS_DEFAULTS } = require('../settingsDefaults');
const { logAudit } = require('../auditLog');
const { coerceBody } = require('../middleware/coerce');
const { INVENTORY_COUNT_TYPES } = require('../constants/inventoryEnums');

const TXN_COERCE = coerceBody({
  int: ['item_id', 'from_location_id', 'to_location_id', 'uom_id', 'to_uom_id',
        'area_id', 'rack_id', 'bay_id', 'compartment_id', 'project_id', 'supplier_id'],
  float: ['quantity', 'to_quantity', 'unit_cost'],
});

// GET /api/inventory/units — active units for this company
router.get('/units', requireAuth, requireInventoryView, async (req, res) => {
  try {
    const all = await getAdvancedSettings(req.user.company_id);
    const cfg = all.item_units;
    const active = [
      ...cfg.defaults.filter(u => !cfg.suppressed.includes(u)),
      ...cfg.custom,
    ];
    const known = [...cfg.defaults, ...cfg.custom];
    res.json({ active, known });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAdmin(req) {
  return req.user.role === 'admin' || req.user.role === 'super_admin';
}

async function requireInventoryView(req, res, next) {
  try {
    const canManage = await hasPerm(req, 'manage_inventory');
    const canView = canManage || await hasPerm(req, 'view_inventory');
    if (!canView) return res.status(403).json({ error: 'Permission denied', code: 'missing_permission' });
    req.canManageInventory = canManage;
    next();
  } catch (err) {
    req.log?.error({ err }, 'inventory permission check failed');
    res.status(500).json({ error: 'Server error' });
  }
}

async function validateProjectRef(client, companyId, projectId) {
  if (!projectId) return true;
  const result = await client.query(
    'SELECT id FROM projects WHERE id=$1 AND company_id=$2',
    [projectId, companyId]
  );
  return result.rowCount > 0;
}

async function validateBinRefs(client, companyId, locationId, bin = {}) {
  const ids = {
    area_id: bin.area_id ? parseInt(bin.area_id) : null,
    rack_id: bin.rack_id ? parseInt(bin.rack_id) : null,
    bay_id: bin.bay_id ? parseInt(bin.bay_id) : null,
    compartment_id: bin.compartment_id ? parseInt(bin.compartment_id) : null,
  };
  if (Object.values(ids).some(v => v !== null && (!Number.isInteger(v) || v <= 0))) return false;

  let areaId = ids.area_id;
  let rackId = ids.rack_id;
  let bayId = ids.bay_id;

  if (ids.compartment_id) {
    const r = await client.query(
      `SELECT c.bay_id, b.rack_id, r.area_id, a.location_id
         FROM inventory_compartments c
         JOIN inventory_bays b ON b.id=c.bay_id
         JOIN inventory_racks r ON r.id=b.rack_id
         JOIN inventory_areas a ON a.id=r.area_id
        WHERE c.id=$1 AND c.company_id=$2`,
      [ids.compartment_id, companyId]
    );
    if (!r.rowCount || (locationId && Number(r.rows[0].location_id) !== Number(locationId))) return false;
    if (bayId && Number(r.rows[0].bay_id) !== bayId) return false;
    if (rackId && Number(r.rows[0].rack_id) !== rackId) return false;
    if (areaId && Number(r.rows[0].area_id) !== areaId) return false;
    bayId ||= Number(r.rows[0].bay_id);
    rackId ||= Number(r.rows[0].rack_id);
    areaId ||= Number(r.rows[0].area_id);
  }
  if (bayId) {
    const r = await client.query(
      `SELECT b.rack_id, r.area_id, a.location_id
         FROM inventory_bays b
         JOIN inventory_racks r ON r.id=b.rack_id
         JOIN inventory_areas a ON a.id=r.area_id
        WHERE b.id=$1 AND b.company_id=$2`,
      [bayId, companyId]
    );
    if (!r.rowCount || (locationId && Number(r.rows[0].location_id) !== Number(locationId))) return false;
    if (rackId && Number(r.rows[0].rack_id) !== rackId) return false;
    if (areaId && Number(r.rows[0].area_id) !== areaId) return false;
    rackId ||= Number(r.rows[0].rack_id);
    areaId ||= Number(r.rows[0].area_id);
  }
  if (rackId) {
    const r = await client.query(
      `SELECT r.area_id, a.location_id
         FROM inventory_racks r
         JOIN inventory_areas a ON a.id=r.area_id
        WHERE r.id=$1 AND r.company_id=$2`,
      [rackId, companyId]
    );
    if (!r.rowCount || (locationId && Number(r.rows[0].location_id) !== Number(locationId))) return false;
    if (areaId && Number(r.rows[0].area_id) !== areaId) return false;
    areaId ||= Number(r.rows[0].area_id);
  }
  if (areaId) {
    const r = await client.query(
      'SELECT location_id FROM inventory_areas WHERE id=$1 AND company_id=$2',
      [areaId, companyId]
    );
    if (!r.rowCount || (locationId && Number(r.rows[0].location_id) !== Number(locationId))) return false;
  }
  return true;
}

// Apply a signed quantity delta to inventory_stock atomically.
// delta is positive to add, negative to subtract.
// bin    = { area_id, rack_id, bay_id, compartment_id } — optional FK IDs
// uomId  = inventory_item_uoms.id — null means item's primary unit (no UOM row)
// Must be called inside a BEGIN/COMMIT block.
async function applyStockDelta(client, companyId, itemId, locationId, delta, bin = {}, uomId = null) {
  const area_id        = bin.area_id        ? parseInt(bin.area_id)        : null;
  const rack_id        = bin.rack_id        ? parseInt(bin.rack_id)        : null;
  const bay_id         = bin.bay_id         ? parseInt(bin.bay_id)         : null;
  const compartment_id = bin.compartment_id ? parseInt(bin.compartment_id) : null;
  const uom            = uomId              ? parseInt(uomId)              : null;
  await client.query(
    `INSERT INTO inventory_stock
       (company_id, item_id, location_id, uom_id, quantity, area_id, rack_id, bay_id, compartment_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (item_id, location_id, (COALESCE(uom_id, 0)))
     DO UPDATE SET
       quantity       = inventory_stock.quantity + EXCLUDED.quantity,
       area_id        = COALESCE(EXCLUDED.area_id,        inventory_stock.area_id),
       rack_id        = COALESCE(EXCLUDED.rack_id,        inventory_stock.rack_id),
       bay_id         = COALESCE(EXCLUDED.bay_id,         inventory_stock.bay_id),
       compartment_id = COALESCE(EXCLUDED.compartment_id, inventory_stock.compartment_id),
       updated_at     = NOW()`,
    [companyId, itemId, locationId, uom, delta, area_id, rack_id, bay_id, compartment_id]
  );
}

// When issuing/transferring out using a UOM that has no stock row at this location,
// find the UOM that does have stock and convert the quantity automatically.
// e.g. stock is in 'box' (factor=30), user issues 9 'each' (factor=1) →
//      converts to 9 × (1/30) = 0.3 box and subtracts from the box row.
// Must be called inside a BEGIN/COMMIT block.
async function autoConvertIssueUom(client, companyId, itemId, locationId, requestedUomId, qty) {
  if (!requestedUomId) return { uomId: null, qty }; // base unit — no conversion needed

  // Check if stock already exists for the requested UOM at this location
  const ownRow = await client.query(
    `SELECT quantity FROM inventory_stock
     WHERE item_id=$1 AND location_id=$2 AND company_id=$3 AND uom_id=$4`,
    [itemId, locationId, companyId, requestedUomId]
  );
  if (ownRow.rowCount > 0) return { uomId: requestedUomId, qty }; // has its own row, use it directly

  // No row for requested UOM — find the UOM that actually has stock here
  const other = await client.query(
    `SELECT s.uom_id,
            COALESCE(su.factor, 1) AS stock_factor,
            ru.factor              AS req_factor
     FROM inventory_stock s
     LEFT JOIN inventory_item_uoms su ON s.uom_id = su.id
     JOIN  inventory_item_uoms ru ON ru.id = $4
     WHERE s.item_id=$1 AND s.location_id=$2 AND s.company_id=$3
       AND s.uom_id IS NOT NULL
     ORDER BY s.quantity DESC LIMIT 1`,
    [itemId, locationId, companyId, requestedUomId]
  );
  if (other.rowCount === 0) return { uomId: requestedUomId, qty }; // can't resolve, leave as-is

  const { uom_id, stock_factor, req_factor } = other.rows[0];
  // qty_in_stock_uom = qty_in_requested_uom × (req_factor / stock_factor)
  const convertedQty = qty * (parseFloat(req_factor) / parseFloat(stock_factor));
  return { uomId: uom_id, qty: convertedQty };
}

// Fire low-stock push + inbox notification to admins when stock falls at/below reorder_point.
// Called after COMMIT so it never blocks the transaction.
async function maybeSendLowStockAlert(companyId, itemId) {
  try {
    const r = await pool.query(
      `SELECT i.name, i.reorder_point, COALESCE(SUM(s.quantity), 0) AS total_qty
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON i.id = s.item_id AND s.company_id = i.company_id
       WHERE i.id = $1 AND i.company_id = $2 AND i.active = true
       GROUP BY i.id`,
      [itemId, companyId]
    );
    if (r.rowCount === 0) return;
    const { name, reorder_point, total_qty } = r.rows[0];
    const rp = parseFloat(reorder_point);
    const qty = parseFloat(total_qty);
    if (rp <= 0 || qty > rp) return; // not low
    const isOut = qty <= 0;
    const title = isOut ? `Out of stock: ${name}` : `Low stock: ${name}`;
    const body  = isOut
      ? `${name} is out of stock. Reorder point: ${rp}.`
      : `${name} has ${qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)} units remaining (reorder at ${rp}).`;
    // Push notification
    await sendPushToCompanyAdmins(companyId, { title, body, url: '/inventory#stock' });
    // In-app inbox — get all admin user IDs
    const admins = await pool.query(
      `SELECT id FROM users WHERE company_id=$1 AND role IN ('admin','super_admin') AND active=true`,
      [companyId]
    );
    if (admins.rowCount > 0) {
      await createInboxItemBatch(admins.rows.map(u => u.id), companyId, 'low_stock', title, body, '/inventory#stock');
    }
  } catch (err) {
    logger.error({ err }, 'maybeSendLowStockAlert error');
  }
}

// Process an array of photo values (existing https:// URLs or new base64 data: URIs).
// Uploads any base64 images to R2, tracks storage, returns array of https:// URLs.
async function processPhotos(photos, companyId) {
  if (!photos || photos.length === 0) return [];
  const base64Photos = photos.filter(p => typeof p === 'string' && p.startsWith('data:'));
  if (base64Photos.length > 0) {
    const estimatedBytes = base64Photos.reduce((sum, p) => {
      const b64 = p.split(',')[1] || '';
      return sum + Math.floor(b64.length * 3 / 4);
    }, 0);
    if (estimatedBytes > 0) {
      const { allowed } = await checkStorageLimit(companyId, estimatedBytes);
      if (!allowed) throw Object.assign(new Error('Storage limit reached'), { storageLimit: true });
    }
  }
  return Promise.all(
    photos.map(async p => {
      if (typeof p === 'string' && p.startsWith('data:')) {
        const { url, sizeBytes } = await uploadBase64(p, 'inventory');
        if (sizeBytes > 0) incrementStorage(companyId, sizeBytes).catch(() => {});
        return url;
      }
      return p;
    })
  );
}

// ── Items ─────────────────────────────────────────────────────────────────────

// GET /api/inventory/items
// Paginated when ?limit=N&offset=M → returns { items, total }
// Without limit → returns array (capped at 500, for dropdowns)
router.get('/items', requireAuth, requireInventoryView, async (req, res) => {
  const { search, name_search, sku_search, category, active = 'true', limit, offset, sort = 'name', dir = 'asc' } = req.query;
  const paginate = limit !== undefined;
  const pageLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
  const pageOffset = Math.max(parseInt(offset) || 0, 0);
  const companyId = req.user.company_id;
  const admin = req.canManageInventory;
  try {
    const conditions = ['company_id = $1'];
    const values = [companyId];
    let idx = 2;
    if (active !== 'all') {
      conditions.push(`active = $${idx++}`);
      values.push(active !== 'false');
    }
    if (category) { conditions.push(`category = $${idx++}`); values.push(category); }
    if (search) {
      conditions.push(`(name ILIKE $${idx} OR sku ILIKE $${idx} OR category ILIKE $${idx})`);
      values.push(`%${search}%`); idx++;
    }
    if (name_search) { conditions.push(`name ILIKE $${idx++}`); values.push(`%${name_search}%`); }
    if (sku_search) { conditions.push(`sku ILIKE $${idx++}`); values.push(`%${sku_search}%`); }
    const cols = `id, name, sku, description, category, unit, unit_spec, ${admin ? 'unit_cost,' : ''} reorder_point, reorder_qty, active, created_at`;
    const where = `FROM inventory_items WHERE ${conditions.join(' AND ')}`;
    const sortCols = {
      name: 'name',
      sku: 'sku',
      category: 'category',
      unit: 'unit',
      unit_cost: 'unit_cost',
      reorder_point: 'reorder_point',
      reorder_qty: 'reorder_qty',
      status: 'active',
      created_at: 'created_at',
    };
    const sortCol = sortCols[sort] || sortCols.name;
    const sortDir = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const orderBy = `ORDER BY ${sortCol} ${sortDir} NULLS LAST, name ASC`;
    if (paginate) {
      const [countRes, result] = await Promise.all([
        pool.query(`SELECT COUNT(*) ${where}`, values),
        pool.query(`SELECT ${cols} ${where} ${orderBy} LIMIT $${idx} OFFSET $${idx + 1}`, [...values, pageLimit, pageOffset]),
      ]);
      return res.json({ items: result.rows, total: parseInt(countRes.rows[0].count) });
    }
    const result = await pool.query(`SELECT ${cols} ${where} ${orderBy} LIMIT 500`, values);
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/items
router.post('/items', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { name, sku, description, category, unit = 'each', unit_cost, reorder_point = 0, reorder_qty = 0 } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
  if (sku && sku.trim().length > 100) return res.status(400).json({ error: 'sku too long (max 100 characters)' });
  if (description && description.trim().length > 1000) return res.status(400).json({ error: 'description too long (max 1000 characters)' });
  if (category && category.trim().length > 100) return res.status(400).json({ error: 'category too long (max 100 characters)' });
  if (unit_cost !== undefined && unit_cost !== null && isNaN(parseFloat(unit_cost))) {
    return res.status(400).json({ error: 'unit_cost must be a number' });
  }
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `INSERT INTO inventory_items (company_id, name, sku, description, category, unit, unit_cost, reorder_point, reorder_qty, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [companyId, name.trim(), sku?.trim() || null, description?.trim() || null,
       category?.trim() || null, unit, unit_cost != null ? parseFloat(unit_cost) : null,
       parseInt(reorder_point) || 0, parseInt(reorder_qty) || 0, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SKU already exists for this company' });
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/inventory/items/bulk — batch import of items from a spreadsheet.
// Each row is processed independently; per-row failures don't abort the batch.
// When update_existing is true, rows with a matching SKU overwrite the
// existing item's editable fields. Otherwise duplicates are reported as skipped.
router.post('/items/bulk', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { items, update_existing = false } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array required' });
  }
  if (items.length > 1000) {
    return res.status(400).json({ error: 'Too many rows — import at most 1000 at a time' });
  }
  const companyId = req.user.company_id;
  const imported = [], updated = [], skipped = [];

  for (let i = 0; i < items.length; i++) {
    const row = items[i] || {};
    const rowNum = i + 1;
    const name = (row.name || '').trim();
    const sku  = (row.sku || '').trim() || null;

    if (!name) { skipped.push({ row: rowNum, reason: 'name required' }); continue; }
    if (name.length > 255) { skipped.push({ row: rowNum, name, reason: 'name too long (max 255)' }); continue; }
    if (sku && sku.length > 100) { skipped.push({ row: rowNum, name, reason: 'sku too long (max 100)' }); continue; }

    const description = (row.description || '').trim() || null;
    if (description && description.length > 1000) { skipped.push({ row: rowNum, name, reason: 'description too long (max 1000)' }); continue; }
    const category = (row.category || '').trim() || null;
    if (category && category.length > 100) { skipped.push({ row: rowNum, name, reason: 'category too long (max 100)' }); continue; }

    const unit = (row.unit || '').trim() || 'each';
    const unit_spec = (row.unit_spec || '').trim() || null;
    const unit_cost = row.unit_cost !== '' && row.unit_cost != null && !isNaN(parseFloat(row.unit_cost))
      ? parseFloat(row.unit_cost) : null;
    const reorder_point = parseInt(row.reorder_point) || 0;
    const reorder_qty   = parseInt(row.reorder_qty)   || 0;

    try {
      if (update_existing && sku) {
        const existing = await pool.query(
          'SELECT id FROM inventory_items WHERE company_id=$1 AND sku=$2',
          [companyId, sku]
        );
        if (existing.rowCount > 0) {
          const r = await pool.query(
            `UPDATE inventory_items
                SET name=$3, description=$4, category=$5, unit=$6, unit_spec=$7,
                    unit_cost=$8, reorder_point=$9, reorder_qty=$10, updated_at=NOW()
              WHERE id=$1 AND company_id=$2 RETURNING id, name, sku`,
            [existing.rows[0].id, companyId, name, description, category, unit, unit_spec,
             unit_cost, reorder_point, reorder_qty]
          );
          updated.push(r.rows[0]);
          continue;
        }
      }

      const r = await pool.query(
        `INSERT INTO inventory_items
           (company_id, name, sku, description, category, unit, unit_spec, unit_cost,
            reorder_point, reorder_qty, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, name, sku`,
        [companyId, name, sku, description, category, unit, unit_spec, unit_cost,
         reorder_point, reorder_qty, req.user.id]
      );
      imported.push(r.rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        skipped.push({ row: rowNum, name, sku, reason: 'SKU already exists' });
      } else {
        req.log.error({ err, row: rowNum }, 'bulk import row failed');
        skipped.push({ row: rowNum, name, reason: 'unexpected error' });
      }
    }
  }

  res.json({ imported, updated, skipped });
});

// PATCH /api/inventory/items/:id
router.patch('/items/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { name, sku, description, category, unit, unit_cost, reorder_point, reorder_qty, active } = req.body;
  if (name !== undefined && name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
  if (sku !== undefined && sku && sku.trim().length > 100) return res.status(400).json({ error: 'sku too long (max 100 characters)' });
  if (description !== undefined && description && description.trim().length > 1000) return res.status(400).json({ error: 'description too long (max 1000 characters)' });
  if (category !== undefined && category && category.trim().length > 100) return res.status(400).json({ error: 'category too long (max 100 characters)' });
  if (unit_cost !== undefined && unit_cost !== null && isNaN(parseFloat(unit_cost))) {
    return res.status(400).json({ error: 'unit_cost must be a number' });
  }
  try {
    const existing = await pool.query('SELECT id FROM inventory_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    const sets = [], vals = [req.params.id, companyId]; let idx = 3;
    if (name !== undefined) { sets.push(`name=$${idx++}`); vals.push(name.trim()); }
    if (sku !== undefined) { sets.push(`sku=$${idx++}`); vals.push(sku?.trim() || null); }
    if (description !== undefined) { sets.push(`description=$${idx++}`); vals.push(description?.trim() || null); }
    if (category !== undefined) { sets.push(`category=$${idx++}`); vals.push(category?.trim() || null); }
    if (unit !== undefined) { sets.push(`unit=$${idx++}`); vals.push(unit); }
    if (unit_cost !== undefined) { sets.push(`unit_cost=$${idx++}`); vals.push(unit_cost != null ? parseFloat(unit_cost) : null); }
    if (reorder_point !== undefined) { sets.push(`reorder_point=$${idx++}`); vals.push(parseInt(reorder_point) || 0); }
    if (reorder_qty !== undefined) { sets.push(`reorder_qty=$${idx++}`); vals.push(parseInt(reorder_qty) || 0); }
    if ('unit_spec' in req.body) { sets.push(`unit_spec=$${idx++}`); vals.push(req.body.unit_spec?.trim() || null); }
    if (active !== undefined) { sets.push(`active=$${idx++}`); vals.push(!!active); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    sets.push(`updated_at=NOW()`);
    const result = await pool.query(
      `UPDATE inventory_items SET ${sets.join(',')} WHERE id=$1 AND company_id=$2 RETURNING *`,
      vals
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'SKU already exists for this company' });
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/inventory/items/:id  (soft delete)
router.delete('/items/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const stock = await pool.query(
      'SELECT COALESCE(SUM(quantity),0) as total FROM inventory_stock WHERE item_id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (parseFloat(stock.rows[0].total) > 0) {
      return res.status(409).json({ error: 'Item has stock on hand. Transfer or adjust to zero before archiving.' });
    }
    const result = await pool.query(
      'UPDATE inventory_items SET active=false, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/inventory/items/categories  — distinct categories for filter dropdowns
router.get('/items/categories', requireAuth, requireInventoryView, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT category FROM inventory_items WHERE company_id=$1 AND category IS NOT NULL ORDER BY category`,
      [req.user.company_id]
    );
    res.json(result.rows.map(r => r.category));
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Item UOMs ─────────────────────────────────────────────────────────────────

// GET /api/inventory/uom-conversions — all non-base UOMs for this company (admin)
router.get('/uom-conversions', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(`
      SELECT
        i.id   AS item_id,  i.name AS item_name, i.unit AS base_unit,
        u.id   AS uom_id,   u.unit, u.unit_spec,
        u.factor, u.is_base, u.active
      FROM inventory_item_uoms u
      JOIN inventory_items i ON u.item_id = i.id
      WHERE i.company_id = $1
        AND u.is_base = false
        AND u.active = true
        AND i.active  = true
      ORDER BY i.name, u.factor, u.unit
    `, [companyId]);
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/inventory/items/:id/uoms
router.get('/items/:id/uoms', requireAuth, requireInventoryView, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const item = await pool.query('SELECT id FROM inventory_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    const result = await pool.query(
      `SELECT * FROM inventory_item_uoms WHERE item_id=$1 ORDER BY is_base DESC, factor`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/items/:id/uoms
router.post('/items/:id/uoms', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { unit, unit_spec, factor = 1, is_base = false } = req.body;
  if (!unit?.trim()) return res.status(400).json({ error: 'unit required' });
  const f = parseFloat(factor);
  if (isNaN(f) || f <= 0) return res.status(400).json({ error: 'factor must be a positive number' });
  try {
    const item = await pool.query('SELECT id FROM inventory_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (is_base) {
        await client.query('UPDATE inventory_item_uoms SET is_base=false WHERE item_id=$1', [req.params.id]);
      }
      const result = await client.query(
        `INSERT INTO inventory_item_uoms (company_id, item_id, unit, unit_spec, factor, is_base)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [companyId, req.params.id, unit.trim(), unit_spec?.trim() || null, f, !!is_base]
      );
      await client.query('COMMIT');
      // Return full list
      const all = await pool.query('SELECT * FROM inventory_item_uoms WHERE item_id=$1 ORDER BY is_base DESC, factor', [req.params.id]);
      res.status(201).json(all.rows);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'A UOM with that unit and spec already exists for this item.' });
      throw err;
    } finally { client.release(); }
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/items/:id/uoms/:uomId
router.patch('/items/:id/uoms/:uomId', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { unit, unit_spec, factor, is_base, active } = req.body;
  try {
    const existing = await pool.query(
      'SELECT u.id FROM inventory_item_uoms u JOIN inventory_items i ON u.item_id=i.id WHERE u.id=$1 AND i.company_id=$2 AND u.item_id=$3',
      [req.params.uomId, companyId, req.params.id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'UOM not found' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (is_base) {
        await client.query('UPDATE inventory_item_uoms SET is_base=false WHERE item_id=$1', [req.params.id]);
      }
      const sets = [], vals = [req.params.uomId]; let idx = 2;
      if (unit     !== undefined) { sets.push(`unit=$${idx++}`);      vals.push(unit.trim()); }
      if ('unit_spec' in req.body) { sets.push(`unit_spec=$${idx++}`); vals.push(unit_spec?.trim() || null); }
      if (factor   !== undefined) { const f = parseFloat(factor); if (isNaN(f) || f <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'factor must be a positive number' }); } sets.push(`factor=$${idx++}`); vals.push(f); }
      if (is_base  !== undefined) { sets.push(`is_base=$${idx++}`);   vals.push(!!is_base); }
      if (active   !== undefined) { sets.push(`active=$${idx++}`);    vals.push(!!active); }
      if (sets.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No fields to update' }); }
      await client.query(`UPDATE inventory_item_uoms SET ${sets.join(',')} WHERE id=$1 AND item_id=$${idx}`, [...vals, req.params.id]);
      await client.query('COMMIT');
      const all = await pool.query('SELECT * FROM inventory_item_uoms WHERE item_id=$1 ORDER BY is_base DESC, factor', [req.params.id]);
      res.json(all.rows);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'A UOM with that unit and spec already exists for this item.' });
      throw err;
    } finally { client.release(); }
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/inventory/items/:id/uoms/:uomId  (soft delete if in use; hard delete otherwise)
router.delete('/items/:id/uoms/:uomId', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const existing = await pool.query(
      'SELECT u.id FROM inventory_item_uoms u JOIN inventory_items i ON u.item_id=i.id WHERE u.id=$1 AND i.company_id=$2 AND u.item_id=$3',
      [req.params.uomId, companyId, req.params.id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'UOM not found' });
    const inStock = await pool.query('SELECT 1 FROM inventory_stock WHERE uom_id=$1 LIMIT 1', [req.params.uomId]);
    const inTxns  = await pool.query('SELECT 1 FROM inventory_transactions WHERE uom_id=$1 OR to_uom_id=$1 LIMIT 1', [req.params.uomId]);
    if (inStock.rowCount > 0) {
      return res.status(409).json({ error: 'UOM is in use by existing stock. Transfer or adjust stock to zero first.' });
    }
    if (inTxns.rowCount > 0) {
      await pool.query('UPDATE inventory_item_uoms SET active=false WHERE id=$1', [req.params.uomId]);
    } else {
      await pool.query('DELETE FROM inventory_item_uoms WHERE id=$1', [req.params.uomId]);
    }
    const all = await pool.query('SELECT * FROM inventory_item_uoms WHERE item_id=$1 ORDER BY is_base DESC, factor', [req.params.id]);
    res.json(all.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Locations ─────────────────────────────────────────────────────────────────

// GET /api/inventory/locations
router.get('/locations', requireAuth, requireInventoryView, async (req, res) => {
  const { active = 'true' } = req.query;
  const companyId = req.user.company_id;
  try {
    const conditions = ['l.company_id = $1'];
    const values = [companyId]; let idx = 2;
    if (active !== 'all') { conditions.push(`l.active = $${idx++}`); values.push(active !== 'false'); }
    const result = await pool.query(
      `SELECT l.*, p.name as project_name
       FROM inventory_locations l
       LEFT JOIN projects p ON l.project_id = p.id
       WHERE ${conditions.join(' AND ')} ORDER BY l.name`,
      values
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

const VALID_LOCATION_TYPES = ['warehouse', 'job_site', 'truck', 'other'];

// POST /api/inventory/locations
router.post('/locations', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { name, type = 'warehouse', project_id, notes, address } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
  if (!VALID_LOCATION_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid location type' });
  if (notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  if (address && address.trim().length > 500) return res.status(400).json({ error: 'address too long (max 500 characters)' });
  const companyId = req.user.company_id;
  try {
    if (!await validateProjectRef(pool, companyId, project_id)) {
      return res.status(400).json({ error: 'project_id not found for this company' });
    }
    const result = await pool.query(
      `INSERT INTO inventory_locations (company_id, name, type, project_id, notes, address)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [companyId, name.trim(), type, project_id || null, notes?.trim() || null, address?.trim() || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/locations/:id
router.patch('/locations/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { name, type, project_id, notes, address, active, photo_urls } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM inventory_locations WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Location not found' });
    if (project_id !== undefined && !await validateProjectRef(pool, companyId, project_id)) {
      return res.status(400).json({ error: 'project_id not found for this company' });
    }
    if (name !== undefined && name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
    if (notes !== undefined && notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
    if (address !== undefined && address && address.trim().length > 500) return res.status(400).json({ error: 'address too long (max 500 characters)' });
    const sets = [], vals = [req.params.id, companyId]; let idx = 3;
    if (name !== undefined) { sets.push(`name=$${idx++}`); vals.push(name.trim()); }
    if (type !== undefined) { if (!VALID_LOCATION_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid location type' }); sets.push(`type=$${idx++}`); vals.push(type); }
    if (project_id !== undefined) { sets.push(`project_id=$${idx++}`); vals.push(project_id || null); }
    if (notes !== undefined) { sets.push(`notes=$${idx++}`); vals.push(notes?.trim() || null); }
    if (address !== undefined) { sets.push(`address=$${idx++}`); vals.push(address?.trim() || null); }
    if (active !== undefined) { sets.push(`active=$${idx++}`); vals.push(!!active); }
    if (photo_urls !== undefined) {
      const processed = await processPhotos(photo_urls, companyId);
      sets.push(`photo_urls=$${idx++}`); vals.push(JSON.stringify(processed));
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const result = await pool.query(
      `UPDATE inventory_locations SET ${sets.join(',')} WHERE id=$1 AND company_id=$2 RETURNING *`,
      vals
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.storageLimit) return res.status(413).json({ error: err.message, storage_limit: true });
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/inventory/locations/:id  (soft delete)
router.delete('/locations/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const stock = await pool.query(
      'SELECT COALESCE(SUM(quantity),0) as total FROM inventory_stock WHERE location_id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (parseFloat(stock.rows[0].total) > 0) {
      return res.status(409).json({ error: 'Location has stock on hand. Transfer all items out before archiving.' });
    }
    const result = await pool.query(
      'UPDATE inventory_locations SET active=false WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Location not found' });
    res.json({ success: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Stock ─────────────────────────────────────────────────────────────────────

// GET /api/inventory/stock
router.get('/stock', requireAuth, requireInventoryView, async (req, res) => {
  const {
    location_id, item_id, search, item_search, sku_search,
    area_search, rack_search, bay_search, compartment_search, bin_search,
    category, status, sort = 'location', dir = 'asc', limit = 500, offset = 0
  } = req.query;
  const companyId = req.user.company_id;
  const admin = req.canManageInventory;
  try {
    const conditions = ['s.company_id = $1'];
    const values = [companyId]; let idx = 2;
    if (location_id) { conditions.push(`s.location_id = $${idx++}`); values.push(location_id); }
    if (item_id) { conditions.push(`s.item_id = $${idx++}`); values.push(item_id); }
    if (category) { conditions.push(`i.category = $${idx++}`); values.push(category); }
    if (search) {
      conditions.push(`(
        i.name ILIKE $${idx}
        OR i.sku ILIKE $${idx}
        OR i.category ILIKE $${idx}
        OR l.name ILIKE $${idx}
        OR ia.name ILIKE $${idx}
        OR ir.name ILIKE $${idx}
        OR ib.name ILIKE $${idx}
        OR ic.name ILIKE $${idx}
      )`);
      values.push(`%${search}%`); idx++;
    }
    if (item_search) { conditions.push(`i.name ILIKE $${idx++}`); values.push(`%${item_search}%`); }
    if (sku_search) { conditions.push(`i.sku ILIKE $${idx++}`); values.push(`%${sku_search}%`); }
    if (area_search) { conditions.push(`ia.name ILIKE $${idx++}`); values.push(`%${area_search}%`); }
    if (rack_search) { conditions.push(`ir.name ILIKE $${idx++}`); values.push(`%${rack_search}%`); }
    if (bay_search) { conditions.push(`ib.name ILIKE $${idx++}`); values.push(`%${bay_search}%`); }
    if (compartment_search) { conditions.push(`ic.name ILIKE $${idx++}`); values.push(`%${compartment_search}%`); }
    if (bin_search) {
      conditions.push(`(ia.name ILIKE $${idx} OR ir.name ILIKE $${idx} OR ib.name ILIKE $${idx} OR ic.name ILIKE $${idx})`);
      values.push(`%${bin_search}%`); idx++;
    }
    if (status === 'out') conditions.push('s.quantity <= 0');
    if (status === 'low') conditions.push('s.quantity > 0 AND i.reorder_point > 0 AND s.quantity <= i.reorder_point');
    if (status === 'in') conditions.push('s.quantity > 0 AND (i.reorder_point <= 0 OR s.quantity > i.reorder_point)');
    const whereClause = `${conditions.join(' AND ')} AND i.active = true AND l.active = true`;
    const statusExpr = `(CASE
      WHEN s.quantity <= 0 THEN 0
      WHEN i.reorder_point > 0 AND s.quantity <= i.reorder_point THEN 1
      ELSE 2
    END)`;
    const sortCols = {
      item: 'i.name',
      sku: 'i.sku',
      category: 'i.category',
      location: 'l.name',
      bin: 'ia.name',
      area: 'ia.name',
      rack: 'ir.name',
      bay: 'ib.name',
      compartment: 'ic.name',
      quantity: 's.quantity',
      unit: 'COALESCE(u.unit, i.unit)',
      unit_cost: 'i.unit_cost',
      value: '(s.quantity * COALESCE(i.unit_cost, 0))',
      status: statusExpr,
      updated_at: 's.updated_at',
    };
    const sortCol = sortCols[sort] || sortCols.location;
    const sortDir = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const orderBy = `ORDER BY ${sortCol} ${sortDir} NULLS LAST, l.name ASC, ia.name ASC, ir.name ASC, ib.name ASC, i.name ASC`;
    const result = await pool.query(
      `SELECT s.id, s.item_id, i.name as item_name, i.sku, i.category,
              COALESCE(u.unit, i.unit)           as unit,
              COALESCE(u.unit_spec, i.unit_spec) as unit_spec,
              ${admin ? 'i.unit_cost,' : ''}
              i.reorder_point, s.location_id, l.name as location_name, l.type as location_type,
              s.uom_id, u.unit as uom_unit, u.unit_spec as uom_spec, u.factor as uom_factor, u.is_base as uom_is_base,
              s.area_id, ia.name as area_name,
              s.rack_id, ir.name as rack_name,
              s.bay_id,  ib.name as bay_name,
              s.compartment_id, ic.name as compartment_name,
              s.quantity, s.updated_at
       FROM inventory_stock s
       JOIN inventory_items i ON s.item_id = i.id
       JOIN inventory_locations l ON s.location_id = l.id
       LEFT JOIN inventory_item_uoms    u  ON s.uom_id        = u.id
       LEFT JOIN inventory_areas        ia ON s.area_id        = ia.id
       LEFT JOIN inventory_racks        ir ON s.rack_id        = ir.id
       LEFT JOIN inventory_bays         ib ON s.bay_id         = ib.id
       LEFT JOIN inventory_compartments ic ON s.compartment_id = ic.id
       WHERE ${whereClause}
       ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM inventory_stock s
       JOIN inventory_items i ON s.item_id = i.id
       JOIN inventory_locations l ON s.location_id = l.id
       LEFT JOIN inventory_areas        ia ON s.area_id        = ia.id
       LEFT JOIN inventory_racks        ir ON s.rack_id        = ir.id
       LEFT JOIN inventory_bays         ib ON s.bay_id         = ib.id
       LEFT JOIN inventory_compartments ic ON s.compartment_id = ic.id
       WHERE ${whereClause}`,
      values
    );
    res.json({ stock: result.rows, total: parseInt(totalResult.rows[0].count) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/inventory/stock/low
router.get('/stock/low', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT i.id as item_id, i.name as item_name, i.sku, i.unit, i.unit_cost,
              i.reorder_point, i.reorder_qty,
              COALESCE(SUM(s.quantity), 0) as total_qty,
              json_agg(json_build_object(
                'location_id', l.id, 'location_name', l.name, 'quantity', s.quantity
              ) ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL) as locations
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON i.id = s.item_id
       LEFT JOIN inventory_locations l ON s.location_id = l.id AND l.active = true
       WHERE i.company_id = $1 AND i.active = true AND i.reorder_point > 0
       GROUP BY i.id
       HAVING COALESCE(SUM(s.quantity), 0) <= i.reorder_point
       ORDER BY i.name`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Transactions ──────────────────────────────────────────────────────────────

// POST /api/inventory/transactions
router.post('/transactions', requireAuth, requireInventoryView, TXN_COERCE, async (req, res) => {
  const { type, item_id, quantity, from_location_id, to_location_id, project_id, notes, reference_no, unit_cost,
          area_id, rack_id, bay_id, compartment_id,
          uom_id, to_uom_id, to_quantity,
          supplier_id, lot_number } = req.body;
  const companyId = req.user.company_id;
  const admin = req.canManageInventory;

  if (!type) return res.status(400).json({ error: 'type required' });
  if (!['receive','issue','transfer','adjust','convert'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (!admin && type !== 'issue') return res.status(403).json({ error: 'Workers may only post issue transactions' });
  if (!item_id) return res.status(400).json({ error: 'item_id required' });
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty === 0) return res.status(400).json({ error: 'quantity must be a non-zero number' });

  // Type-specific validation
  if (type === 'receive' && !to_location_id) return res.status(400).json({ error: 'to_location_id required for receive' });
  if (type === 'issue' && !from_location_id) return res.status(400).json({ error: 'from_location_id required for issue' });
  if (type === 'transfer' && !to_location_id) return res.status(400).json({ error: 'to_location_id required for transfer' });
  if (
    type === 'transfer' &&
    from_location_id &&
    from_location_id === to_location_id &&
    !req.body.area_id && !req.body.rack_id && !req.body.bay_id && !req.body.compartment_id
  ) {
    // Same location is allowed when moving between bins (area/rack/bay/compartment).
    // Reject only when no bin is supplied — that's genuinely a no-op.
    return res.status(400).json({ error: 'from and to must differ — pick a different location or bin' });
  }
  if (type === 'adjust' && !to_location_id) return res.status(400).json({ error: 'to_location_id required for adjust' });
  if (notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  if (reference_no && reference_no.trim().length > 100) return res.status(400).json({ error: 'reference_no too long (max 100 characters)' });
  if (type === 'convert') {
    if (!from_location_id) return res.status(400).json({ error: 'from_location_id required for convert' });
    if (!to_uom_id)        return res.status(400).json({ error: 'to_uom_id required for convert' });
    const toQty = parseFloat(to_quantity);
    if (isNaN(toQty) || toQty <= 0) return res.status(400).json({ error: 'to_quantity must be a positive number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify item belongs to company
    const item = await client.query('SELECT id, unit_cost FROM inventory_items WHERE id=$1 AND company_id=$2 AND active=true', [item_id, companyId]);
    if (item.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item not found' }); }

    // Verify locations belong to company
    if (from_location_id) {
      const loc = await client.query('SELECT id FROM inventory_locations WHERE id=$1 AND company_id=$2', [from_location_id, companyId]);
      if (loc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'from_location not found' }); }
    }
    if (to_location_id) {
      const loc = await client.query('SELECT id FROM inventory_locations WHERE id=$1 AND company_id=$2', [to_location_id, companyId]);
      if (loc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'to_location not found' }); }
    }
    if (!await validateProjectRef(client, companyId, project_id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'project_id not found for this company' });
    }
    const binLocationId = ['issue', 'convert'].includes(type) ? from_location_id : to_location_id;
    if (!await validateBinRefs(client, companyId, binLocationId, { area_id, rack_id, bay_id, compartment_id })) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Inventory bin does not belong to the selected location/company' });
    }

    const absQty = Math.abs(qty);
    const snapshotCost = unit_cost != null ? parseFloat(unit_cost) : item.rows[0].unit_cost;

    // Validate UOM IDs belong to this item if provided
    const resolvedUomId   = uom_id   ? parseInt(uom_id)   : null;
    const resolvedToUomId = to_uom_id ? parseInt(to_uom_id) : null;
    if (resolvedUomId) {
      const u = await client.query('SELECT id FROM inventory_item_uoms WHERE id=$1 AND item_id=$2', [resolvedUomId, item_id]);
      if (u.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'uom_id does not belong to this item' }); }
    }
    if (resolvedToUomId) {
      const u = await client.query('SELECT id FROM inventory_item_uoms WHERE id=$1 AND item_id=$2', [resolvedToUomId, item_id]);
      if (u.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'to_uom_id does not belong to this item' }); }
    }

    const toQty = to_quantity ? parseFloat(to_quantity) : null;

    // Validate supplier belongs to company if provided
    const resolvedSupplierId = supplier_id ? parseInt(supplier_id) : null;
    if (resolvedSupplierId) {
      const sup = await client.query('SELECT id FROM inventory_suppliers WHERE id=$1 AND company_id=$2', [resolvedSupplierId, companyId]);
      if (sup.rowCount === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'supplier_id not found' }); }
    }

    // Insert transaction record
    const txn = await client.query(
      `INSERT INTO inventory_transactions
       (company_id, type, item_id, quantity, from_location_id, to_location_id, project_id, performed_by, notes, reference_no, unit_cost,
        uom_id, to_uom_id, to_quantity, supplier_id, lot_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [companyId, type, item_id, absQty,
       from_location_id || null, type === 'convert' ? null : (to_location_id || null),
       project_id || null, req.user.id, notes?.trim() || null, reference_no?.trim() || null, snapshotCost,
       resolvedUomId, resolvedToUomId, toQty, resolvedSupplierId, lot_number?.trim() || null]
    );

    // Update stock — bin IDs identify the affected slot (source for issue,
    // destination for receive/transfer/adjust/convert).
    const bin = { area_id, rack_id, bay_id, compartment_id };
    if (type === 'receive') {
      await applyStockDelta(client, companyId, item_id, to_location_id, absQty, bin, resolvedUomId);
    }
    if (type === 'issue') {
      // Auto-convert: if stock is in a different UOM, convert qty before applying
      const { uomId: issueUomId, qty: issueQty } = await autoConvertIssueUom(
        client, companyId, item_id, from_location_id, resolvedUomId, absQty
      );
      await applyStockDelta(client, companyId, item_id, from_location_id, -issueQty, bin, issueUomId);
    }
    if (type === 'transfer') {
      // from_location is optional — skipping the debit when unknown lets users
      // record an inbound move without having to guess where stock was before.
      if (from_location_id) {
        const { uomId: fromUomId, qty: fromQty } = await autoConvertIssueUom(
          client, companyId, item_id, from_location_id, resolvedUomId, absQty
        );
        await applyStockDelta(client, companyId, item_id, from_location_id, -fromQty, {}, fromUomId);
      }
      await applyStockDelta(client, companyId, item_id, to_location_id, absQty, bin, resolvedUomId);
    }
    if (type === 'adjust') {
      await applyStockDelta(client, companyId, item_id, to_location_id, qty, bin, resolvedUomId); // signed
    }
    if (type === 'convert') {
      // Subtract from source UOM, add to target UOM — both at the same location
      await applyStockDelta(client, companyId, item_id, from_location_id, -absQty, {}, resolvedUomId);
      await applyStockDelta(client, companyId, item_id, from_location_id, toQty,   bin, resolvedToUomId);
    }

    await client.query('COMMIT');

    // Check if resulting stock is negative and include warning
    let warning = null;
    const stockCheck = await pool.query('SELECT quantity FROM inventory_stock WHERE item_id=$1 AND company_id=$2', [item_id, companyId]);
    const anyNegative = stockCheck.rows.some(r => parseFloat(r.quantity) < 0);
    if (anyNegative) warning = 'stock_negative';

    logAudit(companyId, req.user.id, req.user.full_name, `inventory.${type}`, 'inventory_transaction', txn.rows[0].id, null,
      { item_id, quantity: absQty, from_location_id: from_location_id || null, to_location_id: to_location_id || null,
        project_id: project_id || null, reference_no: reference_no || null });

    res.status(201).json({ ...txn.rows[0], warning });

    // Fire low-stock alert (async, after response sent)
    maybeSendLowStockAlert(companyId, item_id).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK');
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /api/inventory/transactions
router.get('/transactions', requireAuth, requireInventoryView, async (req, res) => {
  const {
    item_id, location_id, from_location_id, to_location_id, type, project_id, from, to,
    supplier_id, lot_number, search, item_search, by_search, notes_search,
    sort = 'date', dir = 'desc', limit = 50, offset = 0,
  } = req.query;
  const companyId = req.user.company_id;
  const admin = req.canManageInventory;
  try {
    const conditions = ['t.company_id = $1'];
    const values = [companyId]; let idx = 2;
    if (!admin) { conditions.push(`t.performed_by = $${idx++}`); values.push(req.user.id); }
    if (item_id) { conditions.push(`t.item_id = $${idx++}`); values.push(item_id); }
    if (location_id) { conditions.push(`(t.from_location_id = $${idx} OR t.to_location_id = $${idx})`); values.push(location_id); idx++; }
    if (from_location_id) { conditions.push(`t.from_location_id = $${idx++}`); values.push(from_location_id); }
    if (to_location_id) { conditions.push(`t.to_location_id = $${idx++}`); values.push(to_location_id); }
    if (type) { conditions.push(`t.type = $${idx++}`); values.push(type); }
    if (project_id) { conditions.push(`t.project_id = $${idx++}`); values.push(project_id); }
    if (from) { conditions.push(`t.created_at >= $${idx++}`); values.push(from); }
    if (to) { conditions.push(`t.created_at < ($${idx++}::date + interval '1 day')`); values.push(to); }
    if (supplier_id) { conditions.push(`t.supplier_id = $${idx++}`); values.push(supplier_id); }
    if (lot_number) { conditions.push(`t.lot_number ILIKE $${idx++}`); values.push(`%${lot_number}%`); }
    if (search) {
      conditions.push(`(
        i.name ILIKE $${idx}
        OR i.sku ILIKE $${idx}
        OR fl.name ILIKE $${idx}
        OR tl.name ILIKE $${idx}
        OR p.name ILIKE $${idx}
        OR u.full_name ILIKE $${idx}
        OR sup.name ILIKE $${idx}
        OR t.lot_number ILIKE $${idx}
        OR t.reference_no ILIKE $${idx}
        OR t.notes ILIKE $${idx}
      )`);
      values.push(`%${search}%`); idx++;
    }
    if (item_search) { conditions.push(`(i.name ILIKE $${idx} OR i.sku ILIKE $${idx})`); values.push(`%${item_search}%`); idx++; }
    if (by_search) { conditions.push(`u.full_name ILIKE $${idx++}`); values.push(`%${by_search}%`); }
    if (notes_search) {
      conditions.push(`(t.notes ILIKE $${idx} OR t.reference_no ILIKE $${idx})`);
      values.push(`%${notes_search}%`); idx++;
    }
    const sortCols = {
      date: 't.created_at',
      type: 't.type',
      item: 'i.name',
      quantity: 't.quantity',
      from: 'fl.name',
      to: 'tl.name',
      project: 'p.name',
      supplier: 'sup.name',
      lot: 't.lot_number',
      by: 'u.full_name',
    };
    const sortCol = sortCols[sort] || sortCols.date;
    const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = `ORDER BY ${sortCol} ${sortDir} NULLS LAST, t.created_at DESC`;
    const result = await pool.query(
      `SELECT t.*,
              i.name as item_name,
              COALESCE(fu.unit, i.unit) as unit,
              fu.unit || CASE WHEN fu.unit_spec IS NOT NULL THEN ' (' || fu.unit_spec || ')' ELSE '' END as uom_label,
              tu.unit || CASE WHEN tu.unit_spec IS NOT NULL THEN ' (' || tu.unit_spec || ')' ELSE '' END as to_uom_label,
              fl.name as from_location_name, tl.name as to_location_name,
              p.name as project_name, u.full_name as performed_by_name,
              sup.name as supplier_name
       FROM inventory_transactions t
       JOIN inventory_items i ON t.item_id = i.id
       LEFT JOIN inventory_item_uoms fu ON t.uom_id    = fu.id
       LEFT JOIN inventory_item_uoms tu ON t.to_uom_id = tu.id
       LEFT JOIN inventory_locations fl ON t.from_location_id = fl.id
       LEFT JOIN inventory_locations tl ON t.to_location_id = tl.id
       LEFT JOIN projects p ON t.project_id = p.id
       JOIN users u ON t.performed_by = u.id
       LEFT JOIN inventory_suppliers sup ON t.supplier_id = sup.id
       WHERE ${conditions.join(' AND ')}
       ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    const total = await pool.query(
      `SELECT COUNT(*) FROM inventory_transactions t
       JOIN inventory_items i ON t.item_id = i.id
       LEFT JOIN inventory_locations fl ON t.from_location_id = fl.id
       LEFT JOIN inventory_locations tl ON t.to_location_id = tl.id
       LEFT JOIN projects p ON t.project_id = p.id
       JOIN users u ON t.performed_by = u.id
       LEFT JOIN inventory_suppliers sup ON t.supplier_id = sup.id
       WHERE ${conditions.join(' AND ')}`,
      values
    );
    res.json({ transactions: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Cycle Counts ──────────────────────────────────────────────────────────────

// GET /api/inventory/cycle-counts
router.get('/cycle-counts', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { location_id, status, count_type, q, limit = 100, offset = 0 } = req.query;
  const companyId = req.user.company_id;
  try {
    const conditions = ['cc.company_id = $1'];
    const values = [companyId]; let idx = 2;
    if (location_id) { conditions.push(`cc.location_id = $${idx++}`); values.push(location_id); }
    if (status) { conditions.push(`cc.status = $${idx++}`); values.push(status); }
    if (count_type) { conditions.push(`cc.count_type = $${idx++}`); values.push(count_type); }
    if (q?.trim()) {
      conditions.push(`(
        COALESCE(l.name, 'All Locations') ILIKE $${idx}
        OR cc.count_type ILIKE $${idx}
        OR cc.status ILIKE $${idx}
        OR u.full_name ILIKE $${idx}
        OR cu.full_name ILIKE $${idx}
      )`);
      values.push(`%${q.trim()}%`);
      idx++;
    }
    const result = await pool.query(
      `SELECT cc.*, COALESCE(l.name, 'All Locations') as location_name,
              u.full_name as started_by_name,
              cu.full_name as completed_by_name,
              COALESCE(agg.line_count,    0) AS line_count,
              COALESCE(agg.counted_count, 0) AS counted_count
       FROM inventory_cycle_counts cc
       LEFT JOIN inventory_locations l ON cc.location_id = l.id
       JOIN users u ON cc.started_by = u.id
       LEFT JOIN users cu ON cc.completed_by = cu.id
       LEFT JOIN (
         SELECT cycle_count_id,
                COUNT(*) AS line_count,
                COUNT(*) FILTER (WHERE line_status IN ('accepted','reconciled','overridden','audited')) AS counted_count
         FROM inventory_cycle_count_lines
         GROUP BY cycle_count_id
       ) agg ON agg.cycle_count_id = cc.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY cc.started_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    const totalResult = await pool.query(
      `SELECT COUNT(*)
       FROM inventory_cycle_counts cc
       LEFT JOIN inventory_locations l ON cc.location_id = l.id
       JOIN users u ON cc.started_by = u.id
       LEFT JOIN users cu ON cc.completed_by = cu.id
       WHERE ${conditions.join(' AND ')}`,
      values
    );
    res.json({ counts: result.rows, total: parseInt(totalResult.rows[0].count) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/cycle-counts
router.post('/cycle-counts', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { location_id, notes, count_type = 'cycle' } = req.body;
  const companyId = req.user.company_id;
  if (!INVENTORY_COUNT_TYPES.includes(count_type)) return res.status(400).json({ error: 'Invalid count_type' });

  // Full counts don't need a location; all others do
  if (count_type !== 'full' && !location_id) return res.status(400).json({ error: 'location_id required' });

  try {
    if (count_type === 'full') {
      // Block if an active full count already exists
      const existing = await pool.query(
        `SELECT id FROM inventory_cycle_counts WHERE company_id=$1 AND count_type='full' AND status IN ('draft','in_progress')`,
        [companyId]
      );
      if (existing.rowCount > 0) return res.status(409).json({ error: 'An active full count already exists.' });
    } else {
      // Block if an active count already exists for this location
      const existing = await pool.query(
        `SELECT id FROM inventory_cycle_counts WHERE company_id=$1 AND location_id=$2 AND status IN ('draft','in_progress')`,
        [companyId, location_id]
      );
      if (existing.rowCount > 0) return res.status(409).json({ error: 'An active count already exists for this location.' });

      const loc = await pool.query('SELECT id FROM inventory_locations WHERE id=$1 AND company_id=$2', [location_id, companyId]);
      if (loc.rowCount === 0) return res.status(404).json({ error: 'Location not found' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cc = await client.query(
        `INSERT INTO inventory_cycle_counts (company_id, location_id, started_by, notes, count_type)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [companyId, location_id || null, req.user.id, notes?.trim() || null, count_type]
      );
      const countId = cc.rows[0].id;

      let stock;
      if (count_type === 'full') {
        // Snapshot all stock across all locations
        stock = await client.query(
          `SELECT s.item_id, s.location_id, s.quantity, s.uom_id FROM inventory_stock s
           JOIN inventory_items i ON s.item_id = i.id
           WHERE s.company_id = $1 AND i.active = true
           ORDER BY s.location_id, i.name`,
          [companyId]
        );
      } else {
        stock = await client.query(
          `SELECT s.item_id, NULL::integer as location_id, s.quantity, s.uom_id FROM inventory_stock s
           JOIN inventory_items i ON s.item_id = i.id
           WHERE s.location_id = $1 AND s.company_id = $2 AND i.active = true`,
          [location_id, companyId]
        );
      }

      if (stock.rows.length > 0) {
        // Batch inserts in chunks of 500 to avoid oversized parameter lists and
        // transaction log bloat when snapshotting large inventories (e.g. full counts).
        const CHUNK = 500;
        for (let start = 0; start < stock.rows.length; start += CHUNK) {
          const chunk = stock.rows.slice(start, start + CHUNK);
          const lineValues = chunk.map((r, i) => `($1, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5})`).join(', ');
          const lineParams = [countId];
          chunk.forEach(r => { lineParams.push(r.item_id); lineParams.push(r.location_id); lineParams.push(r.quantity); lineParams.push(r.uom_id || null); });
          await client.query(
            `INSERT INTO inventory_cycle_count_lines (cycle_count_id, item_id, location_id, expected_qty, stock_uom_id) VALUES ${lineValues}`,
            lineParams
          );
        }
      }

      await client.query('COMMIT');

      // Return with lines
      const lines = await pool.query(
        `SELECT l.*, i.name as item_name, i.unit, i.sku, loc.name as location_name,
              su.unit as stock_uom_unit, su.unit_spec as stock_uom_spec, su.factor as stock_uom_factor,
              cu.unit as counted_uom_unit, cu.unit_spec as counted_uom_spec, cu.factor as counted_uom_factor
         FROM inventory_cycle_count_lines l
         JOIN inventory_items i ON l.item_id = i.id
         LEFT JOIN inventory_locations loc ON l.location_id = loc.id
         LEFT JOIN inventory_item_uoms su ON l.stock_uom_id = su.id
         LEFT JOIN inventory_item_uoms cu ON l.counted_uom_id = cu.id
         WHERE l.cycle_count_id = $1 ORDER BY loc.name NULLS FIRST, i.name`,
        [countId]
      );
      res.status(201).json({ ...cc.rows[0], lines: lines.rows });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/inventory/cycle-counts/my-assignments — worker's pending assignments across all active counts
router.get('/cycle-counts/my-assignments', requireAuth, requireInventoryView, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT a.id as assignment_id, a.line_id, a.role, a.status as assignment_status,
              a.counted_qty, a.counted_uom_id, a.notes as assignment_notes, a.submitted_at,
              l.item_id, l.expected_qty, l.line_status, l.stock_uom_id,
              l.location_id as line_location_id,
              l.reconcile_threshold, l.reconcile_threshold_type,
              i.name as item_name, i.sku, i.unit,
              su.unit as stock_uom_unit, su.factor as stock_uom_factor,
              loc.name as location_name,
              cc.id as count_id, cc.count_type, cc.status as count_status, cc.location_id,
              ccl.name as count_location_name
       FROM inventory_count_assignments a
       JOIN inventory_cycle_count_lines l ON a.line_id = l.id
       JOIN inventory_cycle_counts cc ON a.cycle_count_id = cc.id
       JOIN inventory_items i ON l.item_id = i.id
       LEFT JOIN inventory_locations loc ON l.location_id = loc.id
       LEFT JOIN inventory_locations ccl ON cc.location_id = ccl.id
       LEFT JOIN inventory_item_uoms su ON l.stock_uom_id = su.id
       WHERE a.user_id = $1 AND cc.company_id = $2
         AND cc.status = 'in_progress'
         AND a.status = 'pending'
       ORDER BY cc.id, loc.name NULLS LAST, i.name`,
      [req.user.id, companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /api/inventory/cycle-counts/:id
router.get('/cycle-counts/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const cc = await pool.query(
      `SELECT cc.*, COALESCE(l.name, 'All Locations') as location_name,
              u.full_name as started_by_name,
              cu.full_name as completed_by_name
       FROM inventory_cycle_counts cc
       LEFT JOIN inventory_locations l ON cc.location_id = l.id
       JOIN users u ON cc.started_by = u.id
       LEFT JOIN users cu ON cc.completed_by = cu.id
       WHERE cc.id = $1 AND cc.company_id = $2`,
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    const [lines, workers, assignments] = await Promise.all([
      pool.query(
        `SELECT l.*, i.name as item_name, i.unit, i.sku, u.full_name as counted_by_name,
                loc.name as location_name,
                su.unit as stock_uom_unit, su.factor as stock_uom_factor,
                cu.unit as counted_uom_unit
         FROM inventory_cycle_count_lines l
         JOIN inventory_items i ON l.item_id = i.id
         LEFT JOIN users u ON l.counted_by = u.id
         LEFT JOIN inventory_locations loc ON l.location_id = loc.id
         LEFT JOIN inventory_item_uoms su ON l.stock_uom_id = su.id
         LEFT JOIN inventory_item_uoms cu ON l.counted_uom_id = cu.id
         WHERE l.cycle_count_id = $1 ORDER BY loc.name NULLS FIRST, i.name`,
        [req.params.id]
      ),
      pool.query(
        `SELECT cw.user_id, cw.roles, u.full_name FROM inventory_count_workers cw
         JOIN users u ON cw.user_id = u.id WHERE cw.cycle_count_id=$1 ORDER BY u.full_name`,
        [req.params.id]
      ),
      pool.query(
        `SELECT a.line_id, a.role, a.user_id, a.status as assignment_status, u.full_name as worker_name
         FROM inventory_count_assignments a JOIN users u ON a.user_id = u.id
         WHERE a.cycle_count_id=$1`,
        [req.params.id]
      ),
    ]);
    res.json({ ...cc.rows[0], lines: lines.rows, workers: workers.rows, assignments: assignments.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/cycle-counts/:id  (header fields + draft→in_progress)
router.patch('/cycle-counts/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { notes, status } = req.body;
  try {
    const cc = await pool.query('SELECT * FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    if (cc.rows[0].status === 'completed') return res.status(409).json({ error: 'Cannot modify a completed count' });
    if (status && status !== 'in_progress') return res.status(400).json({ error: 'Can only advance status to in_progress' });
    if (notes !== undefined && notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
    const sets = [], vals = [req.params.id, companyId]; let idx = 3;
    if (notes !== undefined) { sets.push(`notes=$${idx++}`); vals.push(notes?.trim() || null); }
    if (status === 'in_progress') { sets.push(`status='in_progress'`); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const result = await pool.query(
      `UPDATE inventory_cycle_counts SET ${sets.join(',')} WHERE id=$1 AND company_id=$2 RETURNING *`,
      vals
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/cycle-counts/:id/lines/:lineId
router.patch('/cycle-counts/:id/lines/:lineId', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { counted_qty, counted_uom_id, notes } = req.body;
  try {
    // Verify count belongs to company and isn't completed
    const cc = await pool.query(
      'SELECT id, status FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    if (cc.rows[0].status === 'completed') return res.status(409).json({ error: 'Count is already completed' });

    const sets = [], vals = [req.params.lineId, req.params.id]; let idx = 3;
    if (counted_qty !== undefined) {
      const qty = parseFloat(counted_qty);
      if (isNaN(qty) || qty < 0) return res.status(400).json({ error: 'counted_qty must be a non-negative number' });
      sets.push(`counted_qty=$${idx++}`); vals.push(qty);
      sets.push(`counted_by=$${idx++}`); vals.push(req.user.id);
      sets.push(`counted_at=NOW()`);

      // Resolve UOM and calculate variance in stock UOM units
      const resolvedCountedUomId = counted_uom_id != null ? parseInt(counted_uom_id) : null;
      sets.push(`counted_uom_id=$${idx++}`); vals.push(resolvedCountedUomId);

      // Fetch line's expected_qty and UOM factors to compute variance
      const lineRow = await pool.query(
        `SELECT l.expected_qty, l.stock_uom_id,
                su.factor as stock_factor,
                cu.factor as counted_factor
         FROM inventory_cycle_count_lines l
         LEFT JOIN inventory_item_uoms su ON l.stock_uom_id = su.id
         LEFT JOIN inventory_item_uoms cu ON cu.id = $1
         WHERE l.id = $2`,
        [resolvedCountedUomId, req.params.lineId]
      );
      if (lineRow.rowCount > 0) {
        const { expected_qty, stock_uom_id, stock_factor, counted_factor } = lineRow.rows[0];
        let variance;
        // Only apply UOM conversion when a different UOM is specified; otherwise variance is
        // a direct comparison in stock UOM (matches the pattern in submit and override routes).
        if (resolvedCountedUomId && resolvedCountedUomId !== stock_uom_id) {
          const stockF   = parseFloat(stock_factor   || 1);
          const countedF = parseFloat(counted_factor || 1);
          variance = qty * (countedF / stockF) - parseFloat(expected_qty);
        } else {
          variance = qty - parseFloat(expected_qty);
        }
        sets.push(`variance=$${idx++}`); vals.push(variance);
      }
      // Admin direct-entry marks the line accepted so the complete flow and progress bar work correctly
      sets.push(`line_status='accepted'`);
    }
    if (notes !== undefined) { sets.push(`notes=$${idx++}`); vals.push(notes); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const result = await pool.query(
      `UPDATE inventory_cycle_count_lines SET ${sets.join(',')}
       WHERE id=$1 AND cycle_count_id=$2 RETURNING *`,
      vals
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Line not found' });
    // Trigger auto-complete so admin direct-entry counts complete without a manual step
    let autoCompleted = false;
    if (counted_qty !== undefined) {
      autoCompleted = await checkAutoComplete(companyId, parseInt(req.params.id), req.user.id);
    }
    res.json({ line: result.rows[0], auto_completed: autoCompleted });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/cycle-counts/:id/complete
router.post('/cycle-counts/:id/complete', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const cc = await pool.query(
      'SELECT * FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    if (cc.rows[0].status === 'completed') return res.status(409).json({ error: 'Already completed' });

    const lines = await pool.query(
      'SELECT * FROM inventory_cycle_count_lines WHERE cycle_count_id=$1',
      [req.params.id]
    );

    // Block if any line is not in a final state
    const FINAL_STATUSES = ['accepted', 'reconciled', 'overridden', 'audited'];
    const notFinal = lines.rows.filter(l => !FINAL_STATUSES.includes(l.line_status));
    if (notFinal.length > 0) {
      const itemIds = notFinal.map(l => l.item_id);
      const items = await pool.query('SELECT id, name FROM inventory_items WHERE id = ANY($1)', [itemIds]);
      const names = items.rows.map(i => i.name);
      return res.status(422).json({ error: `${notFinal.length} item(s) not yet in a final state: ${names.join(', ')}` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Post adjust transactions for lines with non-zero variance
      const linesWithVariance = lines.rows.filter(l => l.variance != null && parseFloat(l.variance) !== 0);
      const isFullCount = cc.rows[0].count_type === 'full';
      for (const line of linesWithVariance) {
        const delta = parseFloat(line.variance); // in stock UOM units
        const locationId = isFullCount ? line.location_id : cc.rows[0].location_id;
        const stockUomId = line.stock_uom_id || null;
        const typeLabel = cc.rows[0].count_type === 'reconcile' ? 'Reconcile count adjustment'
          : cc.rows[0].count_type === 'audit' ? 'Audit count adjustment'
          : cc.rows[0].count_type === 'full' ? 'Full count adjustment'
          : 'Cycle count adjustment';
        await client.query(
          `INSERT INTO inventory_transactions
           (company_id, type, item_id, quantity, to_location_id, performed_by, notes, uom_id)
           VALUES ($1,'adjust',$2,$3,$4,$5,$6,$7)`,
          [companyId, line.item_id, Math.abs(delta), locationId, req.user.id, typeLabel, stockUomId]
        );
        await applyStockDelta(client, companyId, line.item_id, locationId, delta, {}, stockUomId);
      }

      // Atomically claim completion — prevent double-posting if auto-complete fired concurrently
      const claim = await client.query(
        `UPDATE inventory_cycle_counts SET status='completed', completed_by=$1, completed_at=NOW()
         WHERE id=$2 AND status='in_progress'
         RETURNING id`,
        [req.user.id, req.params.id]
      );
      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Count was already completed' });
      }

      await client.query('COMMIT');
      logAudit(companyId, req.user.id, req.user.full_name, 'cycle_count.completed', 'cycle_count', req.params.id, null,
        { adjustments_posted: linesWithVariance.length, count_type: cc.rows[0].count_type });
      res.json({ success: true, adjustments_posted: linesWithVariance.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Cycle Count Worker Assignments ────────────────────────────────────────────

// Helper: check if all lines are in a final state and auto-complete the count
async function checkAutoComplete(companyId, countId, completedById) {
  // 'audited' is also final (auditor submitted, no reconciler was available)
  const FINAL_STATUSES = `'accepted','reconciled','overridden','audited'`;
  const pending = await pool.query(
    `SELECT COUNT(*) FROM inventory_cycle_count_lines
     WHERE cycle_count_id = $1
       AND line_status NOT IN (${FINAL_STATUSES})`,
    [countId]
  );
  if (parseInt(pending.rows[0].count) > 0) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Atomically claim the count — prevents double-completion from concurrent submits
    const claim = await client.query(
      `UPDATE inventory_cycle_counts SET status='completed', completed_by=$1, completed_at=NOW()
       WHERE id=$2 AND company_id=$3 AND status='in_progress'
       RETURNING *`,
      [completedById, countId, companyId]
    );
    if (claim.rowCount === 0) {
      await client.query('ROLLBACK');
      return false; // Already completed or not found
    }

    // Fetch lines inside the transaction so we see the latest committed variance values
    // (a reconciler could have updated variance between the pending-count check and here)
    const linesResult = await client.query(
      'SELECT * FROM inventory_cycle_count_lines WHERE cycle_count_id = $1',
      [countId]
    );

    const cc = claim.rows[0];
    const isFullCount = cc.count_type === 'full';
    const typeLabel = { reconcile: 'Reconcile count adjustment', audit: 'Audit count adjustment',
      full: 'Full count adjustment' }[cc.count_type] || 'Cycle count adjustment';

    const linesWithVariance = linesResult.rows.filter(l => l.variance != null && parseFloat(l.variance) !== 0);
    for (const line of linesWithVariance) {
      const delta = parseFloat(line.variance);
      const locationId = isFullCount ? line.location_id : cc.location_id;
      await client.query(
        `INSERT INTO inventory_transactions
         (company_id, type, item_id, quantity, to_location_id, performed_by, notes, uom_id)
         VALUES ($1,'adjust',$2,$3,$4,$5,$6,$7)`,
        [companyId, line.item_id, Math.abs(delta), locationId, completedById, typeLabel, line.stock_uom_id || null]
      );
      await applyStockDelta(client, companyId, line.item_id, locationId, delta, {}, line.stock_uom_id || null);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/inventory/cycle-counts/:id/workers
router.get('/cycle-counts/:id/workers', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const cc = await pool.query(
      'SELECT id FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    const result = await pool.query(
      `SELECT cw.id, cw.user_id, cw.roles, cw.assigned_at,
              u.full_name, u.role as user_role
       FROM inventory_count_workers cw
       JOIN users u ON cw.user_id = u.id
       WHERE cw.cycle_count_id = $1 ORDER BY u.full_name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/cycle-counts/:id/workers — upsert worker roles
// Body: { users: [{ user_id, roles: ['counter','auditor','reconciler'] }] }
router.post('/cycle-counts/:id/workers', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { users } = req.body;
  const VALID_ROLES = ['counter', 'auditor', 'reconciler'];
  if (!Array.isArray(users) || users.length === 0) return res.status(400).json({ error: 'users array required' });
  try {
    const cc = await pool.query(
      'SELECT id, status FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    if (cc.rows[0].status === 'completed') return res.status(409).json({ error: 'Cannot modify a completed count' });

    for (const w of users) {
      const userId = parseInt(w.user_id);
      if (!userId) continue;
      const roles = Array.isArray(w.roles) ? w.roles.filter(r => VALID_ROLES.includes(r)) : [];
      if (roles.length === 0) continue; // skip workers with no valid roles — they can't be assigned
      // Verify worker belongs to company
      const workerCheck = await pool.query('SELECT id FROM users WHERE id=$1 AND company_id=$2', [userId, companyId]);
      if (workerCheck.rowCount === 0) continue;
      await pool.query(
        `INSERT INTO inventory_count_workers (cycle_count_id, user_id, roles)
         VALUES ($1,$2,$3)
         ON CONFLICT (cycle_count_id, user_id) DO UPDATE SET roles = $3`,
        [req.params.id, userId, roles]
      );
    }
    // Return updated worker list
    const result = await pool.query(
      `SELECT cw.id, cw.user_id, cw.roles, cw.assigned_at, u.full_name, u.role as user_role
       FROM inventory_count_workers cw JOIN users u ON cw.user_id = u.id
       WHERE cw.cycle_count_id = $1 ORDER BY u.full_name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/inventory/cycle-counts/:id/workers/:userId
router.delete('/cycle-counts/:id/workers/:userId', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const cc = await pool.query(
      'SELECT id, status FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    if (cc.rows[0].status === 'completed') return res.status(409).json({ error: 'Cannot modify a completed count' });
    await pool.query(
      'DELETE FROM inventory_count_workers WHERE cycle_count_id=$1 AND user_id=$2',
      [req.params.id, req.params.userId]
    );
    // Also remove their pending assignments so they can no longer submit
    await pool.query(
      `DELETE FROM inventory_count_assignments
       WHERE cycle_count_id=$1 AND user_id=$2 AND status='pending'`,
      [req.params.id, req.params.userId]
    );
    res.json({ removed: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/cycle-counts/:id/distribute — round-robin assign lines to counters by location group
router.post('/cycle-counts/:id/distribute', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const cc = await pool.query(
      'SELECT * FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    if (cc.rows[0].status === 'completed') return res.status(409).json({ error: 'Count is already completed' });

    // Get counters for this count
    const countersResult = await pool.query(
      `SELECT user_id FROM inventory_count_workers
       WHERE cycle_count_id=$1 AND 'counter' = ANY(roles)
       ORDER BY user_id`,
      [req.params.id]
    );
    if (countersResult.rowCount === 0) return res.status(400).json({ error: 'No counters assigned to this count' });
    const counters = countersResult.rows.map(r => r.user_id);

    // Get unassigned (no counter assignment) lines, grouped by location
    const lines = await pool.query(
      `SELECT l.id, l.location_id, loc.name as location_name
       FROM inventory_cycle_count_lines l
       LEFT JOIN inventory_locations loc ON l.location_id = loc.id
       LEFT JOIN inventory_count_assignments a ON a.line_id = l.id AND a.role = 'counter'
       WHERE l.cycle_count_id = $1 AND a.id IS NULL
       ORDER BY loc.name NULLS FIRST, l.id`,
      [req.params.id]
    );

    if (lines.rowCount === 0) return res.json({ assigned: 0 });

    // Group lines by location name (or null for locationless)
    const groups = {};
    for (const line of lines.rows) {
      const key = line.location_name || '__none__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(line.id);
    }

    // Round-robin: assign each location group to next counter
    let counterIdx = 0;
    let assigned = 0;
    for (const locationGroup of Object.values(groups)) {
      const userId = counters[counterIdx % counters.length];
      counterIdx++;
      for (const lineId of locationGroup) {
        await pool.query(
          `INSERT INTO inventory_count_assignments (line_id, cycle_count_id, user_id, role)
           VALUES ($1,$2,$3,'counter')
           ON CONFLICT (line_id, role) DO UPDATE SET user_id = $3`,
          [lineId, req.params.id, userId]
        );
        assigned++;
      }
    }

    // Auto-advance to in_progress if still draft
    if (cc.rows[0].status === 'draft') {
      await pool.query(
        `UPDATE inventory_cycle_counts SET status='in_progress' WHERE id=$1`,
        [req.params.id]
      );
    }

    res.json({ assigned });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/cycle-counts/:id/workers/:userId/lines — reassign specific lines to a different counter
// Body: { line_ids: [id, ...], user_id: newUserId }
router.patch('/cycle-counts/:id/workers/:userId/lines', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { line_ids, user_id: newUserId } = req.body;
  if (!Array.isArray(line_ids) || line_ids.length === 0) return res.status(400).json({ error: 'line_ids array required' });
  if (!newUserId) return res.status(400).json({ error: 'user_id required' });
  const validLineIds = line_ids.map(id => parseInt(id)).filter(id => !isNaN(id));
  if (validLineIds.length === 0) return res.status(400).json({ error: 'line_ids must be integers' });
  try {
    const cc = await pool.query(
      'SELECT id FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    // Verify new user is a counter for this count
    const counterCheck = await pool.query(
      `SELECT id FROM inventory_count_workers WHERE cycle_count_id=$1 AND user_id=$2 AND 'counter' = ANY(roles)`,
      [req.params.id, newUserId]
    );
    if (counterCheck.rowCount === 0) return res.status(400).json({ error: 'Target worker is not a counter for this count' });

    let reassigned = 0;
    for (const lineId of validLineIds) {
      const r = await pool.query(
        `UPDATE inventory_count_assignments SET user_id=$1
         WHERE line_id=$2 AND cycle_count_id=$3 AND user_id=$4 AND role='counter' AND status='pending'`,
        [newUserId, lineId, req.params.id, req.params.userId]
      );
      reassigned += r.rowCount;
    }
    res.json({ reassigned });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/cycle-counts/:id/submit — worker submits a count, audit, or reconcile
// Body: { line_id, role, counted_qty, counted_uom_id, notes }
router.post('/cycle-counts/:id/submit', requireAuth, requireInventoryView, async (req, res) => {
  const companyId = req.user.company_id;
  const { line_id, role, counted_qty, counted_uom_id, notes } = req.body;
  const VALID_ROLES = ['counter', 'auditor', 'reconciler'];
  const lineId = parseInt(line_id);
  if (!line_id || isNaN(lineId)) return res.status(400).json({ error: 'line_id must be a valid integer' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'role must be counter, auditor, or reconciler' });
  const qty = parseFloat(counted_qty);
  if (isNaN(qty) || qty < 0) return res.status(400).json({ error: 'counted_qty must be a non-negative number' });
  const notesTrimmed = notes?.trim()?.slice(0, 500) || null;
  const resolvedCountedUomId = counted_uom_id != null ? parseInt(counted_uom_id) : null;
  if (resolvedCountedUomId != null && (!Number.isInteger(resolvedCountedUomId) || resolvedCountedUomId <= 0)) {
    return res.status(400).json({ error: 'counted_uom_id must be a valid integer' });
  }

  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Verify count belongs to company and is active
    const cc = await client.query(
      'SELECT * FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cycle count not found' });
    }
    if (cc.rows[0].status !== 'in_progress') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Count is not in progress' });
    }

    const lineRow = await client.query(
      `SELECT l.*, i.name as item_name
       FROM inventory_cycle_count_lines l
       JOIN inventory_items i ON l.item_id = i.id
       WHERE l.id=$1 AND l.cycle_count_id=$2 AND i.company_id=$3
       FOR UPDATE OF l`,
      [lineId, req.params.id, companyId]
    );
    if (lineRow.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Line not found' });
    }
    const line = lineRow.rows[0];
    const SUBMIT_FINAL = ['accepted', 'reconciled', 'overridden', 'audited'];
    if (SUBMIT_FINAL.includes(line.line_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Line is already in a final state and cannot be re-submitted' });
    }

    let countedFactor = 1;
    if (resolvedCountedUomId != null) {
      const countedUom = await client.query(
        `SELECT factor FROM inventory_item_uoms
         WHERE id=$1 AND item_id=$2 AND company_id=$3`,
        [resolvedCountedUomId, line.item_id, companyId]
      );
      if (countedUom.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Counted UOM does not belong to this item' });
      }
      countedFactor = parseFloat(countedUom.rows[0].factor);
    }

    let stockFactor = 1;
    if (line.stock_uom_id != null) {
      const stockUom = await client.query(
        `SELECT factor FROM inventory_item_uoms
         WHERE id=$1 AND item_id=$2 AND company_id=$3`,
        [line.stock_uom_id, line.item_id, companyId]
      );
      if (stockUom.rowCount === 0) throw new Error('Cycle count line has an invalid stock UOM');
      stockFactor = parseFloat(stockUom.rows[0].factor);
    }
    if (!Number.isFinite(countedFactor) || !Number.isFinite(stockFactor) || stockFactor === 0) {
      throw new Error('Cycle count line has an invalid UOM conversion factor');
    }
    const variance = qty * (countedFactor / stockFactor) - parseFloat(line.expected_qty);

    // Atomically claim the assignment — prevents duplicate submissions from concurrent requests
    const assignment = await client.query(
      `UPDATE inventory_count_assignments
       SET status='submitted', counted_qty=$1, counted_uom_id=$2, notes=$3, submitted_at=NOW()
       WHERE line_id=$4 AND cycle_count_id=$5 AND user_id=$6 AND role=$7 AND status='pending'
       RETURNING *`,
      [qty, resolvedCountedUomId, notesTrimmed, lineId, req.params.id, req.user.id, role]
    );
    if (assignment.rowCount === 0) {
      // Distinguish "no assignment" from "already submitted"
      const exists = await client.query(
        `SELECT status FROM inventory_count_assignments
         WHERE line_id=$1 AND cycle_count_id=$2 AND user_id=$3 AND role=$4`,
        [lineId, req.params.id, req.user.id, role]
      );
      await client.query('ROLLBACK');
      if (exists.rowCount === 0) return res.status(403).json({ error: 'No assignment found for this line/role' });
      return res.status(409).json({ error: 'Already submitted' });
    }

    // Update line counted values and status
    let newLineStatus = line.line_status;
    const settingsRows = await client.query('SELECT key, value FROM settings WHERE company_id=$1', [companyId]);
    const settings = applySettingsRows(settingsRows.rows, ADMIN_SETTINGS_DEFAULTS);

    if (role === 'counter') {
      // Update the line's counted values
      await client.query(
        `UPDATE inventory_cycle_count_lines
         SET counted_qty=$1, counted_uom_id=$2, counted_by=$3, counted_at=NOW(), variance=$4
         WHERE id=$5 AND cycle_count_id=$6`,
        [qty, resolvedCountedUomId, req.user.id, variance, lineId, req.params.id]
      );

      // Decide: sample for audit?
      const auditPct = settings.cycle_count_audit_pct ?? 15;
      const shouldAudit = Math.random() * 100 < auditPct;

      if (shouldAudit) {
        // Find an auditor for this count who is not the counter (prefer different location)
        const auditors = await client.query(
          `SELECT user_id FROM inventory_count_workers
           WHERE cycle_count_id=$1 AND 'auditor' = ANY(roles) AND user_id != $2
           ORDER BY RANDOM() LIMIT 1`,
          [req.params.id, req.user.id]
        );
        if (auditors.rowCount > 0) {
          const auditorId = auditors.rows[0].user_id;
          await client.query(
            `INSERT INTO inventory_count_assignments (line_id, cycle_count_id, user_id, role)
             VALUES ($1,$2,$3,'auditor')
             ON CONFLICT (line_id, role) DO UPDATE SET user_id=$3, status='pending', submitted_at=NULL`,
            [lineId, req.params.id, auditorId]
          );
          newLineStatus = 'needs_audit';
        } else {
          newLineStatus = 'accepted'; // No auditor available — accept directly
        }
      } else {
        newLineStatus = 'accepted';
      }

    } else if (role === 'auditor') {
      // Check if variance exceeds reconcile threshold
      const threshold = parseFloat(line.reconcile_threshold ?? settings.cycle_count_reconcile_threshold) || 0;
      const thresholdType = line.reconcile_threshold_type || settings.cycle_count_reconcile_threshold_type || 'units';
      let exceeds = false;
      if (threshold > 0) {
        const absVariance = Math.abs(variance);
        if (thresholdType === 'pct') {
          const pct = parseFloat(line.expected_qty) !== 0
            ? (absVariance / Math.abs(parseFloat(line.expected_qty))) * 100 : 0;
          exceeds = pct > threshold;
        } else {
          exceeds = absVariance > threshold;
        }
      }

      if (exceeds) {
        // Find a reconciler who is not the counter or auditor of this line
        const counterAssignment = await client.query(
          `SELECT user_id FROM inventory_count_assignments WHERE line_id=$1 AND role='counter'`,
          [lineId]
        );
        const counterUserId = counterAssignment.rows[0]?.user_id;
        const reconcilers = await client.query(
          `SELECT user_id FROM inventory_count_workers
           WHERE cycle_count_id=$1 AND 'reconciler' = ANY(roles)
             AND user_id != $2 AND user_id != $3
           ORDER BY RANDOM() LIMIT 1`,
          [req.params.id, req.user.id, counterUserId || 0]
        );
        if (reconcilers.rowCount > 0) {
          await client.query(
            `INSERT INTO inventory_count_assignments (line_id, cycle_count_id, user_id, role)
             VALUES ($1,$2,$3,'reconciler')
             ON CONFLICT (line_id, role) DO UPDATE SET user_id=$3, status='pending', submitted_at=NULL`,
            [lineId, req.params.id, reconcilers.rows[0].user_id]
          );
          newLineStatus = 'needs_reconcile';
        } else {
          newLineStatus = 'audited'; // No reconciler available — accept as audited
        }
      } else {
        newLineStatus = 'accepted';
      }

    } else if (role === 'reconciler') {
      // Update variance with reconciler's count
      await client.query(
        `UPDATE inventory_cycle_count_lines
         SET counted_qty=$1, counted_uom_id=$2, variance=$3
         WHERE id=$4 AND cycle_count_id=$5`,
        [qty, resolvedCountedUomId, variance, lineId, req.params.id]
      );
      newLineStatus = 'reconciled';
    }

    await client.query(
      `UPDATE inventory_cycle_count_lines SET line_status=$1 WHERE id=$2 AND cycle_count_id=$3`,
      [newLineStatus, lineId, req.params.id]
    );
    await client.query('COMMIT');
    committed = true;

    // Check for auto-complete
    let autoCompleted = false;
    if (['accepted', 'reconciled', 'overridden', 'audited'].includes(newLineStatus)) {
      try {
        autoCompleted = await checkAutoComplete(companyId, parseInt(req.params.id), req.user.id);
      } catch (autoCompleteError) {
        req.log.error({ err: autoCompleteError }, 'cycle count auto-complete failed after submission');
      }
    }

    const updatedLine = await pool.query(
      `SELECT l.*, i.name as item_name FROM inventory_cycle_count_lines l
       JOIN inventory_items i ON l.item_id = i.id
       WHERE l.id=$1 AND l.cycle_count_id=$2 AND i.company_id=$3`,
      [lineId, req.params.id, companyId]
    );
    res.json({ line: updatedLine.rows[0], auto_completed: autoCompleted });
  } catch (err) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        req.log.error({ err: rollbackErr }, 'cycle count submission rollback failed');
      }
    }
    req.log.error({ err }, 'route error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /api/inventory/cycle-counts/:id/lines/:lineId/override — admin override a line's final value
router.post('/cycle-counts/:id/lines/:lineId/override', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { counted_qty, counted_uom_id, notes } = req.body;
  const qty = parseFloat(counted_qty);
  if (isNaN(qty) || qty < 0) return res.status(400).json({ error: 'counted_qty must be a non-negative number' });
  const notesTrimmed = notes?.trim()?.slice(0, 500) || null;
  if (counted_uom_id != null) {
    const parsedUomId = parseInt(counted_uom_id);
    if (!Number.isInteger(parsedUomId) || parsedUomId <= 0) {
      return res.status(400).json({ error: 'counted_uom_id must be a valid integer' });
    }
  }
  try {
    const cc = await pool.query(
      'SELECT * FROM inventory_cycle_counts WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (cc.rowCount === 0) return res.status(404).json({ error: 'Cycle count not found' });
    if (cc.rows[0].status === 'completed') return res.status(409).json({ error: 'Count is completed. Use reopen first.' });

    const lineRow = await pool.query(
      'SELECT * FROM inventory_cycle_count_lines WHERE id=$1 AND cycle_count_id=$2',
      [req.params.lineId, req.params.id]
    );
    if (lineRow.rowCount === 0) return res.status(404).json({ error: 'Line not found' });
    const line = lineRow.rows[0];

    const resolvedUomId = counted_uom_id != null ? parseInt(counted_uom_id) : line.stock_uom_id;
    let countedFactor = 1;
    if (resolvedUomId != null) {
      const countedUom = await pool.query(
        `SELECT factor FROM inventory_item_uoms
         WHERE id=$1 AND item_id=$2 AND company_id=$3`,
        [resolvedUomId, line.item_id, companyId]
      );
      if (countedUom.rowCount === 0) {
        return res.status(400).json({ error: 'Counted UOM does not belong to this item' });
      }
      countedFactor = parseFloat(countedUom.rows[0].factor);
    }
    let stockFactor = 1;
    if (line.stock_uom_id != null) {
      const stockUom = await pool.query(
        `SELECT factor FROM inventory_item_uoms
         WHERE id=$1 AND item_id=$2 AND company_id=$3`,
        [line.stock_uom_id, line.item_id, companyId]
      );
      if (stockUom.rowCount === 0) throw new Error('Cycle count line has an invalid stock UOM');
      stockFactor = parseFloat(stockUom.rows[0].factor);
    }
    if (!Number.isFinite(countedFactor) || !Number.isFinite(stockFactor) || stockFactor === 0) {
      throw new Error('Cycle count line has an invalid UOM conversion factor');
    }
    const variance = qty * (countedFactor / stockFactor) - parseFloat(line.expected_qty);

    await pool.query(
      `UPDATE inventory_cycle_count_lines
       SET counted_qty=$1, counted_uom_id=$2, variance=$3, notes=$4,
           counted_by=$5, counted_at=NOW(), line_status='overridden'
       WHERE id=$6`,
      [qty, resolvedUomId, variance, notesTrimmed, req.user.id, req.params.lineId]
    );

    const autoCompleted = await checkAutoComplete(companyId, parseInt(req.params.id), req.user.id);
    const updatedLine = await pool.query(
      'SELECT * FROM inventory_cycle_count_lines WHERE id=$1', [req.params.lineId]
    );
    logAudit(companyId, req.user.id, req.user.full_name, 'cycle_count.line_overridden', 'cycle_count_line', req.params.lineId, null,
      { cycle_count_id: req.params.id, item_id: line.item_id, previous_counted: line.counted_qty, new_counted: qty, variance });
    res.json({ line: updatedLine.rows[0], auto_completed: autoCompleted });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/cycle-counts/:id/reopen — admin reopens a completed count
router.post('/cycle-counts/:id/reopen', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `UPDATE inventory_cycle_counts
       SET status='in_progress', completed_by=NULL, completed_at=NULL
       WHERE id=$1 AND company_id=$2 AND status='completed'
       RETURNING *`,
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Completed count not found' });
    // Reset all line statuses to pending so re-completion requires intentional re-evaluation
    // of every line and cannot immediately re-trigger auto-complete (which would double-post
    // stock adjustment transactions for lines that haven't been changed).
    await pool.query(
      `UPDATE inventory_cycle_count_lines SET line_status='pending' WHERE cycle_count_id=$1`,
      [req.params.id]
    );
    // Delete all assignments so the count can be redistributed fresh.
    // Leaving submitted assignments in place blocks distribution (UNIQUE on line_id+role
    // prevents new assignments) and hides lines from My Count (my-assignments filters
    // out submitted). Admin must redistribute after reopen.
    await pool.query(
      `DELETE FROM inventory_count_assignments WHERE cycle_count_id=$1`,
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Setup: Storage Hierarchy (Areas → Racks → Bays → Compartments) ────────────
//
// Generic helpers reused for each level:
//   buildSetupRoutes(prefix, table, parentKey, parentTable)
// Each level supports:
//   GET    /setup/:level          — list (filter by parent + active)
//   POST   /setup/:level          — create
//   PATCH  /setup/:level/:id      — update name/notes/active/photos
//   DELETE /setup/:level/:id      — soft delete (requires no stock references)

function buildSetupRoutes(prefix, table, parentKey, parentTable) {
  // LIST
  router.get(`/setup/${prefix}`, requireAuth, requirePerm('manage_inventory'), async (req, res) => {
    const companyId = req.user.company_id;
    const { active = 'true' } = req.query;
    const parentId = req.query[parentKey];
    try {
      const conds = [`e.company_id = $1`];
      const vals = [companyId]; let idx = 2;
      if (active !== 'all') { conds.push(`e.active = $${idx++}`); vals.push(active !== 'false'); }
      if (parentId) { conds.push(`e.${parentKey} = $${idx++}`); vals.push(parentId); }
      const result = await pool.query(
        `SELECT e.*, p.name as parent_name
         FROM ${table} e
         LEFT JOIN ${parentTable} p ON e.${parentKey} = p.id
         WHERE ${conds.join(' AND ')} ORDER BY e.name`,
        vals
      );
      res.json(result.rows);
    } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
  });

  // CREATE
  router.post(`/setup/${prefix}`, requireAuth, requirePerm('manage_inventory'), async (req, res) => {
    const companyId = req.user.company_id;
    const { name, notes, photo_urls } = req.body;
    const parentId = req.body[parentKey];
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    if (!parentId) return res.status(400).json({ error: `${parentKey} required` });
    try {
      const parentCheck = await pool.query(
        `SELECT id FROM ${parentTable} WHERE id=$1 AND company_id=$2`,
        [parentId, companyId]
      );
      if (parentCheck.rowCount === 0) return res.status(404).json({ error: 'Parent not found' });
      const photos = await processPhotos(photo_urls || [], companyId);
      const result = await pool.query(
        `INSERT INTO ${table} (company_id, ${parentKey}, name, notes, photo_urls)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [companyId, parentId, name.trim(), notes?.trim() || null, JSON.stringify(photos)]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      if (err.storageLimit) return res.status(413).json({ error: err.message, storage_limit: true });
      req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
    }
  });

  // UPDATE
  router.patch(`/setup/${prefix}/:id`, requireAuth, requirePerm('manage_inventory'), async (req, res) => {
    const companyId = req.user.company_id;
    const { name, notes, active, photo_urls } = req.body;
    try {
      const existing = await pool.query(
        `SELECT id FROM ${table} WHERE id=$1 AND company_id=$2`,
        [req.params.id, companyId]
      );
      if (existing.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      const sets = [], vals = [req.params.id, companyId]; let idx = 3;
      if (name !== undefined) { sets.push(`name=$${idx++}`); vals.push(name.trim()); }
      if (notes !== undefined) { sets.push(`notes=$${idx++}`); vals.push(notes?.trim() || null); }
      if (active !== undefined) { sets.push(`active=$${idx++}`); vals.push(!!active); }
      if (photo_urls !== undefined) {
        const processed = await processPhotos(photo_urls, companyId);
        sets.push(`photo_urls=$${idx++}`); vals.push(JSON.stringify(processed));
      }
      if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
      const result = await pool.query(
        `UPDATE ${table} SET ${sets.join(',')} WHERE id=$1 AND company_id=$2 RETURNING *`,
        vals
      );
      res.json(result.rows[0]);
    } catch (err) {
      if (err.storageLimit) return res.status(413).json({ error: err.message, storage_limit: true });
      req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
    }
  });

  // SOFT DELETE
  router.delete(`/setup/${prefix}/:id`, requireAuth, requirePerm('manage_inventory'), async (req, res) => {
    const companyId = req.user.company_id;
    try {
      const result = await pool.query(
        `UPDATE ${table} SET active=false WHERE id=$1 AND company_id=$2 RETURNING id`,
        [req.params.id, companyId]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ success: true });
    } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
  });
}

buildSetupRoutes('areas',        'inventory_areas',        'location_id', 'inventory_locations');
buildSetupRoutes('racks',        'inventory_racks',        'area_id',     'inventory_areas');
buildSetupRoutes('bays',         'inventory_bays',         'rack_id',     'inventory_racks');
buildSetupRoutes('compartments', 'inventory_compartments', 'bay_id',      'inventory_bays');

// ── Suppliers ─────────────────────────────────────────────────────────────────

// GET /api/inventory/suppliers
router.get('/suppliers', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { active = 'true' } = req.query;
  const companyId = req.user.company_id;
  try {
    const conditions = ['company_id = $1'];
    const values = [companyId]; let idx = 2;
    if (active !== 'all') { conditions.push(`active = $${idx++}`); values.push(active !== 'false'); }
    const result = await pool.query(
      `SELECT * FROM inventory_suppliers WHERE ${conditions.join(' AND ')} ORDER BY name`,
      values
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/suppliers
function validateSupplierWebsite(website) {
  if (!website?.trim()) return null; // optional field
  try {
    const parsed = new URL(website.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'website must use http or https';
  } catch {
    return 'website must be a valid URL';
  }
  return null;
}

router.post('/suppliers', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { name, contact_name, phone, email, website, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
  if (contact_name && contact_name.trim().length > 255) return res.status(400).json({ error: 'contact_name too long (max 255 characters)' });
  if (phone && phone.trim().length > 50) return res.status(400).json({ error: 'phone too long (max 50 characters)' });
  if (email && email.trim().length > 255) return res.status(400).json({ error: 'email too long (max 255 characters)' });
  if (notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  const websiteErr = validateSupplierWebsite(website);
  if (websiteErr) return res.status(400).json({ error: websiteErr });
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `INSERT INTO inventory_suppliers (company_id, name, contact_name, phone, email, website, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [companyId, name.trim(), contact_name?.trim() || null, phone?.trim() || null,
       email?.trim() || null, website?.trim() || null, notes?.trim() || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/suppliers/:id
router.patch('/suppliers/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { name, contact_name, phone, email, website, notes, active } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM inventory_suppliers WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Supplier not found' });
    if (name !== undefined && name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
    if (contact_name !== undefined && contact_name && contact_name.trim().length > 255) return res.status(400).json({ error: 'contact_name too long (max 255 characters)' });
    if (phone !== undefined && phone && phone.trim().length > 50) return res.status(400).json({ error: 'phone too long (max 50 characters)' });
    if (email !== undefined && email && email.trim().length > 255) return res.status(400).json({ error: 'email too long (max 255 characters)' });
    if (notes !== undefined && notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
    const sets = [], vals = [req.params.id, companyId]; let idx = 3;
    if (name !== undefined)         { sets.push(`name=$${idx++}`);         vals.push(name.trim()); }
    if (contact_name !== undefined) { sets.push(`contact_name=$${idx++}`); vals.push(contact_name?.trim() || null); }
    if (phone !== undefined)        { sets.push(`phone=$${idx++}`);        vals.push(phone?.trim() || null); }
    if (email !== undefined)        { sets.push(`email=$${idx++}`);        vals.push(email?.trim() || null); }
    if (website !== undefined) {
      const websiteErr = validateSupplierWebsite(website);
      if (websiteErr) return res.status(400).json({ error: websiteErr });
      sets.push(`website=$${idx++}`); vals.push(website?.trim() || null);
    }
    if (notes !== undefined)        { sets.push(`notes=$${idx++}`);        vals.push(notes?.trim() || null); }
    if (active !== undefined)       { sets.push(`active=$${idx++}`);       vals.push(!!active); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const result = await pool.query(
      `UPDATE inventory_suppliers SET ${sets.join(',')} WHERE id=$1 AND company_id=$2 RETURNING *`,
      vals
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/inventory/suppliers/:id  (soft delete)
router.delete('/suppliers/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      'UPDATE inventory_suppliers SET active=false WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ success: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Purchase Orders ───────────────────────────────────────────────────────────

// Generate next PO number for a company: PO-YYYY-NNNN
async function nextPONumber(client, companyId) {
  const year = new Date().getFullYear();
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`inventory_po_number:${companyId}:${year}`]
  );
  const res = await client.query(
    `SELECT COALESCE(MAX(
       CASE WHEN po_number ~ $2
            THEN SUBSTRING(po_number FROM '[0-9]+$')::int
            ELSE 0 END
     ), 0) AS last_number
       FROM purchase_orders
      WHERE company_id=$1`,
    [companyId, `^PO-${year}-[0-9]+$`]
  );
  const seq = parseInt(res.rows[0].last_number, 10) + 1;
  return `PO-${year}-${String(seq).padStart(4, '0')}`;
}

// GET /api/inventory/purchase-orders
router.get('/purchase-orders', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { status, supplier_id, q, limit = 100, offset = 0 } = req.query;
  const companyId = req.user.company_id;
  try {
    const conditions = ['po.company_id = $1'];
    const values = [companyId]; let idx = 2;
    if (status) { conditions.push(`po.status = $${idx++}`); values.push(status); }
    if (supplier_id) { conditions.push(`po.supplier_id = $${idx++}`); values.push(supplier_id); }
    if (q?.trim()) {
      conditions.push(`(
        po.po_number ILIKE $${idx}
        OR po.reference_no ILIKE $${idx}
        OR po.notes ILIKE $${idx}
        OR po.status ILIKE $${idx}
        OR sup.name ILIKE $${idx}
        OR loc.name ILIKE $${idx}
        OR u.full_name ILIKE $${idx}
      )`);
      values.push(`%${q.trim()}%`);
      idx++;
    }
    // Aggregate line stats in a single pre-joined subquery instead of 3 correlated subqueries per PO row
    const result = await pool.query(
      `SELECT po.*,
              sup.name AS supplier_name,
              loc.name AS to_location_name,
              u.full_name AS created_by_name,
              COALESCE(agg.line_count,     0) AS line_count,
              COALESCE(agg.total_ordered,  0) AS total_ordered,
              COALESCE(agg.total_received, 0) AS total_received
       FROM purchase_orders po
       LEFT JOIN inventory_suppliers sup ON po.supplier_id    = sup.id
       LEFT JOIN inventory_locations loc ON po.to_location_id = loc.id
       JOIN  users u ON po.created_by = u.id
       LEFT JOIN (
         SELECT po_id,
                COUNT(*)            AS line_count,
                SUM(qty_ordered)    AS total_ordered,
                SUM(qty_received)   AS total_received
         FROM purchase_order_lines
         GROUP BY po_id
       ) agg ON agg.po_id = po.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY po.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    const totalResult = await pool.query(
      `SELECT COUNT(*)
       FROM purchase_orders po
       LEFT JOIN inventory_suppliers sup ON po.supplier_id    = sup.id
       LEFT JOIN inventory_locations loc ON po.to_location_id = loc.id
       JOIN  users u ON po.created_by = u.id
       WHERE ${conditions.join(' AND ')}`,
      values
    );
    res.json({ orders: result.rows, total: parseInt(totalResult.rows[0].count) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/purchase-orders
router.post('/purchase-orders', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const { supplier_id, order_date, expected_date, to_location_id, notes, reference_no, lines = [] } = req.body;
  if (notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  if (reference_no && reference_no.trim().length > 100) return res.status(400).json({ error: 'reference_no too long (max 100 characters)' });
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (supplier_id) {
      const supplier = await client.query(
        'SELECT id FROM inventory_suppliers WHERE id=$1 AND company_id=$2',
        [supplier_id, companyId]
      );
      if (!supplier.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Supplier not found' }); }
    }
    if (to_location_id) {
      const location = await client.query(
        'SELECT id FROM inventory_locations WHERE id=$1 AND company_id=$2',
        [to_location_id, companyId]
      );
      if (!location.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Location not found' }); }
    }
    const poNumber = await nextPONumber(client, companyId);
    const poResult = await client.query(
      `INSERT INTO purchase_orders
         (company_id, po_number, supplier_id, order_date, expected_date, to_location_id, notes, reference_no, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, poNumber, supplier_id || null,
       order_date || new Date().toISOString().slice(0,10),
       expected_date || null, to_location_id || null,
       notes?.trim() || null, reference_no?.trim() || null, req.user.id]
    );
    const po = poResult.rows[0];
    for (const line of lines) {
      const qtyOrdered = parseFloat(line.qty_ordered);
      if (!line.item_id || isNaN(qtyOrdered) || qtyOrdered <= 0) continue;
      const parsedUnitCost = line.unit_cost != null ? parseFloat(line.unit_cost) : null;
      if (parsedUnitCost !== null && isNaN(parsedUnitCost)) continue; // skip lines with invalid cost
      // Verify item belongs to this company
      const itemCheck = await client.query(
        'SELECT id FROM inventory_items WHERE id=$1 AND company_id=$2',
        [parseInt(line.item_id), companyId]
      );
      if (itemCheck.rowCount === 0) continue;
      if (line.uom_id) {
        const uomCheck = await client.query(
          'SELECT id FROM inventory_item_uoms WHERE id=$1 AND item_id=$2 AND company_id=$3',
          [parseInt(line.uom_id), parseInt(line.item_id), companyId]
        );
        if (!uomCheck.rowCount) continue;
      }
      await client.query(
        `INSERT INTO purchase_order_lines (po_id, item_id, qty_ordered, unit_cost, uom_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [po.id, parseInt(line.item_id), qtyOrdered,
         parsedUnitCost,
         line.uom_id ? parseInt(line.uom_id) : null, line.notes?.trim() || null]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(po);
  } catch (err) {
    await client.query('ROLLBACK');
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// GET /api/inventory/purchase-orders/:id  (with lines)
router.get('/purchase-orders/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const poResult = await pool.query(
      `SELECT po.*,
              sup.name AS supplier_name,
              loc.name AS to_location_name,
              u.full_name AS created_by_name
       FROM purchase_orders po
       LEFT JOIN inventory_suppliers sup ON po.supplier_id    = sup.id
       LEFT JOIN inventory_locations loc ON po.to_location_id = loc.id
       JOIN users u ON po.created_by = u.id
       WHERE po.id=$1 AND po.company_id=$2`,
      [req.params.id, companyId]
    );
    if (poResult.rowCount === 0) return res.status(404).json({ error: 'PO not found' });
    const linesResult = await pool.query(
      `SELECT pol.*, i.name AS item_name, i.sku, i.unit,
              u.unit AS uom_unit, u.unit_spec AS uom_spec
       FROM purchase_order_lines pol
       JOIN inventory_items i ON pol.item_id = i.id
       LEFT JOIN inventory_item_uoms u ON pol.uom_id = u.id
       WHERE pol.po_id = $1 ORDER BY pol.id`,
      [req.params.id]
    );
    res.json({ ...poResult.rows[0], lines: linesResult.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/purchase-orders/:id
router.patch('/purchase-orders/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { supplier_id, order_date, expected_date, to_location_id, notes, reference_no, status } = req.body;
  if (notes !== undefined && notes && notes.trim().length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  if (reference_no !== undefined && reference_no && reference_no.trim().length > 100) return res.status(400).json({ error: 'reference_no too long (max 100 characters)' });
  try {
    const existing = await pool.query(
      'SELECT id, status FROM purchase_orders WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'PO not found' });
    if (supplier_id) {
      const supplier = await pool.query(
        'SELECT id FROM inventory_suppliers WHERE id=$1 AND company_id=$2',
        [supplier_id, companyId]
      );
      if (!supplier.rowCount) return res.status(400).json({ error: 'Supplier not found' });
    }
    if (to_location_id) {
      const location = await pool.query(
        'SELECT id FROM inventory_locations WHERE id=$1 AND company_id=$2',
        [to_location_id, companyId]
      );
      if (!location.rowCount) return res.status(400).json({ error: 'Location not found' });
    }
    const cur = existing.rows[0];
    if (['received', 'cancelled'].includes(cur.status) && status === undefined) {
      return res.status(400).json({ error: `Cannot edit a ${cur.status} PO` });
    }
    const sets = [], vals = [req.params.id, companyId]; let idx = 3;
    if (supplier_id  !== undefined) { sets.push(`supplier_id=$${idx++}`);    vals.push(supplier_id  || null); }
    if (order_date   !== undefined) { sets.push(`order_date=$${idx++}`);     vals.push(order_date); }
    if (expected_date!== undefined) { sets.push(`expected_date=$${idx++}`);  vals.push(expected_date || null); }
    if (to_location_id!==undefined) { sets.push(`to_location_id=$${idx++}`); vals.push(to_location_id || null); }
    if (notes        !== undefined) { sets.push(`notes=$${idx++}`);          vals.push(notes?.trim() || null); }
    if (reference_no !== undefined) { sets.push(`reference_no=$${idx++}`);   vals.push(reference_no?.trim() || null); }
    if (status       !== undefined) {
      const VALID = ['draft','submitted','partial','received','cancelled'];
      if (!VALID.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      sets.push(`status=$${idx++}`); vals.push(status);
      if (status === 'submitted')  { sets.push(`submitted_at=NOW()`); }
      if (status === 'received')   { sets.push(`received_at=NOW()`); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const result = await pool.query(
      `UPDATE purchase_orders SET ${sets.join(',')} WHERE id=$1 AND company_id=$2 RETURNING *`,
      vals
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/inventory/purchase-orders/:id  (hard-delete drafts; cancel others)
router.delete('/purchase-orders/:id', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const existing = await pool.query(
      'SELECT id, status FROM purchase_orders WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'PO not found' });
    const { status } = existing.rows[0];
    if (status === 'received') return res.status(409).json({ error: 'Cannot delete a received PO' });
    if (status === 'draft') {
      await pool.query('DELETE FROM purchase_orders WHERE id=$1', [req.params.id]);
    } else {
      await pool.query(
        'UPDATE purchase_orders SET status=$1, received_at=NULL WHERE id=$2',
        ['cancelled', req.params.id]
      );
    }
    res.json({ success: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/purchase-orders/:id/lines
router.post('/purchase-orders/:id/lines', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { item_id, qty_ordered, unit_cost, uom_id, notes } = req.body;
  const qtyOrdered = parseFloat(qty_ordered);
  if (!item_id || !qty_ordered || isNaN(qtyOrdered) || qtyOrdered <= 0) {
    return res.status(400).json({ error: 'item_id and positive qty_ordered required' });
  }
  const unitCostVal = unit_cost != null && unit_cost !== '' ? parseFloat(unit_cost) : null;
  if (unitCostVal !== null && isNaN(unitCostVal)) return res.status(400).json({ error: 'unit_cost must be a number' });
  if (notes && notes.trim().length > 500) return res.status(400).json({ error: 'notes too long (max 500 characters)' });
  try {
    const po = await pool.query(
      'SELECT id, status FROM purchase_orders WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (po.rowCount === 0) return res.status(404).json({ error: 'PO not found' });
    if (po.rows[0].status !== 'draft') return res.status(409).json({ error: 'Can only add lines to a draft PO' });
    const item = await pool.query('SELECT id FROM inventory_items WHERE id=$1 AND company_id=$2', [item_id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    if (uom_id) {
      const uom = await pool.query(
        'SELECT id FROM inventory_item_uoms WHERE id=$1 AND item_id=$2 AND company_id=$3',
        [uom_id, item_id, companyId]
      );
      if (!uom.rowCount) return res.status(400).json({ error: 'UOM does not belong to this item/company' });
    }
    await pool.query(
      `INSERT INTO purchase_order_lines (po_id, item_id, qty_ordered, unit_cost, uom_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, parseInt(item_id), qtyOrdered,
       unitCostVal,
       uom_id ? parseInt(uom_id) : null, notes?.trim() || null]
    );
    const lines = await pool.query(
      `SELECT pol.*, i.name AS item_name, i.sku, i.unit
       FROM purchase_order_lines pol JOIN inventory_items i ON pol.item_id = i.id
       WHERE pol.po_id=$1 ORDER BY pol.id`,
      [req.params.id]
    );
    res.status(201).json(lines.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /api/inventory/purchase-orders/:id/lines/:lineId
router.patch('/purchase-orders/:id/lines/:lineId', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { qty_ordered, unit_cost, uom_id, notes } = req.body;
  try {
    const po = await pool.query(
      'SELECT id, status FROM purchase_orders WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (po.rowCount === 0) return res.status(404).json({ error: 'PO not found' });
    if (po.rows[0].status !== 'draft') return res.status(409).json({ error: 'Can only edit lines on a draft PO' });
    if (qty_ordered !== undefined) {
      const q = parseFloat(qty_ordered);
      if (isNaN(q) || q <= 0) return res.status(400).json({ error: 'qty_ordered must be a positive number' });
    }
    if (unit_cost !== undefined && unit_cost !== null) {
      if (isNaN(parseFloat(unit_cost))) return res.status(400).json({ error: 'unit_cost must be a number' });
    }
    if (uom_id) {
      const uom = await pool.query(
        `SELECT u.id
           FROM purchase_order_lines pol
           JOIN inventory_item_uoms u ON u.id=$1 AND u.item_id=pol.item_id AND u.company_id=$2
          WHERE pol.id=$3 AND pol.po_id=$4`,
        [uom_id, companyId, req.params.lineId, req.params.id]
      );
      if (!uom.rowCount) return res.status(400).json({ error: 'UOM does not belong to this PO line item/company' });
    }
    const sets = [], vals = [req.params.lineId]; let idx = 2;
    if (qty_ordered !== undefined) { sets.push(`qty_ordered=$${idx++}`); vals.push(parseFloat(qty_ordered)); }
    if (unit_cost   !== undefined) { sets.push(`unit_cost=$${idx++}`);   vals.push(unit_cost != null ? parseFloat(unit_cost) : null); }
    if (uom_id      !== undefined) { sets.push(`uom_id=$${idx++}`);      vals.push(uom_id ? parseInt(uom_id) : null); }
    if (notes       !== undefined) { sets.push(`notes=$${idx++}`);       vals.push(notes?.trim() || null); }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    // Scope by po_id too: the parent PO is verified in-company above, but
    // without `AND po_id` an attacker could pass their own draft PO as :id
    // and a victim company's line as :lineId, mutating another tenant's line.
    vals.push(req.params.id);
    const upd = await pool.query(
      `UPDATE purchase_order_lines SET ${sets.join(',')} WHERE id=$1 AND po_id=$${idx}`,
      vals
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'PO line not found' });
    const lines = await pool.query(
      `SELECT pol.*, i.name AS item_name, i.sku, i.unit
       FROM purchase_order_lines pol JOIN inventory_items i ON pol.item_id = i.id
       WHERE pol.po_id=$1 ORDER BY pol.id`,
      [req.params.id]
    );
    res.json(lines.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/inventory/purchase-orders/:id/lines/:lineId
router.delete('/purchase-orders/:id/lines/:lineId', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const po = await pool.query(
      'SELECT id, status FROM purchase_orders WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (po.rowCount === 0) return res.status(404).json({ error: 'PO not found' });
    if (po.rows[0].status !== 'draft') return res.status(409).json({ error: 'Can only remove lines from a draft PO' });
    await pool.query('DELETE FROM purchase_order_lines WHERE id=$1 AND po_id=$2', [req.params.lineId, req.params.id]);
    const lines = await pool.query(
      `SELECT pol.*, i.name AS item_name, i.sku, i.unit
       FROM purchase_order_lines pol JOIN inventory_items i ON pol.item_id = i.id
       WHERE pol.po_id=$1 ORDER BY pol.id`,
      [req.params.id]
    );
    res.json(lines.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /api/inventory/purchase-orders/:id/receive
router.post('/purchase-orders/:id/receive', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { location_id, lines } = req.body; // lines: [{ line_id, qty_to_receive }]
  if (!location_id) return res.status(400).json({ error: 'location_id required' });
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'lines required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const po = await client.query(
      'SELECT id, status, company_id FROM purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (po.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PO not found' }); }
    if (!['submitted','partial'].includes(po.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Can only receive against a submitted or partial PO' });
    }
    const loc = await client.query('SELECT id FROM inventory_locations WHERE id=$1 AND company_id=$2', [location_id, companyId]);
    if (loc.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Location not found' }); }

    const receivedItemIds = new Set();
    for (const entry of lines) {
      const qty = parseFloat(entry.qty_to_receive);
      if (!entry.line_id || isNaN(qty) || qty <= 0) continue;
      const lineResult = await client.query(
        `SELECT pol.*, ii.unit_cost AS catalog_cost
         FROM purchase_order_lines pol
         JOIN inventory_items ii ON pol.item_id = ii.id
         WHERE pol.id=$1 AND pol.po_id=$2 AND ii.company_id=$3
         FOR UPDATE OF pol`,
        [entry.line_id, req.params.id, companyId]
      );
      if (lineResult.rowCount === 0) continue;
      const line = lineResult.rows[0];
      const remaining = parseFloat(line.qty_ordered) - parseFloat(line.qty_received);
      const actualQty = Math.min(qty, remaining);
      if (actualQty <= 0) continue;
      const unitCost = line.unit_cost != null ? parseFloat(line.unit_cost) : (line.catalog_cost != null ? parseFloat(line.catalog_cost) : null);
      // Create receive transaction
      await client.query(
        `INSERT INTO inventory_transactions
           (company_id, type, item_id, quantity, to_location_id, performed_by, unit_cost, uom_id, supplier_id)
         VALUES ($1,'receive',$2,$3,$4,$5,$6,$7,
           (SELECT supplier_id FROM purchase_orders WHERE id=$8))`,
        [companyId, line.item_id, actualQty, location_id, req.user.id,
         unitCost, line.uom_id || null, req.params.id]
      );
      // Update stock
      await applyStockDelta(client, companyId, line.item_id, location_id, actualQty, {}, line.uom_id || null);
      // Update line qty_received
      await client.query(
        'UPDATE purchase_order_lines SET qty_received = qty_received + $1 WHERE id=$2 AND po_id=$3',
        [actualQty, entry.line_id, req.params.id]
      );
      receivedItemIds.add(line.item_id);
    }

    // Update PO status based on received amounts
    const totals = await client.query(
      `SELECT COALESCE(SUM(qty_ordered),0) AS ordered, COALESCE(SUM(qty_received),0) AS received
       FROM purchase_order_lines WHERE po_id=$1`,
      [req.params.id]
    );
    const { ordered, received } = totals.rows[0];
    let newStatus = 'partial';
    if (parseFloat(received) >= parseFloat(ordered)) newStatus = 'received';
    await client.query(
      `UPDATE purchase_orders SET status=$1${newStatus === 'received' ? ', received_at=NOW()' : ''} WHERE id=$2`,
      [newStatus, req.params.id]
    );

    await client.query('COMMIT');
    // Return updated PO with lines
    const updated = await pool.query(
      `SELECT po.*, sup.name AS supplier_name, loc.name AS to_location_name
       FROM purchase_orders po
       LEFT JOIN inventory_suppliers sup ON po.supplier_id = sup.id
       LEFT JOIN inventory_locations loc ON po.to_location_id = loc.id
       WHERE po.id=$1 AND po.company_id=$2`,
      [req.params.id, companyId]
    );
    const updatedLines = await pool.query(
      `SELECT pol.*, i.name AS item_name, i.sku, i.unit
       FROM purchase_order_lines pol JOIN inventory_items i ON pol.item_id = i.id
       WHERE pol.po_id=$1 ORDER BY pol.id`,
      [req.params.id]
    );
    res.json({ ...updated.rows[0], lines: updatedLines.rows });

    // Fire low-stock alerts for all received items (stock may have dipped below reorder point before this receipt)
    for (const itemId of receivedItemIds) {
      maybeSendLowStockAlert(companyId, itemId).catch(() => {});
    }
  } catch (err) {
    await client.query('ROLLBACK');
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── Purchase Order Email ───────────────────────────────────────────────────────

// POST /api/inventory/purchase-orders/:id/email
router.post('/purchase-orders/:id/email', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    // Load PO + lines + supplier + company
    const poResult = await pool.query(
      `SELECT po.*,
              sup.name AS supplier_name, sup.email AS supplier_email,
              sup.contact_name AS supplier_contact,
              loc.name AS to_location_name,
              u.full_name AS created_by_name,
              co.name AS company_name, co.address AS company_address,
              co.phone AS company_phone, co.contact_email AS company_email
       FROM purchase_orders po
       LEFT JOIN inventory_suppliers sup ON po.supplier_id = sup.id
       LEFT JOIN inventory_locations loc ON po.to_location_id = loc.id
       JOIN users u ON po.created_by = u.id
       JOIN companies co ON po.company_id = co.id
       WHERE po.id = $1 AND po.company_id = $2`,
      [req.params.id, companyId]
    );
    if (poResult.rowCount === 0) return res.status(404).json({ error: 'PO not found' });
    const po = poResult.rows[0];

    if (!po.supplier_email) {
      return res.status(400).json({ error: 'Supplier has no email address on file. Add one in Setup → Suppliers.' });
    }

    const linesResult = await pool.query(
      `SELECT pol.*, i.name AS item_name, i.sku, i.unit
       FROM purchase_order_lines pol
       JOIN inventory_items i ON pol.item_id = i.id
       WHERE pol.po_id = $1 ORDER BY pol.id`,
      [req.params.id]
    );
    const lines = linesResult.rows;
    if (lines.length === 0) return res.status(400).json({ error: 'Cannot email a PO with no line items.' });

    const currency = await companyCurrency(req.user.company_id);
    const fmt = n => n != null ? formatCurrency(n, currency) : '—';
    const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    const lineTotal = lines.reduce((s, l) => s + (l.unit_cost != null ? parseFloat(l.unit_cost) * parseFloat(l.qty_ordered) : 0), 0);
    const hasAnyPricing = lines.some(l => l.unit_cost != null);

    // This email goes to an EXTERNAL supplier, so every DB-sourced string
    // (item names, SKUs, notes, company/supplier fields below) is escaped to
    // prevent stored-XSS / markup injection into the supplier's inbox.
    const tableRows = lines.map(l => {
      const qty = parseFloat(l.qty_ordered);
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-weight:600">${escapeHtml(l.item_name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-family:monospace;font-size:12px;color:#6b7280">${escapeHtml(l.sku) || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)} ${escapeHtml(l.unit)}</td>
        ${hasAnyPricing ? `<td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${l.unit_cost != null ? fmt(l.unit_cost) : '—'}</td>` : ''}
        ${hasAnyPricing ? `<td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:700">${l.unit_cost != null ? fmt(parseFloat(l.unit_cost) * qty) : '—'}</td>` : ''}
        ${l.notes ? `<td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280">${escapeHtml(l.notes)}</td>` : '<td style="padding:8px 10px;border-bottom:1px solid #f3f4f6"></td>'}
      </tr>`;
    }).join('');

    const { sendEmail } = require('../email');
    await sendEmail(
      po.supplier_email,
      `Purchase Order ${po.po_number} from ${po.company_name}`,
      `<div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px">
        <div style="border-bottom:3px solid #92400e;padding-bottom:12px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px">
          <div>
            <h2 style="color:#92400e;margin:0;font-size:22px">Purchase Order</h2>
            <p style="color:#6b7280;margin:4px 0 0;font-size:13px">${escapeHtml(po.po_number)}</p>
          </div>
          <div style="text-align:right;font-size:13px;color:#374151">
            <strong>${escapeHtml(po.company_name)}</strong><br>
            ${po.company_address ? escapeHtml(po.company_address) + '<br>' : ''}
            ${po.company_phone ? escapeHtml(po.company_phone) + '<br>' : ''}
            ${po.company_email ? `<a href="mailto:${escapeHtml(po.company_email)}" style="color:#92400e">${escapeHtml(po.company_email)}</a>` : ''}
          </div>
        </div>

        <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:20px;font-size:13px">
          <div><span style="color:#6b7280;font-size:11px;font-weight:700;text-transform:uppercase;display:block">To</span><strong>${escapeHtml(po.supplier_name)}</strong>${po.supplier_contact ? '<br>' + escapeHtml(po.supplier_contact) : ''}</div>
          <div><span style="color:#6b7280;font-size:11px;font-weight:700;text-transform:uppercase;display:block">Order Date</span>${fmtDate(po.order_date)}</div>
          ${po.expected_date ? `<div><span style="color:#6b7280;font-size:11px;font-weight:700;text-transform:uppercase;display:block">Expected By</span>${fmtDate(po.expected_date)}</div>` : ''}
          ${po.to_location_name ? `<div><span style="color:#6b7280;font-size:11px;font-weight:700;text-transform:uppercase;display:block">Ship To</span>${escapeHtml(po.to_location_name)}</div>` : ''}
          ${po.reference_no ? `<div><span style="color:#6b7280;font-size:11px;font-weight:700;text-transform:uppercase;display:block">Your Ref #</span>${escapeHtml(po.reference_no)}</div>` : ''}
        </div>

        <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px">
          <thead>
            <tr style="background:#f9fafb">
              <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb">Item</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb">SKU</th>
              <th style="padding:8px 10px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb">Qty</th>
              ${hasAnyPricing ? '<th style="padding:8px 10px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb">Unit Price</th>' : ''}
              ${hasAnyPricing ? '<th style="padding:8px 10px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb">Total</th>' : ''}
              <th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb">Notes</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
          ${hasAnyPricing ? `<tfoot><tr style="background:#f0fdf4;border-top:2px solid #d1fae5">
            <td colspan="3" style="padding:10px;font-weight:700">Order Total</td>
            <td colspan="2" style="padding:10px;text-align:right;font-weight:800;font-size:16px">${fmt(lineTotal)}</td>
            <td></td>
          </tr></tfoot>` : ''}
        </table>

        ${po.notes ? `<div style="margin-top:16px;background:#f9fafb;border-radius:8px;padding:12px 16px;font-size:13px"><strong style="font-size:11px;text-transform:uppercase;color:#6b7280">Notes</strong><p style="margin:6px 0 0">${escapeHtml(po.notes)}</p></div>` : ''}

        <p style="margin-top:24px;font-size:12px;color:#9ca3af;border-top:1px solid #f3f4f6;padding-top:16px">
          Please confirm receipt of this purchase order by replying to this email.
          This order was generated by ${po.company_name} via OpsFloa.
        </p>
      </div>`
    );

    res.json({ ok: true, sent_to: po.supplier_email });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Valuation ─────────────────────────────────────────────────────────────────

// GET /api/inventory/valuation
router.get('/valuation', requireAuth, requirePerm('manage_inventory'), async (req, res) => {
  const companyId = req.user.company_id;
  const { location_id, search, name_search, sku_search, category_search, sort = 'name', dir = 'asc', limit = 200, offset = 0 } = req.query;
  try {
    const conditions = ['i.company_id = $1', 'i.active = true'];
    const values = [companyId]; let idx = 2;
    if (location_id) { conditions.push(`s.location_id = $${idx++}`); values.push(location_id); }
    if (search) {
      conditions.push(`(i.name ILIKE $${idx} OR i.sku ILIKE $${idx} OR i.category ILIKE $${idx} OR l.name ILIKE $${idx})`);
      values.push(`%${search}%`); idx++;
    }
    if (name_search) { conditions.push(`i.name ILIKE $${idx++}`); values.push(`%${name_search}%`); }
    if (sku_search) { conditions.push(`i.sku ILIKE $${idx++}`); values.push(`%${sku_search}%`); }
    if (category_search) { conditions.push(`i.category ILIKE $${idx++}`); values.push(`%${category_search}%`); }

    const whereClause = conditions.join(' AND ');
    const sortCols = {
      name: 'i.name',
      sku: 'i.sku',
      category: 'i.category',
      unit: 'i.unit',
      on_hand: 'COALESCE(SUM(s.quantity), 0)',
      unit_cost: 'i.unit_cost',
      total_value: '(COALESCE(SUM(s.quantity), 0) * COALESCE(i.unit_cost, 0))',
    };
    const sortCol = sortCols[sort] || sortCols.name;
    const sortDir = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const orderBy = `ORDER BY ${sortCol} ${sortDir} NULLS LAST, i.name ASC`;

    // Grand total via dedicated aggregation — avoids shipping all rows to Node just to sum
    const totalResult = await pool.query(
      `SELECT COALESCE(SUM(s.quantity * COALESCE(i.unit_cost, 0)), 0) AS grand_total,
              COUNT(DISTINCT i.id) AS total_items
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON i.id = s.item_id AND s.company_id = i.company_id
       LEFT JOIN inventory_locations l ON s.location_id = l.id AND l.active = true
       WHERE ${whereClause}`,
      values
    );

    const result = await pool.query(
      `SELECT i.id, i.name, i.sku, i.category, i.unit, i.unit_cost,
              COALESCE(SUM(s.quantity), 0) AS total_qty,
              COALESCE(SUM(s.quantity), 0) * COALESCE(i.unit_cost, 0) AS total_value,
              json_agg(
                json_build_object(
                  'location_id', l.id,
                  'location_name', l.name,
                  'quantity', s.quantity
                ) ORDER BY l.name
              ) FILTER (WHERE l.id IS NOT NULL) AS locations
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON i.id = s.item_id AND s.company_id = i.company_id
       LEFT JOIN inventory_locations l ON s.location_id = l.id AND l.active = true
       WHERE ${whereClause}
       GROUP BY i.id
       ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, parseInt(limit), parseInt(offset)]
    );

    res.json({
      items: result.rows,
      grand_total: parseFloat(totalResult.rows[0].grand_total),
      total: parseInt(totalResult.rows[0].total_items),
    });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
