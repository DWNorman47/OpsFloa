// Material catalog — typeahead-friendly view of inventory_items that
// can pre-fill estimate lines. is_stocked=false rows are pure catalog
// entries (no qty tracking, no inventory adjustments); is_stocked=true
// are stocked items that ALSO appear in the catalog picker.

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/SettingsContext';
import { useCents } from '../hooks/useMoney';
import { formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import api from '../api';
import { PageShell } from '../components/PageShell';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { silentError } from '../errorReporter';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];

export default function CatalogPage() {
  const { user } = useAuth();
  const t = useT();
  const [items, setItems] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [tagFilter, setTagFilter] = useState('');

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

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/catalog/tags').then(({ data }) => setTags(data.tags || [])).catch(() => {});
  }, []);

  return (
    <PageShell currentApp="inventory" maxWidth={1200} headerProps={{ userRole: user?.role }}>
      <div className="admin-page-shell">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' }}>{t.catTitle}</h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
              {t.catIntro}
            </p>
          </div>
        </div>

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
            <EmptyState
              title={t.catEmptyTitle}
              body={t.catEmptyBody}
            />
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
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => (
                    <CatalogRow key={item.id} item={item} onChanged={load} />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </PageShell>
  );
}

function CatalogRow({ item, onChanged }) {
  const formatCents = useCents();
  const currency = useCurrency();
  const formatDollars = dollars => formatCurrency(parseFloat(dollars) || 0, currency);
  const t = useT();
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState(null);
  const sellCents = item.sell_price_cents != null ? parseInt(item.sell_price_cents, 10) : null;

  async function loadPreview() {
    if (preview) { setShowPreview(s => !s); return; }
    try {
      const { data } = await api.get(`/catalog/items/${item.id}/estimate-line`);
      setPreview(data);
      setShowPreview(true);
    } catch (err) {
      silentError(err);
    }
  }

  return (
    <>
      <tr style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }} onClick={loadPreview}>
        <td style={styles.td}><strong>{item.name}</strong></td>
        <td style={styles.td}>{item.sku || '—'}</td>
        <td style={styles.td}>{item.unit || '—'}</td>
        <td style={{ ...styles.td, textAlign: 'right' }}>{item.unit_cost != null ? formatDollars(item.unit_cost) : '—'}</td>
        <td style={{ ...styles.td, textAlign: 'right' }}>{sellCents != null ? formatCents(sellCents) : (item.default_markup_pct ? `${item.default_markup_pct}% ${t.catMkupSuffix}` : '—')}</td>
        <td style={styles.td}>
          {item.default_estimate_category ? (
            <span style={styles.catChip}>{item.default_estimate_category}</span>
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
      </tr>
      {showPreview && preview && (
        <tr style={{ background: '#f0f4ff', borderBottom: '1px solid #c7d2fe' }}>
          <td colSpan={8} style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#3730a3', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              {t.catEstimatePreview}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 14 }}>
              <span><strong>{preview.description}</strong></span>
              <span style={{ color: '#6b7280' }}>{t.catPer} {preview.unit || 'unit'}</span>
              <span style={{ color: '#3730a3', fontWeight: 600 }}>{formatCents(preview.unit_cost_cents)}</span>
              <span style={styles.catChip}>{preview.category}</span>
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
              {t.catPreviewNote}{' '}
              <code style={{ background: '#fff', padding: '1px 4px', borderRadius: 3 }}>GET /catalog/items/{item.id}/estimate-line</code>.
            </div>
          </td>
        </tr>
      )}
    </>
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
};
