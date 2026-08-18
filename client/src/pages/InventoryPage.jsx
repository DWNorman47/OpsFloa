import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../hooks/useT';
import { usePerm } from '../hooks/usePerm';
import { usePlan } from '../hooks/usePlan';
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
import EquipmentLog from '../components/EquipmentLog';
import EquipmentCheckouts from '../components/inventory/EquipmentCheckouts';
import EquipmentRentals from '../components/inventory/EquipmentRentals';
import EquipmentMaintenanceLog from '../components/inventory/EquipmentMaintenanceLog';

import { silentError } from '../errorReporter';
export default function InventoryPage() {
  const t = useT();
  const navigate = useNavigate();
  // Visibility is permission-driven, not role-driven: anyone with view_inventory
  // (or the broader manage_inventory) sees the read/operational views; the
  // management + setup tabs require manage_inventory. The server enforces the
  // same split (reads via requireAuth, writes via requireAdmin).
  const canManage = usePerm('manage_inventory');
  // The Equipment group keeps its own gating (Business plan + manage_equipment),
  // independent of manage_inventory — the server authority is the requirePlan
  // ('business') mount on /api/equipment.
  const { isBusiness } = usePlan();
  const canEquip = usePerm('manage_equipment');
  const showEquipment = isBusiness && canEquip;

  const [features, setFeatures] = useState(null);
  const [projects, setProjects] = useState([]);
  const [locations, setLocations] = useState([]);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [pendingConversions, setPendingConversions] = useState(0);
  const [checkedOutCount, setCheckedOutCount] = useState(0);
  const [rentalDueCount, setRentalDueCount] = useState(0);
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
    // Material Catalog is its own route (/catalog); this tab navigates there
    // rather than rendering inline. See switchTab's intercept.
    { id: 'catalog',     label: t.invTabCatalog },
  ] : [];
  // Equipment group (Business plan + manage_equipment). Consolidated here from
  // the old Field "Equipment Log" tab. M1 ships the Assets tab (the moved
  // EquipmentLog); Checked-out / Rentals / Maintenance land in later milestones.
  const equipmentTabs = showEquipment ? [
    { id: 'eq-assets', label: t.invTabEqAssets },
    { id: 'eq-out', label: t.invTabEqCheckedOut, dot: checkedOutCount > 0 ? '#f59e0b' : null },
    { id: 'eq-rentals', label: t.invTabEqRentals, dot: rentalDueCount > 0 ? '#d97706' : null },
    { id: 'eq-maint', label: t.invTabEqMaint },
  ] : [];
  const equipmentTabIds = equipmentTabs.map(d => d.id);
  const setupTabIds = setupTabs.map(d => d.id);
  const allTabIds = [...opsTabs, ...equipmentTabs, ...setupTabs].map(d => d.id);

  // Legacy hashes: counts→cycle (rename), setup→locations (Setup was split into
  // Locations + Suppliers tabs under the Setup group), equip→eq-assets (Equipment
  // moved here from the Field module).
  const normalizeInventoryTab = value => ({
    counts: 'cycle',
    setup: 'locations',
    pos: 'orders',
    purchase_orders: 'orders',
    purchaseorders: 'orders',
    equip: 'eq-assets',
    equipment: 'eq-assets',
  }[value] || value);
  const hashTab = normalizeInventoryTab(window.location.hash.replace('#', ''));
  const [tab, setTab] = useState(allTabIds.includes(hashTab) ? hashTab : 'stock');
  const group = equipmentTabIds.includes(tab) ? 'equipment'
    : setupTabIds.includes(tab) ? 'setup'
    : 'operations';
  const visibleTabs = group === 'equipment' ? equipmentTabs
    : group === 'setup' ? setupTabs
    : opsTabs;
  const showGroupRow = (canManage && setupTabs.length > 0) || equipmentTabs.length > 0;

  const switchTab = next => {
    const nextTab = normalizeInventoryTab(next);
    // The Catalog tab is a route, not an inline panel — hand off to it.
    if (nextTab === 'catalog') { navigate('/catalog'); return; }
    setTab(nextTab);
    history.replaceState(null, '', '#' + nextTab);
  };
  const switchGroup = g => {
    const first = (g === 'equipment' ? equipmentTabs : g === 'setup' ? setupTabs : opsTabs)[0];
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
          getOrFetch('projects', () => api.get('/work').then(r => r.data)),
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

  // Equipment tab dots: open-checkout count + rentals due soon/overdue.
  const refreshEquipCounts = () => {
    if (!showEquipment) return;
    api.get('/equipment/checkouts').then(r => setCheckedOutCount(r.data.length)).catch(silentError('inventorypage'));
    api.get('/equipment').then(r => {
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 3);
      const c = cutoff.toLocaleDateString('en-CA');
      setRentalDueCount(r.data.filter(a => a.is_rental && a.rental_return_due && a.rental_return_due.toString().substring(0, 10) <= c).length);
    }).catch(silentError('inventorypage'));
  };
  useEffect(() => { refreshEquipCounts(); }, [showEquipment]); // eslint-disable-line react-hooks/exhaustive-deps

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
              onClick={() => switchGroup('operations')}>{t.invGroupStock}</button>
            {equipmentTabs.length > 0 && (
              <button type="button" role="tab" aria-selected={group === 'equipment'}
                className={`ops-workflow-tab ${group === 'equipment' ? 'is-active' : ''}`.trim()}
                onClick={() => switchGroup('equipment')}>{t.invGroupEquipment}</button>
            )}
            {canManage && setupTabs.length > 0 && (
              <button type="button" role="tab" aria-selected={group === 'setup'}
                className={`ops-workflow-tab ${group === 'setup' ? 'is-active' : ''}`.trim()}
                onClick={() => switchGroup('setup')}>{t.invGroupSetup}</button>
            )}
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
        {tab === 'eq-assets' && showEquipment && (
          <EquipmentLog projects={projects} settings={features} />
        )}
        {tab === 'eq-out' && showEquipment && (
          <EquipmentCheckouts projects={projects} settings={features} onChange={refreshEquipCounts} />
        )}
        {tab === 'eq-rentals' && showEquipment && (
          <EquipmentRentals settings={features} onChange={refreshEquipCounts} />
        )}
        {tab === 'eq-maint' && showEquipment && (
          <EquipmentMaintenanceLog />
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
