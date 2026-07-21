import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useT } from '../../hooks/useT';
import { useAuth } from '../../contexts/AuthContext';
import { formatCurrency, langToLocale } from '../../utils';
import { useCurrency } from '../../contexts/SettingsContext';
import { SkeletonList } from '../Skeleton';
import ColumnHeaderMenu from './ColumnHeaderMenu';
import { safeLocal } from '../../utils/safeStorage';

const VAL_PAGE = 200;
const VAL_MOBILE_VIEW_PREF_KEY = 'inventory_valuation_mobile_view';

function readMobileViewPref() {
  try {
    return safeLocal.getItem(VAL_MOBILE_VIEW_PREF_KEY) === 'list' ? 'list' : 'card';
  } catch {
    return 'card';
  }
}

export default function InventoryValuation({ locations }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const currency = useCurrency();
  const [data, setData] = useState(null);
  const [valTotal, setValTotal] = useState(0);
  const [valOffset, setValOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [showZero, setShowZero] = useState(false);
  const [nameFilter, setNameFilter] = useState('');
  const [skuFilter, setSkuFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [mobileView, setMobileView] = useState(readMobileViewPref);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setValOffset(0);
    try {
      const params = new URLSearchParams({ limit: VAL_PAGE, offset: 0 });
      if (locationFilter) params.set('location_id', locationFilter);
      if (nameFilter) params.set('name_search', nameFilter);
      if (skuFilter) params.set('sku_search', skuFilter);
      if (categoryFilter) params.set('category_search', categoryFilter);
      params.set('sort', sortBy);
      params.set('dir', sortDir);
      const r = await api.get(`/inventory/valuation?${params}`);
      setData(r.data);
      setValTotal(r.data.total);
    } catch {
      setError(t.invValFailedLoad);
    } finally {
      setLoading(false);
    }
  }, [locationFilter, nameFilter, skuFilter, categoryFilter, sortBy, sortDir]);

  const loadMoreVal = async () => {
    const nextOffset = valOffset + VAL_PAGE;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: VAL_PAGE, offset: nextOffset });
      if (locationFilter) params.set('location_id', locationFilter);
      if (nameFilter) params.set('name_search', nameFilter);
      if (skuFilter) params.set('sku_search', skuFilter);
      if (categoryFilter) params.set('category_search', categoryFilter);
      params.set('sort', sortBy);
      params.set('dir', sortDir);
      const r = await api.get(`/inventory/valuation?${params}`);
      setData(prev => ({
        ...r.data,
        items: [...(prev?.items || []), ...r.data.items],
      }));
      setValOffset(nextOffset);
    } catch { /* non-fatal */ }
    finally { setLoadingMore(false); }
  };

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    try {
      safeLocal.setItem(VAL_MOBILE_VIEW_PREF_KEY, mobileView);
    } catch {
      // Storage is best-effort only.
    }
  }, [mobileView]);

  const setColumnSort = (key, dir) => {
    setSortBy(key);
    setSortDir(dir);
  };

  const downloadCSV = () => {
    if (!data) return;
    const rows = visibleItems.map(item => [
      `"${item.name.replace(/"/g, '""')}"`,
      item.sku || '',
      item.category || '',
      item.unit,
      parseFloat(item.total_qty).toFixed(2),
      item.unit_cost != null ? parseFloat(item.unit_cost).toFixed(2) : '',
      parseFloat(item.total_value).toFixed(2),
    ].join(','));
    const header = [t.invValColItem, t.colSku, t.colCategory, t.colUnit, t.invValColOnHand, t.colUnitCost, t.invValColTotalValue].join(',');
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-valuation-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeLocations = locations.filter(l => l.active);
  const visibleItems = data
    ? data.items.filter(item => showZero || parseFloat(item.total_qty) !== 0)
    : [];
  const valuationSuggestions = {
    names: visibleItems.map(item => item.name),
    skus: visibleItems.map(item => item.sku),
    categories: visibleItems.map(item => item.category),
  };

  const fmt = (n) => formatCurrency(parseFloat(n || 0), currency);

  const fmtQty = (n) => {
    const v = parseFloat(n || 0);
    return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  };

  return (
    <div style={s.wrap}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        {(nameFilter || skuFilter || categoryFilter || locationFilter) && (
          <button
            style={s.clearBtn}
            onClick={() => {
              setNameFilter('');
              setSkuFilter('');
              setCategoryFilter('');
              setLocationFilter('');
            }}
          >
            {t.invvlClear}
          </button>
        )}
        <label style={s.toggle}>
          <input type="checkbox" checked={showZero} onChange={e => setShowZero(e.target.checked)} />
          {t.invValIncludeZero}
        </label>
        <button style={{ ...s.csvBtn, ...(!data || visibleItems.length === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadCSV} disabled={!data || visibleItems.length === 0}>
          {t.invValDownloadCSV}
        </button>
      </div>

      <div style={s.mobileControls} className="inventory-mobile-controls">
        <div style={s.mobileViewToggle} aria-label={t.invvlMobileViewLabel}>
          {['card', 'list'].map(mode => (
            <button
              key={mode}
              type="button"
              style={{ ...s.mobileViewBtn, ...(mobileView === mode ? s.mobileViewBtnActive : {}) }}
              onClick={() => setMobileView(mode)}
            >
              {mode === 'card' ? t.invvlViewCards : t.invvlViewList}
            </button>
          ))}
        </div>
      </div>

      {error && <div role="alert" style={s.error}>{error}</div>}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : !data || visibleItems.length === 0 ? (
        <div style={s.empty}>
          <p>{showZero ? t.invValNoItems : t.invValNoStock}</p>
        </div>
      ) : (
        <>
          <div
            className={`inventory-table-wrap inventory-valuation-table-wrap ${mobileView === 'list' ? 'inventory-mobile-table-active' : ''}`}
            style={s.tableWrap}
          >
            <table style={s.table}>
              <thead>
                <tr style={s.thead}>
                  <th style={s.th}>
                    <ColumnHeaderMenu label={t.invValColItem} sortKey="name" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="text" filterValue={nameFilter} onFilter={setNameFilter} suggestions={valuationSuggestions.names} placeholder={t.invValColItem} />
                  </th>
                  <th style={s.th}>
                    <ColumnHeaderMenu label={t.colSku} sortKey="sku" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="text" filterValue={skuFilter} onFilter={setSkuFilter} suggestions={valuationSuggestions.skus} placeholder={t.colSku} />
                  </th>
                  <th style={s.th}>
                    <ColumnHeaderMenu label={t.colCategory} sortKey="category" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} filterType="text" filterValue={categoryFilter} onFilter={setCategoryFilter} suggestions={valuationSuggestions.categories} placeholder={t.colCategory} />
                  </th>
                  <th style={s.th}>
                    <ColumnHeaderMenu label={t.colUnit} sortKey="unit" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} />
                  </th>
                  <th style={{ ...s.th, textAlign: 'right' }}>
                    <ColumnHeaderMenu label={t.invValColOnHand} align="right" sortKey="on_hand" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} />
                  </th>
                  <th style={{ ...s.th, textAlign: 'right' }}>
                    <ColumnHeaderMenu label={t.colUnitCost} align="right" sortKey="unit_cost" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} />
                  </th>
                  <th style={{ ...s.th, textAlign: 'right' }}>
                    <ColumnHeaderMenu label={t.invValColTotalValue} align="right" sortKey="total_value" activeSort={sortBy} sortDir={sortDir} onSort={setColumnSort} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((item, i) => (
                  <tr key={item.id} style={i % 2 === 0 ? s.rowEven : s.row}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{item.name}</td>
                    <td style={{ ...s.td, fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{item.sku || '—'}</td>
                    <td style={s.td}>{item.category || '—'}</td>
                    <td style={{ ...s.td, color: '#6b7280' }}>{item.unit}</td>
                    <td style={{ ...s.td, textAlign: 'right', fontWeight: parseFloat(item.total_qty) < 0 ? 700 : 400,
                      color: parseFloat(item.total_qty) < 0 ? '#dc2626' : '#374151' }}>
                      {fmtQty(item.total_qty)}
                    </td>
                    <td style={{ ...s.td, textAlign: 'right', color: item.unit_cost == null ? '#9ca3af' : '#374151' }}>
                      {item.unit_cost != null ? fmt(item.unit_cost) : <em>{t.invValNotSet}</em>}
                    </td>
                    <td style={{ ...s.td, textAlign: 'right', fontWeight: 700,
                      color: parseFloat(item.total_value) > 0 ? '#111827' : '#9ca3af' }}>
                      {fmt(item.total_value)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={s.totalRow}>
                  <td colSpan={6} style={{ ...s.td, fontWeight: 700, fontSize: 14 }}>
                    {t.invValTotalRow} — {visibleItems.length} {visibleItems.length !== 1 ? t.invValItems : t.invValItem}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right', fontWeight: 800, fontSize: 15, color: '#111827' }}>
                    {fmt(data.grand_total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div
            style={s.mobileCards}
            className={`inventory-mobile-cards ${mobileView === 'list' ? 'inventory-mobile-cards-hidden' : ''}`}
          >
            <div style={s.mobileTotalCard}>
              <span style={s.mobileTotalLabel}>{t.invValTotalRow}</span>
              <strong style={s.mobileTotalValue}>{fmt(data.grand_total)}</strong>
              <span style={s.mobileMuted}>{visibleItems.length} {visibleItems.length !== 1 ? t.invValItems : t.invValItem}</span>
            </div>
            {visibleItems.map(item => (
              <article key={item.id} style={s.mobileCard}>
                <div style={s.mobileCardTop}>
                  <div>
                    <strong style={s.mobileTitle}>{item.name}</strong>
                    <span style={s.mobileSub}>{[item.sku, item.category].filter(Boolean).join(' - ') || item.unit}</span>
                  </div>
                  <strong style={s.mobileValue}>{fmt(item.total_value)}</strong>
                </div>
                <div style={s.mobileMetrics}>
                  <div>
                    <span style={s.mobileLabel}>{t.invValColOnHand}</span>
                    <span style={s.mobileMetric}>{fmtQty(item.total_qty)} {item.unit}</span>
                  </div>
                  <div>
                    <span style={s.mobileLabel}>{t.colUnitCost}</span>
                    <span style={s.mobileMetric}>{item.unit_cost != null ? fmt(item.unit_cost) : t.invValNotSet}</span>
                  </div>
                  <div>
                    <span style={s.mobileLabel}>{t.invValColTotalValue}</span>
                    <span style={s.mobileMetric}>{fmt(item.total_value)}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {(data?.items?.length || 0) < valTotal && (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <button style={{ ...s.csvBtn, ...(loadingMore ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={loadMoreVal} disabled={loadingMore}>
                {loadingMore ? t.loading : t.loadMore}
              </button>
              <span style={{ marginLeft: 10, fontSize: 13, color: '#6b7280' }}>
                {data?.items?.length || 0} / {valTotal}
              </span>
            </div>
          )}

          {/* Per-location breakdown (when no location filter) */}
          {!locationFilter && visibleItems.some(item => item.locations?.length > 0) && (
            <details style={s.details}>
              <summary style={s.detailsSummary}>{t.invValLocationBreakdown}</summary>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr style={s.thead}>
                      <th style={s.th}>{t.invValColItem}</th>
                      <th style={s.th}>{t.invValColLocation}</th>
                      <th style={{ ...s.th, textAlign: 'right' }}>{t.invValColQty}</th>
                      <th style={{ ...s.th, textAlign: 'right' }}>{t.invValColValue}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.flatMap((item, ii) =>
                      (item.locations || []).map((loc, li) => (
                        <tr key={`${item.id}-${loc.location_id}`} style={(ii + li) % 2 === 0 ? s.rowEven : s.row}>
                          <td style={{ ...s.td, fontWeight: 600 }}>{li === 0 ? item.name : ''}</td>
                          <td style={{ ...s.td, color: '#6b7280' }}>{loc.location_name}</td>
                          <td style={{ ...s.td, textAlign: 'right' }}>{fmtQty(loc.quantity)} {item.unit}</td>
                          <td style={{ ...s.td, textAlign: 'right' }}>
                            {item.unit_cost != null ? fmt(parseFloat(loc.quantity) * parseFloat(item.unit_cost)) : '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

const s = {
  wrap:        { padding: 16 },
  toolbar:     { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 },
  searchForm:  { display: 'flex', flex: '1 1 260px', minWidth: 220 },
  searchInput: { flex: 1, padding: '8px 12px', borderRadius: '8px 0 0 8px', border: '1px solid #d1d5db', borderRight: 'none', fontSize: 14, minWidth: 0 },
  searchBtn:   { padding: '8px 14px', borderRadius: '0 8px 8px 0', border: '1px solid #d1d5db', background: '#f9fafb', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  select:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#374151' },
  dirBtn:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  toggle:      { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280', cursor: 'pointer', whiteSpace: 'nowrap' },
  clearBtn:    { padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151', whiteSpace: 'nowrap' },
  csvBtn:      { padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto', whiteSpace: 'nowrap' },
  mobileControls: { display: 'none' },
  mobileViewToggle: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, border: '1px solid #d1d5db', borderRadius: 9, background: '#f8fafc' },
  mobileViewBtn: { border: 'none', borderRadius: 7, padding: '8px 10px', background: 'transparent', color: '#64748b', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  mobileViewBtnActive: { background: '#fff', color: '#111827', boxShadow: '0 1px 3px rgba(15,23,42,0.12)' },
  error:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 14 },
  empty:       { textAlign: 'center', padding: '60px 24px', color: '#6b7280', fontSize: 15 },
  emptyIcon:   { fontSize: 40, marginBottom: 12 },
  tableWrap:   { overflowX: 'auto', borderRadius: 10, border: '1px solid #e5e7eb', paddingBottom: 12, scrollbarGutter: 'stable' },
  table:       { width: '100%', borderCollapse: 'collapse', minWidth: 560 },
  thead:       { background: '#f9fafb' },
  th:          { padding: '10px 12px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', borderBottom: '2px solid #e5e7eb' },
  row:         { borderBottom: '1px solid #f3f4f6' },
  rowEven:     { background: '#fafafa', borderBottom: '1px solid #f3f4f6' },
  td:          { padding: '10px 12px', fontSize: 14, color: '#374151' },
  totalRow:    { background: '#f0fdf4', borderTop: '2px solid #d1fae5' },
  mobileCards: { display: 'none' },
  mobileTotalCard: { background: '#111827', color: '#fff', borderRadius: 10, padding: 14, display: 'grid', gap: 2 },
  mobileTotalLabel: { display: 'block', fontSize: 11, fontWeight: 800, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.05em' },
  mobileTotalValue: { fontSize: 24, lineHeight: 1.15 },
  mobileMuted: { fontSize: 12, color: '#cbd5e1', fontWeight: 700 },
  mobileCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, boxShadow: '0 1px 4px rgba(15,23,42,0.04)' },
  mobileCardTop: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start', marginBottom: 12 },
  mobileTitle: { display: 'block', fontSize: 16, color: '#111827', lineHeight: 1.25 },
  mobileSub: { display: 'block', marginTop: 3, fontSize: 12, color: '#64748b', lineHeight: 1.3 },
  mobileValue: { fontSize: 16, color: '#111827', textAlign: 'right', whiteSpace: 'nowrap' },
  mobileMetrics: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, paddingTop: 10, borderTop: '1px solid #f1f5f9' },
  mobileLabel: { display: 'block', fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 },
  mobileMetric: { display: 'block', fontSize: 13, color: '#334155', lineHeight: 1.35, fontWeight: 700 },
  details:     { marginTop: 24 },
  detailsSummary: { fontSize: 13, fontWeight: 700, color: '#374151', cursor: 'pointer', marginBottom: 12, padding: '8px 0' },
};
