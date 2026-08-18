// Material catalog — the price book that pre-fills estimate lines. Items can be
// added, edited, and bulk-imported here. is_stocked=false rows are pure catalog
// entries (no qty tracking); is_stocked=true are stocked inventory items that
// ALSO surface in the estimate picker (edited here for their catalog fields,
// deleted only from Inventory). Company default markups (applied when an item
// has no sell price / own markup) live in the panel at the top.

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/SettingsContext';
import { useCents } from '../hooks/useMoney';
import { formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import api from '../api';
import { PageShell } from '../components/PageShell';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { silentError } from '../errorReporter';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];
const CATEGORY_LABEL_KEYS = {
  labor: 'estCatLabor', materials: 'estCatMaterials', equipment: 'estCatEquipment',
  subs: 'estCatSubs', overhead: 'estCatOverhead', contingency: 'estCatContingency', other: 'estCatOther',
};

// Route wrapper: the standalone /catalog page. The Inventory module renders
// <CatalogPanel/> inline instead, so the panel itself carries no PageShell.
export default function CatalogPage() {
  const { user } = useAuth();
  return (
    <PageShell currentApp="inventory" maxWidth={1200} headerProps={{ userRole: user?.role }}>
      <CatalogPanel />
    </PageShell>
  );
}

export function CatalogPanel() {
  const t = useT();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [items, setItems] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [editing, setEditing] = useState(null);   // null | {} (new) | item (edit)
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (q) params.q = q;
      if (tagFilter) params.tag = tagFilter;
      const { data } = await api.get('/catalog/items', { params });
      setItems(data.items || []);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [q, tagFilter]);

  const loadTags = useCallback(() => {
    api.get('/catalog/tags').then(({ data }) => setTags(data.tags || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTags(); }, [loadTags]);

  function afterWrite() { load(); loadTags(); }

  async function handleDelete(item) {
    if (item.is_stocked) { toast(t.catDeleteStocked, 'error'); return; }
    if (!await confirm({ title: t.catDeleteConfirmTitle, body: t.catDeleteConfirmBody })) return;
    try {
      await api.delete(`/catalog/items/${item.id}`);
      toast(t.catToastDeleted, 'success');
      afterWrite();
    } catch (err) {
      toast(err.response?.data?.error || t.catSaveError, 'error');
    }
  }

  return (
    <>
      <div className="admin-page-shell">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>{t.catTitle}</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>{t.catIntro}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setImporting(true)} style={styles.ghostBtn}>{t.catImport}</button>
            <button onClick={() => setEditing({})} style={styles.primaryBtn}>{t.catNewItem}</button>
          </div>
        </div>

        <MarkupsPanel toast={toast} />

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <input
            type="search"
            placeholder={t.catSearchPlaceholder}
            value={q}
            onChange={e => setQ(e.target.value)}
            style={styles.searchInput}
          />
          <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={styles.select}>
            <option value="">{t.catAllTags}</option>
            {tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        </div>

        {loading ? <SkeletonList rows={4} /> :
          items.length === 0 ? (
            <EmptyState title={t.catEmptyTitle} body={t.catEmptyBody} />
          ) : (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr style={styles.tableHeader}>
                    <th style={styles.th}>{t.catColName}</th>
                    <th style={styles.th}>{t.catColSku}</th>
                    <th style={styles.th}>{t.catColUnit}</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>{t.catColCost}</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>{t.catColSell}</th>
                    <th style={styles.th}>{t.catColDefaultCategory}</th>
                    <th style={styles.th}>{t.catColTags}</th>
                    <th style={styles.th}>{t.catColType}</th>
                    <th style={{ ...styles.th, textAlign: 'right' }}>{t.catActions}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <CatalogRow
                      key={item.id}
                      item={item}
                      onEdit={() => setEditing(item)}
                      onDelete={() => handleDelete(item)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>

      {editing && (
        <ItemEditor
          item={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); afterWrite(); }}
          toast={toast}
        />
      )}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={() => { afterWrite(); }}
          toast={toast}
        />
      )}
      {dialog}
    </>
  );
}

