import React, { useState, useEffect } from 'react';
import { useT } from '../hooks/useT';
import { usePerm } from '../hooks/usePerm';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { PageIntro, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';
import InventoryStock from '../components/inventory/InventoryStock';
import InventoryItems from '../components/inventory/InventoryItems';
import InventoryTransactions from '../components/inventory/InventoryTransactions';
import InventoryCycleCounts from '../components/inventory/InventoryCycleCounts';
import InventorySetup, { SupplierPanel } from '../components/inventory/InventorySetup';
import InventoryValuation from '../components/inventory/InventoryValuation';
import InventoryPurchaseOrders from '../components/inventory/InventoryPurchaseOrders';
import InventoryConversions from '../components/inventory/InventoryConversions';
import MyCount from '../components/MyCount';

import { silentError } from '../errorReporter';
export default function InventoryPage() {
  const t = useT();
  // Visibility is permission-driven, not role-driven: anyone with view_inventory
  // (or the broader manage_inventory) sees the read/operational views; the
  // management + setup tabs require manage_inventory. The server enforces the
  // same split (reads via requireAuth, writes via requireAdmin).
  const canManage = usePerm('manage_inventory');

  const [features, setFeatures] = useState(null);
  const [projects, setProjects] = useState([]);
  const [locations, setLocations] = useState([]);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [pendingConversions, setPendingConversions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [poLowStockTrigger, setPoLowStockTrigger] = useState(false);

  // Two tab groups (Field-style): Operations is the daily work, Setup is the
  // master data. The Setup group only exists for managers, so view-only users
  // see a single flat row and no group switcher.
  const opsTabs = [
    { id: 'stock',        label: t.invTabStock, dot: lowStockCount > 0 ? '#f59e0b' : null },
    { id: 'transactions', label: t.invTabTransactions },
    ...(!canManage ? [{ id: 'mycount', label: t.myCountTitle }] : []),
    ...(canManage ? [
      { id: 'orders',    label: t.invTabOrders },
      { id: 'cycle',     label: t.invTabCounts },
      { id: 'valuation', label: t.invTabValuation },
    ] : []),
  ];
  const setupTabs = canManage ? [
    { id: 'items',       label: t.invTabItems },
    { id: 'locations',   label: t.invSetupLocations },
    { id: 'suppliers',   label: t.invSetupSuppliers },
    { id: 'conversions', label: t.invTabConversions, dot: pendingConversions > 0 ? '#d97706' : null },
  ] : [];
  const setupTabIds = setupTabs.map(d => d.id);
  const allTabIds = [...opsTabs, ...setupTabs].map(d => d.id);

  // Legacy hashes: counts→cycle (rename), setup→locations (Setup was split into
  // Locations + Suppliers tabs under the Setup group).
  const normalizeInventoryTab = value => ({
    counts: 'cycle',
    setup: 'locations',
    pos: 'orders',
    purchase_orders: 'orders',
    purchaseorders: 'orders',
  }[value] || value);
  const hashTab = normalizeInventoryTab(window.location.hash.replace('#', ''));
  const [tab, setTab] = useState(allTabIds.includes(hashTab) ? hashTab : 'stock');
  const group = setupTabIds.includes(tab) ? 'setup' : 'operations';
  const visibleTabs = group === 'setup' ? setupTabs : opsTabs;
  const showGroupRow = canManage && setupTabs.length > 0;

  const switchTab = next => {
    const nextTab = normalizeInventoryTab(next);
    setTab(nextTab);
    history.replaceState(null, '', '#' + nextTab);
  };
  const switchGroup = g => {
    const first = (g === 'setup' ? setupTabs : opsTabs)[0];
    if (first) switchTab(first.id);
  };

  const handleReorderClick = () => {
    setPoLowStockTrigger(true);
    switchTab('orders');
  };

  useEffect(() => {
    const syncFromHash = () => {
      const nextHashTab = normalizeInventoryTab(window.location.hash.replace('#', ''));
      if (allTabIds.includes(nextHashTab)) setTab(nextHashTab);
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [allTabIds.join('|')]);

  useEffect(() => {
    const init = async () => {
      try {
        const [s, p] = await Promise.all([
          getOrFetch('settings', () => api.get('/settings').then(r => r.data)),
          getOrFetch('projects', () => api.get('/projects').then(r => r.data)),
        ]);
        setFeatures(s);
        setProjects(p);
        if (s?.module_inventory === false) {
          setLocations([]);
          setLowStockCount(0);
          setPendingConversions(0);
          return;
        }
        const [l, low, conversions] = await Promise.all([
          api.get('/inventory/locations').then(r => r.data).catch(err => {
            silentError('inventorypage')(err);
            return [];
          }),
          canManage
            ? api.get('/inventory/stock/low').then(r => r.data).catch(err => {
                silentError('inventorypage')(err);
                return [];
              })
            : Promise.resolve([]),
          canManage
            ? api.get('/inventory/uom-conversions').then(r => r.data).catch(err => {
                silentError('inventorypage')(err);
                return [];
              })
            : Promise.resolve([]),
        ]);
        setLocations(l);
        setLowStockCount(low.length);
        setPendingConversions(conversions.filter(u => parseFloat(u.factor) === 1).length);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [canManage]);

  const refreshLowStock    = () => canManage && api.get('/inventory/stock/low').then(r => setLowStockCount(r.data.length)).catch(silentError('inventorypage'));
  const refreshConversions = () => canManage && api.get('/inventory/uom-conversions').then(r => setPendingConversions(r.data.filter(u => parseFloat(u.factor) === 1).length)).catch(silentError('inventorypage'));

  if (loading) return (
    <PageShell currentApp="inventory" features={features || {}} maxWidth={1040}>
      <div className="ops-loading-state">{t.loading || 'Loading…'}</div>
    </PageShell>
  );

  if (features?.module_inventory === false) {
    return (
      <PageShell currentApp="inventory" features={features || {}} maxWidth={760}>
        <div style={styles.disabled}>
          <h2 style={styles.disabledTitle}>{t.invNotEnabled}</h2>
          <p style={styles.disabledBody}>{t.invNotEnabledBody}</p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell currentApp="inventory" features={features || {}} maxWidth={1040}>
        <PageIntro
          introId="inventory"
          kicker={t.invKicker}
          title={canManage ? t.invIntroTitleManage : t.invIntroTitleWorker}
          description={canManage ? t.invIntroDescManage : t.invIntroDescWorker}
          meta={canManage && (
            <>
              <span className={`ops-pill ${lowStockCount > 0 ? 'attention' : 'good'}`}>{lowStockCount} {t.invPillLowStock}</span>
              <span className={`ops-pill ${pendingConversions > 0 ? 'attention' : ''}`}>{pendingConversions} {t.invPillConversions}</span>
            </>
          )}
        />
        {showGroupRow && (
          <div className="ops-workflow-tabs" role="tablist" aria-label={t.invSectionsAria}>
            <button type="button" role="tab" aria-selected={group === 'operations'}
              className={`ops-workflow-tab ${group === 'operations' ? 'is-active' : ''}`.trim()}
              onClick={() => switchGroup('operations')}>{t.invGroupOperations}</button>
            <button type="button" role="tab" aria-selected={group === 'setup'}
              className={`ops-workflow-tab ${group === 'setup' ? 'is-active' : ''}`.trim()}
              onClick={() => switchGroup('setup')}>{t.invGroupSetup}</button>
          </div>
        )}
        <TabBar active={tab} onChange={switchTab} tabs={visibleTabs} />

        {tab === 'stock' && (
          <InventoryStock
            isAdmin={canManage}
            locations={locations}
            projects={projects}
            settings={features}
            onStockChange={refreshLowStock}
            onReorderClick={canManage ? handleReorderClick : null}
          />
        )}
        {tab === 'items' && canManage && (
          <InventoryItems onItemChange={refreshLowStock} />
        )}
        {tab === 'transactions' && (
          <InventoryTransactions
            isAdmin={canManage}
            locations={locations}
            projects={projects}
            settings={features}
            onTransaction={refreshLowStock}
            onConversionSaved={refreshConversions}
          />
        )}
        {tab === 'cycle' && canManage && (
          <InventoryCycleCounts
            locations={locations}
            settings={features}
            onComplete={refreshLowStock}
          />
        )}
        {tab === 'orders' && canManage && (
          <InventoryPurchaseOrders
            locations={locations}
            prefillLowStock={poLowStockTrigger}
            onPrefillHandled={() => setPoLowStockTrigger(false)}
          />
        )}
        {tab === 'valuation' && canManage && (
          <InventoryValuation locations={locations} />
        )}
        {tab === 'conversions' && canManage && (
          <InventoryConversions onConversionChange={refreshConversions} />
        )}
        {tab === 'locations' && canManage && (
          <InventorySetup projects={projects} settings={features} />
        )}
        {tab === 'suppliers' && canManage && (
          <SupplierPanel />
        )}
        {tab === 'mycount' && !canManage && (
          <MyCount />
        )}
    </PageShell>
  );
}

const HEADER_BG = '#92400e';

const styles = {
  loading:       { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#6b7280' },
  disabled:      { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 12, padding: 24 },
  disabledTitle: { fontSize: 20, fontWeight: 700, color: '#374151', margin: 0 },
  disabledBody:  { fontSize: 14, color: '#6b7280', textAlign: 'center', maxWidth: 340, margin: 0 },
};
