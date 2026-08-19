// Material catalog endpoints — search across both stocked inventory_items
// and catalog-only rows (is_stocked=false). Feeds the estimate-line
// picker so estimators don't retype "2x4 stud — $4.20/ea" on every job.

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireCommercialAccess } = require('../middleware/commercialAccess');
const { MONEY_CATEGORIES } = require('../constants/projectMoneyEnums');

// Columns returned to the catalog UI after a write — the same shape GET /catalog/items
// yields, so the client can drop the row in without a reload.
const RETURN_COLS = `id, name, sku, unit, unit_cost, is_stocked,
                     sell_price_cents, default_markup_pct, catalog_tags, default_estimate_category`;

// Validate + coerce a catalog item body. `partial:true` (PATCH) only touches keys
// that are present; otherwise `name` is required. Returns cleaned fields + a list
// of human-readable errors. Keys are a fixed allowlist, so the object is safe to
// build column-name SQL from.
function sanitizeItemBody(body = {}, { partial = false } = {}) {
  const out = {};
  const errors = [];
  if (!partial || body.name !== undefined) {
    const name = (body.name ?? '').toString().trim();
    if (!name) errors.push('name is required');
    else if (name.length > 255) errors.push('name must be 255 characters or fewer');
    else out.name = name;
  }
  if (body.sku !== undefined) {
    const sku = body.sku == null ? '' : body.sku.toString().trim();
    if (sku.length > 100) errors.push('sku must be 100 characters or fewer');
    else out.sku = sku || null;
  }
  if (body.unit !== undefined) {
    const unit = body.unit == null ? '' : body.unit.toString().trim();
    if (unit.length > 50) errors.push('unit must be 50 characters or fewer');
    else out.unit = unit || null;  // null → DB default 'each' on insert
  }
  if (body.description !== undefined) {
    out.description = body.description == null ? null : body.description.toString();
  }
  if (body.unit_cost !== undefined) {
    if (body.unit_cost === null || body.unit_cost === '') out.unit_cost = null;
    else {
      const c = Number(body.unit_cost);
      if (!Number.isFinite(c) || c < 0) errors.push('unit_cost must be a non-negative number');
      else out.unit_cost = c;
    }
  }
  if (body.sell_price_cents !== undefined) {
    if (body.sell_price_cents === null || body.sell_price_cents === '') out.sell_price_cents = null;
    else {
      const c = parseInt(body.sell_price_cents, 10);
      if (!Number.isFinite(c) || c < 0) errors.push('sell_price_cents must be a non-negative integer');
      else out.sell_price_cents = c;
    }
  }
  if (body.default_markup_pct !== undefined) {
    if (body.default_markup_pct === null || body.default_markup_pct === '') out.default_markup_pct = null;
    else {
      const c = Number(body.default_markup_pct);
      if (!Number.isFinite(c) || c < 0 || c > 1000) errors.push('default_markup_pct must be between 0 and 1000');
      else out.default_markup_pct = c;
    }
  }
  if (body.default_estimate_category !== undefined) {
    const cat = body.default_estimate_category;
    if (cat === null || cat === '') out.default_estimate_category = null;
    else if (!MONEY_CATEGORIES.includes(cat)) errors.push('default_estimate_category is invalid');
    else out.default_estimate_category = cat;
  }
  if (body.catalog_tags !== undefined) {
    if (body.catalog_tags === null) out.catalog_tags = null;
    else if (!Array.isArray(body.catalog_tags)) errors.push('catalog_tags must be an array');
    else {
      const tags = [...new Set(body.catalog_tags.map(x => (x ?? '').toString().trim()).filter(Boolean))].slice(0, 20);
      if (tags.some(x => x.length > 40)) errors.push('each tag must be 40 characters or fewer');
      else out.catalog_tags = tags;
    }
  }
  return { out, errors };
}

// The company's default markup map ({category: pct}) from the
// `estimate_default_markups` JSON setting. {} on unset/malformed/error, so a
// settings hiccup never breaks a catalog pick. Load once and reuse across an
// assembly expansion to avoid a per-member query.
async function loadCompanyMarkups(companyId) {
  try {
    const r = await pool.query(
      `SELECT value FROM settings WHERE company_id = $1 AND key = 'estimate_default_markups'`,
      [companyId]
    );
    if (!r.rows.length || !r.rows[0].value) return {};
    const map = JSON.parse(r.rows[0].value);
    return map && typeof map === 'object' ? map : {};
  } catch { return {}; }
}