function CatalogRow({ item, onEdit, onDelete }) {
  const formatCents = useCents();
  const currency = useCurrency();
  const formatDollars = dollars => formatCurrency(parseFloat(dollars) || 0, currency);
  const t = useT();
  const sellCents = item.sell_price_cents != null ? parseInt(item.sell_price_cents, 10) : null;

  return (
    <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
      <td style={styles.td}><strong>{item.name}</strong></td>
      <td style={styles.td}>{item.sku || '—'}</td>
      <td style={styles.td}>{item.unit || '—'}</td>
      <td style={{ ...styles.td, textAlign: 'right' }}>{item.unit_cost != null ? formatDollars(item.unit_cost) : '—'}</td>
      <td style={{ ...styles.td, textAlign: 'right' }}>{sellCents != null ? formatCents(sellCents) : (item.default_markup_pct ? `${item.default_markup_pct}% ${t.catMkupSuffix}` : '—')}</td>
      <td style={styles.td}>
        {item.default_estimate_category ? (
          <span style={styles.catChip}>{t[CATEGORY_LABEL_KEYS[item.default_estimate_category]] || item.default_estimate_category}</span>
        ) : '—'}
      </td>
      <td style={styles.td}>
        {item.catalog_tags?.length ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {item.catalog_tags.map(tag => (
              <span key={tag} style={styles.tagChip}>{tag}</span>
            ))}
          </div>
        ) : '—'}
      </td>
      <td style={styles.td}>
        <span style={item.is_stocked ? styles.stockChip : styles.catalogOnlyChip}>
          {item.is_stocked ? t.catStocked : t.catCatalogOnly}
        </span>
      </td>
      <td style={{ ...styles.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button onClick={onEdit} style={styles.linkBtn}>{t.catEdit}</button>
        {!item.is_stocked && (
          <button onClick={onDelete} style={{ ...styles.linkBtn, color: '#b91c1c' }}>{t.catDelete}</button>
        )}
      </td>
    </tr>
  );
}

// ── Item editor (create / edit) ───────────────────────────────────────────────

function ItemEditor({ item, onClose, onSaved, toast }) {
  const t = useT();
  const isEdit = !!item;
  const [form, setForm] = useState(() => ({
    name: item?.name || '',
    sku: item?.sku || '',
    unit: item?.unit || '',
    unit_cost: item?.unit_cost != null ? String(item.unit_cost) : '',
    sell: item?.sell_price_cents != null ? (parseInt(item.sell_price_cents, 10) / 100).toFixed(2) : '',
    markup: item?.default_markup_pct != null ? String(item.default_markup_pct) : '',
    category: item?.default_estimate_category || '',
    tags: (item?.catalog_tags || []).join(', '),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function buildPayload() {
    const p = {
      name: form.name.trim(),
      sku: form.sku.trim() || null,
      unit: form.unit.trim() || null,
      unit_cost: form.unit_cost === '' ? null : Number(form.unit_cost),
      sell_price_cents: form.sell === '' ? null : Math.round(Number(form.sell) * 100),
      default_markup_pct: form.markup === '' ? null : Number(form.markup),
      default_estimate_category: form.category || null,
      catalog_tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
    };
    return p;
  }

  async function save() {
    if (!form.name.trim()) { setError(`${t.catFieldName} — ${t.estRequired}`); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      if (isEdit) await api.patch(`/catalog/items/${item.id}`, payload);
      else await api.post('/catalog/items', payload);
      toast(isEdit ? t.catToastUpdated : t.catToastCreated, 'success');
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || t.catSaveError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <h3 style={styles.modalTitle}>{isEdit ? t.catFormEditTitle : t.catFormNewTitle}</h3>
      {error && <div style={styles.errorBox}>{error}</div>}
      <div style={styles.formGrid}>
        <Labeled label={t.catFieldName} full>
          <input value={form.name} onChange={e => set('name', e.target.value)} style={styles.input} autoFocus />
        </Labeled>
        <Labeled label={t.catFieldSku}>
          <input value={form.sku} onChange={e => set('sku', e.target.value)} style={styles.input} />
        </Labeled>
        <Labeled label={t.catFieldUnit}>
          <input value={form.unit} onChange={e => set('unit', e.target.value)} placeholder="each" style={styles.input} />
        </Labeled>
        <Labeled label={t.catFieldCost}>
          <input type="number" step="0.01" min="0" value={form.unit_cost} onChange={e => set('unit_cost', e.target.value)} style={styles.input} />
        </Labeled>
        <Labeled label={t.catFieldSell}>
          <input type="number" step="0.01" min="0" value={form.sell} onChange={e => set('sell', e.target.value)} style={styles.input} />
        </Labeled>
        <Labeled label={t.catFieldMarkup}>
          <input type="number" step="0.1" min="0" max="1000" value={form.markup} onChange={e => set('markup', e.target.value)} style={styles.input} />
        </Labeled>
        <Labeled label={t.catFieldCategory}>
          <select value={form.category} onChange={e => set('category', e.target.value)} style={styles.input}>
            <option value="">{t.catNone}</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{t[CATEGORY_LABEL_KEYS[c]]}</option>)}
          </select>
        </Labeled>
        <Labeled label={t.catFieldTags} full hint={t.catTagsHint}>
          <input value={form.tags} onChange={e => set('tags', e.target.value)} style={styles.input} />
        </Labeled>
      </div>
      <p style={styles.priceHint}>{t.catPriceHint}</p>
      <div style={styles.modalActions}>
        <button onClick={onClose} style={styles.ghostBtn}>{t.catCancel}</button>
        <button onClick={save} disabled={saving} style={styles.primaryBtn}>{saving ? t.catSaving : t.catSave}</button>
      </div>
    </Overlay>
  );
}

// ── Bulk import ────────────────────────────────────────────────────────────────

// Parse pasted spreadsheet text into item rows. Tab-delimited when any tab is
// present (the Excel/Sheets copy format), else comma. Columns in order:
// Name, SKU, Unit, Supplier cost, Sell price, Markup %, Category, Tags.
function parseImport(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  if (!lines.length) return [];
  const delim = text.includes('\t') ? '\t' : ',';
  const rows = lines.map(l => l.split(delim).map(c => c.trim()));
  // Skip a header row when the first cell reads like a column name.
  let start = 0;
  const first = (rows[0][0] || '').toLowerCase();
  if (first === 'name' || first === 'item') start = 1;
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const [name, sku, unit, cost, sell, markup, category, tags] = rows[i];
    if (!name) continue;
    const item = { name };
    if (sku) item.sku = sku;
    if (unit) item.unit = unit;
    if (cost) { const n = parseFloat(cost.replace(/[$,]/g, '')); if (Number.isFinite(n)) item.unit_cost = n; }
    if (sell) { const n = parseFloat(sell.replace(/[$,]/g, '')); if (Number.isFinite(n)) item.sell_price_cents = Math.round(n * 100); }
    if (markup) { const n = parseFloat(markup.replace('%', '')); if (Number.isFinite(n)) item.default_markup_pct = n; }
    if (category && CATEGORIES.includes(category.toLowerCase())) item.default_estimate_category = category.toLowerCase();
    if (tags) item.catalog_tags = tags.split(/[;,|]/).map(s => s.trim()).filter(Boolean);
    out.push(item);
  }
  return out;
}

function ImportModal({ onClose, onDone, toast }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function run() {
    const items = parseImport(text);
    if (!items.length) { toast(t.catImportEmpty, 'error'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/catalog/items/bulk', { items });
      setResult(data);
      onDone();
    } catch (err) {
      toast(err.response?.data?.error || t.catImportError, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose} wide>
      <h3 style={styles.modalTitle}>{t.catImportTitle}</h3>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>{t.catImportHelp}</p>
      {result ? (
        <div>
          <div style={styles.resultBox}>
            <strong>{result.created}</strong> {t.catImportCreated}
            {' · '}<strong>{result.updated}</strong> {t.catImportUpdated}
            {result.errors?.length ? <> {' · '}<strong>{result.errors.length}</strong> {t.catImportRowErrors}</> : null}
          </div>
          {result.errors?.length ? (
            <ul style={styles.errorList}>
              {result.errors.slice(0, 20).map((e, i) => (
                <li key={i}>Row {e.row}: {e.error}</li>
              ))}
            </ul>
          ) : null}
          <div style={styles.modalActions}>
            <button onClick={onClose} style={styles.primaryBtn}>{t.catImportDone}</button>
          </div>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={t.catImportPlaceholder}
            style={styles.importArea}
            autoFocus
          />
          <div style={styles.modalActions}>
            <button onClick={onClose} style={styles.ghostBtn}>{t.catCancel}</button>
            <button onClick={run} disabled={busy} style={styles.primaryBtn}>{busy ? t.catImporting : t.catImportRun}</button>
          </div>
        </>
      )}
    </Overlay>
  );
}

// ── Company default markups ────────────────────────────────────────────────────

function MarkupsPanel({ toast }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [vals, setVals] = useState({});   // { materials: '20', ... } strings for inputs

  async function openPanel() {
    setOpen(o => !o);
    if (loaded) return;
    try {
      const { data } = await api.get('/admin/settings');
      let map = {};
      if (data.estimate_default_markups) {
        try { map = JSON.parse(data.estimate_default_markups) || {}; } catch { map = {}; }
      }
      const next = {};
      CATEGORIES.forEach(c => { next[c] = map[c] != null ? String(map[c]) : ''; });
      setVals(next);
      setLoaded(true);
    } catch (err) { silentError(err); }
  }

  async function save() {
    const map = {};
    for (const c of CATEGORIES) {
      const v = vals[c];
      if (v !== '' && v != null) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) map[c] = n;
      }
    }
    setSaving(true);
    try {
      await api.patch('/admin/settings', { estimate_default_markups: Object.keys(map).length ? JSON.stringify(map) : '' });
      toast(t.catMarkupsSaved, 'success');
    } catch (err) {
      toast(err.response?.data?.error || t.catMarkupsError, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.markupsWrap}>
      <button onClick={openPanel} style={styles.markupsToggle}>
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▸</span>
        {t.catMarkupsTitle}
      </button>
      {open && (
        <div style={styles.markupsBody}>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>{t.catMarkupsHint}</p>
          {!loaded ? <SkeletonList rows={1} /> : (
            <>
              <div style={styles.markupsGrid}>
                {CATEGORIES.map(c => (
                  <label key={c} style={styles.markupField}>
                    <span style={styles.markupLabel}>{t[CATEGORY_LABEL_KEYS[c]]}</span>
                    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                      <input
                        type="number" step="0.1" min="0" max="1000"
                        value={vals[c] ?? ''}
                        onChange={e => setVals(v => ({ ...v, [c]: e.target.value }))}
                        style={{ ...styles.input, width: 90, paddingRight: 22, textAlign: 'right' }}
                      />
                      <span style={{ position: 'absolute', right: 8, color: '#9ca3af', fontSize: 13, pointerEvents: 'none' }}>%</span>
                    </span>
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <button onClick={save} disabled={saving} style={styles.primaryBtn}>{saving ? t.catSaving : t.catMarkupsSave}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small building blocks ──────────────────────────────────────────────────────

function Overlay({ children, onClose, wide }) {
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: wide ? 640 : 520 }} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function Labeled({ label, hint, full, children }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <label style={styles.fieldLabel}>{label}{hint ? <span style={styles.fieldHint}> · {hint}</span> : null}</label>
      {children}
    </div>
  );
}

const styles = {
  searchInput: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, flex: 1, minWidth: 240 },
  select: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff' },
  tableWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  td: { padding: '12px 14px', color: '#111827' },
  catChip: { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: '#dbeafe', color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.04em' },
  tagChip: { fontSize: 11, padding: '2px 6px', borderRadius: 8, background: '#f3f4f6', color: '#374151' },
  stockChip: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: '#d1fae5', color: '#065f46', textTransform: 'uppercase', letterSpacing: '0.04em' },
  catalogOnlyChip: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: '#fef3c7', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' },
  primaryBtn: { background: '#1d4ed8', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  linkBtn: { background: 'transparent', border: 'none', color: '#1d4ed8', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '2px 8px' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px', zIndex: 100, overflowY: 'auto' },
  modal: { background: '#fff', borderRadius: 12, padding: 24, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  modalTitle: { fontSize: 18, fontWeight: 700, margin: '0 0 16px', color: '#111827' },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  fieldLabel: { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  fieldHint: { fontWeight: 400, color: '#9ca3af' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', background: '#fff' },
  priceHint: { fontSize: 12, color: '#6b7280', margin: '12px 0 0' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 },
  errorBox: { background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', fontSize: 13, marginBottom: 12 },
  importArea: { width: '100%', boxSizing: 'border-box', minHeight: 200, padding: 12, border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre', overflowX: 'auto' },
  resultBox: { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', borderRadius: 8, padding: '10px 14px', fontSize: 14 },
  errorList: { fontSize: 12, color: '#b91c1c', margin: '10px 0 0', paddingLeft: 18, maxHeight: 160, overflowY: 'auto' },
  markupsWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', marginBottom: 16 },
  markupsToggle: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '12px 16px', fontSize: 14, fontWeight: 600, color: '#111827', cursor: 'pointer' },
  markupsBody: { padding: '0 16px 16px' },
  markupsGrid: { display: 'flex', flexWrap: 'wrap', gap: 16 },
  markupField: { display: 'flex', flexDirection: 'column', gap: 4 },
  markupLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' },
};
