// Material catalog endpoints — search across both stocked inventory_items
// and catalog-only rows (is_stocked=false). Feeds the estimate-line
// picker so estimators don't retype "2x4 stud — $4.20/ea" on every job.

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MONEY_CATEGORIES } = require('../constants/projectMoneyEnums');

// GET /catalog/items — typeahead-friendly search.
router.get('/catalog/items', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const q   = req.query.q?.toString().trim();
  const tag = req.query.tag?.toString().trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length})`);
  }
  if (tag) {
    params.push(tag);
    conditions.push(`$${params.length} = ANY(catalog_tags)`);
  }
  try {
    params.push(limit);
    const r = await pool.query(
      `SELECT id, name, sku, unit_cost, unit, is_stocked,
              sell_price_cents, default_markup_pct, catalog_tags, default_estimate_category
         FROM inventory_items
        WHERE ${conditions.join(' AND ')}
        ORDER BY name ASC
        LIMIT $${params.length}`,
      params
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'catalog list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /catalog/tags — distinct tag list for the picker chips.
router.get('/catalog/tags', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      `SELECT DISTINCT UNNEST(catalog_tags) AS tag
         FROM inventory_items
        WHERE company_id = $1 AND catalog_tags IS NOT NULL
        ORDER BY tag ASC`,
      [companyId]
    );
    res.json({ tags: r.rows.map(row => row.tag) });
  } catch (err) {
    req.log.error({ err }, 'catalog tags error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /catalog/items/:id/estimate-line — resolve to an estimate-ready line
// shape (description, unit, unit_cost_cents derived from sell_price_cents
// or markup, category from default_estimate_category). Saves the client
// from doing the markup math itself.
router.get('/catalog/items/:id/estimate-line', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      `SELECT * FROM inventory_items WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    const item = r.rows[0];
    let unitCost;
    if (item.sell_price_cents != null) {
      unitCost = parseInt(item.sell_price_cents, 10);
    } else if (item.default_markup_pct != null && item.unit_cost != null) {
      const baseCents = Math.round(parseFloat(item.unit_cost) * 100);
      const markup = parseFloat(item.default_markup_pct);
      unitCost = Math.round(baseCents * (1 + markup / 100));
    } else {
      unitCost = item.unit_cost != null ? Math.round(parseFloat(item.unit_cost) * 100) : 0;
    }
    res.json({
      description:         item.name,
      unit:                item.unit || null,
      unit_cost_cents:     unitCost,
      category:            MONEY_CATEGORIES.includes(item.default_estimate_category)
                            ? item.default_estimate_category
                            : 'materials',
      source_item_id:      item.id,
    });
  } catch (err) {
    req.log.error({ err }, 'catalog estimate-line error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
