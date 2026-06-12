import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { PageIntro, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';
import InventoryStock from '../components/inventory/InventoryStock';
import InventoryItems from '../components/inventory/InventoryItems';
import InventoryTransactions from '../components/inventory/InventoryTransactions';
import InventoryCycleCounts from '../components/inventory/InventoryCycleCounts';
import InventorySetup from '../components/inventory/InventorySetup';
import InventoryValuation from '../components/inventory/InventoryValuation';
import InventoryPurchaseOrders from '../components/inventory/InventoryPurchaseOrders';
import InventoryConversions from '../components/inventory/InventoryConversions';
import MyCount from '../components/MyCount';

import { silentError } from '../errorReporter';
export default function InventoryPage() {
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const [features, setFeatures] = useState({});
  const [projects, setProjects] = useState([]);
  const [locations, setLocations] = useState([]);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [pendingConversions, setPendingConversions] = useState(0);
  const [loading, setLoading] = useState(true);

  const INV_TABS = isAdmin
    ? ['stock', 'items', 'transactions', 'orders', 'cycle', 'valuation', 'conversions', 'setup']
    : ['stock', 'transactions', 'mycount'];
  const normalizeInventoryTab = value => ({ counts: 'cycle' }[value] || value);
  const [poLowStockTrigger, setPoLowStockTrigger] = useState(false);

  const handleReorderClick = () => {
    setPoLowStockTrigger(true);
    switchTab('orders');
  };
  const hashTab = normalizeInventoryTab(window.location.hash.replace('#', ''));
  const [tab, setTab] = useState(INV_TABS.includes(hashTab) ? hashTab : 'stock');
  const switchTab = t => {
    const nextTab = normalizeInventoryTab(t);
    setTab(nextTab);
    history.replaceState(null, '', '#' + nextTab);
  };

  useEffect(() => {
    const syncFromHash = () => {
      const nextHashTab = normalizeInventoryTab(window.location.hash.replace('#', ''));
      if (INV_TABS.includes(nextHashTab)) setTab(nextHashTab);
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [INV_TABS.join('|')]);

  useEffect(() => {
    const init = async () => {
      try {
        const [s, p, l] = await Promise.all([
          getOrFetch('settings', () => api.get('/settings').then(r => r.data)),
          getOrFetch('projects', () => api.get('/projects').then(r => r.data)),
          api.get('/inventory/locations'),
        ]);
        setFeatures(s);
        setProjects(p);
        setLocations(l.data);
        if (isAdmin) {
          api.get('/inventory/stock/low').then(r => setLowStockCount(r.data.length)).catch(silentError('inventorypage'));
          api.get('/inventory/uom-conversions').then(r => setPendingConversions(r.data.filter(u => parseFloat(u.factor) === 1).length)).catch(silentError('inventorypage'));
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [isAdmin]);

  const refreshLocations   = () => api.get('/inventory/locations').then(r => setLocations(r.data)).catch(silentError('inventorypage'));
  const refreshLowStock    = () => isAdmin && api.get('/inventory/stock/low').then(r => setLowStockCount(r.data.length)).catch(silentError('inventorypage'));
  const refreshConversions = () => isAdmin && api.get('/inventory/uom-conversions').then(r => setPendingConversions(r.data.filter(u => parseFloat(u.factor) === 1).length)).catch(silentError('inventorypage'));

  if (loading) return (
    <PageShell currentApp="inventory" features={features} maxWidth={1040}>
      <div className="ops-loading-state">{t.loading || 'Loading…'}</div>
    </PageShell>
  );

  if (!features.module_inventory) {
    return (
      <PageShell currentApp="inventory" features={features} maxWidth={760}>
        <div style={styles.disabled}>
          <h2 style={styles.disabledTitle}>{t.invNotEnabled}</h2>
          <p style={styles.disabledBody}>{t.invNotEnabledBody}</p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell currentApp="inventory" features={features} maxWidth={1040}>
        <PageIntro
          introId="inventory"
          kicker="Inventory"
          title={isAdmin ? 'Keep stock, counts, and orders in one place.' : 'Inventory work for today.'}
          description={isAdmin
            ? 'Start with stock and transactions. Setup, valuation, conversions, and purchase orders stay nearby when you need deeper tools.'
            : 'See stock, record movement, and complete count assignments without digging through admin tools.'}
          meta={isAdmin && (
            <>
              <span className={`ops-pill ${lowStockCount > 0 ? 'attention' : 'good'}`}>{lowStockCount} low stock</span>
              <span className={`ops-pill ${pendingConversions > 0 ? 'attention' : ''}`}>{pendingConversions} conversions to review</span>
            </>
          )}
        />
        <TabBar
          active={tab}
          onChange={switchTab}
          tabs={[
            { id: 'stock',        label: 'Stock', dot: lowStockCount > 0 ? '#f59e0b' : null },
            { id: 'transactions', label: 'Transactions' },
            ...(!isAdmin ? [
              { id: 'mycount',    label: 'My Count' },
            ] : []),
            ...(isAdmin ? [
              { id: 'items',      label: 'Items' },
              { id: 'orders',     label: 'Orders' },
              { id: 'cycle',        label: 'Counts' },
              { id: 'valuation',    label: 'Valuation' },
              { id: 'conversions',  label: 'Conversions', dot: pendingConversions > 0 ? '#d97706' : null },
              { id: 'setup',        label: 'Setup' },
            ] : []),
          ]}
        />

        {tab === 'stock' && (
          <InventoryStock
            isAdmin={isAdmin}
            locations={locations}
            projects={projects}
            settings={features}
            onStockChange={refreshLowStock}
            onReorderClick={isAdmin ? handleReorderClick : null}
          />
        )}
        {tab === 'items' && isAdmin && (
          <InventoryItems onItemChange={refreshLowStock} />
        )}
        {tab === 'transactions' && (
          <InventoryTransactions
            isAdmin={isAdmin}
            locations={locations}
            projects={projects}
            settings={features}
            onTransaction={refreshLowStock}
            onConversionSaved={refreshConversions}
          />
        )}
        {tab === 'cycle' && isAdmin && (
          <InventoryCycleCounts
            locations={locations}
            settings={features}
            onComplete={refreshLowStock}
          />
        )}
        {tab === 'orders' && isAdmin && (
          <InventoryPurchaseOrders
            locations={locations}
            prefillLowStock={poLowStockTrigger}
            onPrefillHandled={() => setPoLowStockTrigger(false)}
          />
        )}
        {tab === 'valuation' && isAdmin && (
          <InventoryValuation locations={locations} />
        )}
        {tab === 'conversions' && isAdmin && (
          <InventoryConversions onConversionChange={refreshConversions} />
        )}
        {tab === 'setup' && isAdmin && (
          <InventorySetup projects={projects} settings={features} />
        )}
        {tab === 'mycount' && !isAdmin && (
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