// Default markup % for a category from a preloaded map (or null).
function markupFor(markups, category) {
  const v = Number(markups[category]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// The catalog is the estimate-line picker and exposes supplier cost / sell price /
// markup, so it takes the same gate as estimates — not every authenticated worker.
// GET /catalog/items — typeahead-friendly search.
router.get('/catalog/items', requireAuth, requireCommercialAccess, async (req, res) => {
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
router.get('/catalog/tags', requireAuth, requireCommercialAccess, async (req, res) => {
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

// Resolve one catalog item row to an estimate-ready line shape. Unit price in
// priority: explicit sell price → item markup over cost → company category
// markup over cost → raw cost → 0. Shared by the single-item route and the
// assembly expander.
function resolveEstimateLine(item, markups) {
  let unitCost;
  if (item.sell_price_cents != null) {
    unitCost = parseInt(item.sell_price_cents, 10);
  } else {
    const baseCents = item.unit_cost != null ? Math.round(parseFloat(item.unit_cost) * 100) : null;
    let markup = item.default_markup_pct != null ? parseFloat(item.default_markup_pct) : null;
    if (markup == null && baseCents != null) {
      const cat = MONEY_CATEGORIES.includes(item.default_estimate_category)
        ? item.default_estimate_category : 'materials';
      markup = markupFor(markups, cat);
    }
    if (baseCents != null && markup != null) unitCost = Math.round(baseCents * (1 + markup / 100));
    else unitCost = baseCents != null ? baseCents : 0;
  }
  return {
    description:     item.name,
    unit:           item.unit || null,
    unit_cost_cents: unitCost,  // the PRICE the client sees
    // cost basis (what it costs you) = supplier cost. Null when none on file.
    cost_cents:     item.unit_cost != null ? Math.round(parseFloat(item.unit_cost) * 100) : null,
    category:       MONEY_CATEGORIES.includes(item.default_estimate_category)
                      ? item.default_estimate_category : 'materials',
    source_item_id: item.id,
  };
}

// GET /catalog/items/:id/estimate-line — resolve one catalog item to a line.
router.get('/catalog/items/:id/estimate-line', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      `SELECT * FROM inventory_items WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    const markups = await loadCompanyMarkups(companyId);
    res.json(resolveEstimateLine(r.rows[0], markups));
  } catch (err) {
    req.log.error({ err }, 'catalog estimate-line error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Assemblies (kits) — saved bundles of catalog items ────────────────────────

function sanitizeAssemblyBody(body = {}) {
  const errors = [];
  const name = (body.name ?? '').toString().trim();
  if (!name) errors.push('name is required');
  else if (name.length > 255) errors.push('name must be 255 characters or fewer');
  const notes = body.notes == null ? null : body.notes.toString();
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = [];
  rawItems.forEach((it, i) => {
    const itemId = parseInt(it.item_id, 10);
    if (!Number.isFinite(itemId)) return;  // skip blank rows
    const qty = it.qty == null || it.qty === '' ? 1 : Number(it.qty);
    if (!Number.isFinite(qty) || qty < 0) { errors.push(`row ${i + 1}: invalid qty`); return; }
    items.push({ item_id: itemId, qty, sort_order: i });
  });
  return { name, notes, items, errors };
}

// GET /catalog/assemblies — list with member counts.
router.get('/catalog/assemblies', requireAuth, requireCommercialAccess, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.name, a.notes,
              COUNT(ai.id)::int AS item_count
         FROM estimate_assemblies a
         LEFT JOIN estimate_assembly_items ai ON ai.assembly_id = a.id
        WHERE a.company_id = $1
        GROUP BY a.id
        ORDER BY a.name ASC`,
      [req.user.company_id]
    );
    res.json({ assemblies: r.rows });
  } catch (err) {
    req.log.error({ err }, 'assemblies list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /catalog/assemblies/:id — one assembly with its member items (+ names).
router.get('/catalog/assemblies/:id', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const a = await pool.query('SELECT id, name, notes FROM estimate_assemblies WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (a.rowCount === 0) return res.status(404).json({ error: 'Assembly not found' });
    const items = await pool.query(
      `SELECT ai.item_id, ai.qty, ai.sort_order, i.name, i.unit
         FROM estimate_assembly_items ai
         JOIN inventory_items i ON i.id = ai.item_id
        WHERE ai.assembly_id = $1
        ORDER BY ai.sort_order, ai.id`,
      [req.params.id]
    );
    res.json({ ...a.rows[0], items: items.rows });
  } catch (err) {
    req.log.error({ err }, 'assembly read error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /catalog/assemblies — create.
router.post('/catalog/assemblies', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const { name, notes, items, errors } = sanitizeAssemblyBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = await client.query(
      'INSERT INTO estimate_assemblies (company_id, name, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [companyId, name, notes, req.user.id]
    );
    const assemblyId = a.rows[0].id;
    for (const it of items) {
      // Member must be a catalog item in this company.
      const chk = await client.query('SELECT id FROM inventory_items WHERE id = $1 AND company_id = $2', [it.item_id, companyId]);
      if (chk.rowCount === 0) continue;
      await client.query(
        'INSERT INTO estimate_assembly_items (assembly_id, item_id, qty, sort_order) VALUES ($1,$2,$3,$4)',
        [assemblyId, it.item_id, it.qty, it.sort_order]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ id: assemblyId, name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'assembly create error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// PATCH /catalog/assemblies/:id — replace name/notes + member list.
router.patch('/catalog/assemblies/:id', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const { name, notes, items, errors } = sanitizeAssemblyBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      'UPDATE estimate_assemblies SET name = $3, notes = $4, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, companyId, name, notes]
    );
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Assembly not found' }); }
    await client.query('DELETE FROM estimate_assembly_items WHERE assembly_id = $1', [req.params.id]);
    for (const it of items) {
      const chk = await client.query('SELECT id FROM inventory_items WHERE id = $1 AND company_id = $2', [it.item_id, companyId]);
      if (chk.rowCount === 0) continue;
      await client.query(
        'INSERT INTO estimate_assembly_items (assembly_id, item_id, qty, sort_order) VALUES ($1,$2,$3,$4)',
        [req.params.id, it.item_id, it.qty, it.sort_order]
      );
    }
    await client.query('COMMIT');
    res.json({ id: parseInt(req.params.id, 10), name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'assembly update error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// DELETE /catalog/assemblies/:id
router.delete('/catalog/assemblies/:id', requireAuth, requireCommercialAccess, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM estimate_assemblies WHERE id = $1 AND company_id = $2 RETURNING id', [req.params.id, req.user.company_id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Assembly not found' });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, 'assembly delete error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /catalog/assemblies/:id/estimate-lines — expand to estimate lines. Each
// member resolves live (current catalog prices) and its qty scales the line.
router.get('/catalog/assemblies/:id/estimate-lines', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const a = await pool.query('SELECT id, name FROM estimate_assemblies WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (a.rowCount === 0) return res.status(404).json({ error: 'Assembly not found' });
    const members = await pool.query(
      `SELECT i.*, ai.qty AS member_qty
         FROM estimate_assembly_items ai
         JOIN inventory_items i ON i.id = ai.item_id
        WHERE ai.assembly_id = $1
        ORDER BY ai.sort_order, ai.id`,
      [req.params.id]
    );
    const markups = await loadCompanyMarkups(companyId);  // once, not per member
    const lines = members.rows.map(m => ({
      ...resolveEstimateLine(m, markups),
      qty: parseFloat(m.member_qty) || 1,
    }));
    res.json({ assembly_id: a.rows[0].id, name: a.rows[0].name, lines });
  } catch (err) {
    req.log.error({ err }, 'assembly expand error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /catalog/items — create a catalog-only item (is_stocked=false). Stocked
// items are created in Inventory; the catalog page only makes pure price-book rows.
router.post('/catalog/items', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const { out, errors } = sanitizeItemBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  try {
    const r = await pool.query(
      `INSERT INTO inventory_items
         (company_id, name, sku, description, unit, unit_cost, is_stocked,
          sell_price_cents, default_markup_pct, default_estimate_category, catalog_tags, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'each'),$6,false,$7,$8,$9,$10,$11)
       RETURNING ${RETURN_COLS}`,
      [companyId, out.name, out.sku ?? null, out.description ?? null, out.unit ?? null,
       out.unit_cost ?? null, out.sell_price_cents ?? null, out.default_markup_pct ?? null,
       out.default_estimate_category ?? null, out.catalog_tags ?? null, req.user.id]
    );
    res.status(201).json({ item: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An item with that SKU already exists', code: 'duplicate_sku' });
    req.log.error({ err }, 'catalog create error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /catalog/items/:id — edit any catalog field on the caller's own item.
router.patch('/catalog/items/:id', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const { out, errors } = sanitizeItemBody(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const keys = Object.keys(out);
  if (!keys.length) return res.status(400).json({ error: 'No fields to update' });
  const params = [];
  const sets = keys.map(k => { params.push(out[k]); return `${k} = $${params.length}`; });
  sets.push('updated_at = NOW()');
  params.push(req.params.id);  const idIdx = params.length;
  params.push(companyId);      const coIdx = params.length;
  try {
    const r = await pool.query(
      `UPDATE inventory_items SET ${sets.join(', ')}
        WHERE id = $${idIdx} AND company_id = $${coIdx}
        RETURNING ${RETURN_COLS}`,
      params
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An item with that SKU already exists', code: 'duplicate_sku' });
    req.log.error({ err }, 'catalog update error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /catalog/items/:id — only catalog-only rows. A stocked inventory item
// carries stock + transactions, so it's off-limits here (manage it in Inventory).
router.delete('/catalog/items/:id', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const found = await pool.query(
      'SELECT is_stocked FROM inventory_items WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!found.rowCount) return res.status(404).json({ error: 'Item not found' });
    if (found.rows[0].is_stocked) {
      return res.status(409).json({ error: 'This is a stocked inventory item — manage it in Inventory', code: 'is_stocked' });
    }
    await pool.query('DELETE FROM inventory_items WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, 'catalog delete error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /catalog/items/bulk — paste-a-price-list import. Rows with a SKU that
// already exists UPDATE that item (filling only the values provided); the rest
// INSERT as catalog-only rows. Per-row validation errors are collected and
// reported, not fatal. One transaction so a mid-import DB error rolls back.
router.post('/catalog/items/bulk', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const rows = Array.isArray(req.body.items) ? req.body.items : null;
  if (!rows) return res.status(400).json({ error: 'items must be an array' });
  if (rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 1000) return res.status(400).json({ error: 'Too many rows (max 1000 per import)' });

  const client = await pool.connect();
  let created = 0, updated = 0;
  const errors = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i++) {
      const { out, errors: rowErrors } = sanitizeItemBody(rows[i]);
      if (rowErrors.length) { errors.push({ row: i + 1, error: rowErrors[0] }); continue; }
      if (out.sku) {
        // COALESCE optional fields — a blank cell leaves the existing value alone,
        // so re-importing a partial sheet augments rather than wipes.
        const upd = await client.query(
          `UPDATE inventory_items
              SET name = $3,
                  description = COALESCE($4, description),
                  unit = COALESCE($5, unit),
                  unit_cost = COALESCE($6, unit_cost),
                  sell_price_cents = COALESCE($7, sell_price_cents),
                  default_markup_pct = COALESCE($8, default_markup_pct),
                  default_estimate_category = COALESCE($9, default_estimate_category),
                  catalog_tags = COALESCE($10, catalog_tags),
                  updated_at = NOW()
            WHERE company_id = $1 AND sku = $2`,
          [companyId, out.sku, out.name, out.description ?? null, out.unit ?? null,
           out.unit_cost ?? null, out.sell_price_cents ?? null, out.default_markup_pct ?? null,
           out.default_estimate_category ?? null, out.catalog_tags ?? null]
        );
        if (upd.rowCount > 0) { updated += upd.rowCount; continue; }
      }
      await client.query(
        `INSERT INTO inventory_items
           (company_id, name, sku, description, unit, unit_cost, is_stocked,
            sell_price_cents, default_markup_pct, default_estimate_category, catalog_tags, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5,'each'),$6,false,$7,$8,$9,$10,$11)`,
        [companyId, out.name, out.sku ?? null, out.description ?? null, out.unit ?? null,
         out.unit_cost ?? null, out.sell_price_cents ?? null, out.default_markup_pct ?? null,
         out.default_estimate_category ?? null, out.catalog_tags ?? null, req.user.id]
      );
      created++;
    }
    await client.query('COMMIT');
    res.json({ created, updated, errors });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'catalog bulk import error');
    res.status(500).json({ error: 'Import failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
