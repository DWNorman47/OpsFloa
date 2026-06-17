/**
 * Team module — worker-facing directory with an admin-only Manage sub-tab.
 *
 * Directory: everyone-in-the-company view (name, role, classification).
 * Manage:    embedded ManageWorkers; identical to the old Administration → Team
 *            tab which is being deprecated.
 */

import React, { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { useHasAnyPerm } from '../hooks/usePerm';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { PageIntro, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';
import ErrorBoundary from '../components/ErrorBoundary';
import RetryBanner from '../components/RetryBanner';
import EmptyState from '../components/EmptyState';
import Pagination from '../components/Pagination';
import ManageClients from '../components/ManageClients';
import { SubsDirectoryPanel } from './SubsPage';
import { silentError } from '../errorReporter';

const ManageWorkers = lazy(() => import('../components/ManageWorkers'));
const ManageRoles   = lazy(() => import('../components/ManageRoles'));

// The three record types the Directory unifies. Each gets a distinct colored
// chip so a row reads as a person / a sub firm / a customer at a glance.
const DIR_TYPES = {
  team:     { label: 'Team',     chip: { background: '#e0e7ff', color: '#3730a3' }, avatar: { background: '#e0e7ff', color: '#3730a3' } },
  sub:      { label: 'Sub',      chip: { background: '#ffedd5', color: '#9a3412' }, avatar: { background: '#ffedd5', color: '#9a3412' } },
  customer: { label: 'Customer', chip: { background: '#cffafe', color: '#155e75' }, avatar: { background: '#cffafe', color: '#155e75' } },
};

function TabLoader() {
  return <div className="ops-loading-state">Loading...</div>;
}

function plural(label) {
  if (!label) return '';
  if (/s$/i.test(label)) return label;
  if (/y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

const ROLE_META = {
  worker:      { bg: '#e0e7ff', fg: '#3730a3' },
  admin:       { bg: '#fef3c7', fg: '#92400e' },
  super_admin: { bg: '#fee2e2', fg: '#991b1b' },
};
const roleLabel = (role, t, workerLabel = null) => ({
  worker:      workerLabel || t.workerRole,
  admin:       t.adminRole,
  super_admin: t.superAdminRole,
}[role] || role);

const workerTypeLabel = (type, t) => ({
  employee:      t.workerTypeEmployee,
  contractor:    t.workerTypeContractor,
  subcontractor: t.workerTypeSubcontractor,
  owner:         t.workerTypeOwner,
}[type] || type);

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last  = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Normalize the three record types into one shape the roster can render.
// `searchText` is everything we let the search box match against.
function toEntries({ team, subs, clients, t, workerLabel, clientLabel }) {
  const out = [];
  for (const m of team) {
    out.push({
      key: `team-${m.id}`, type: 'team', name: m.full_name || m.username,
      line2: `@${m.username}`,
      pills: [
        { text: roleLabel(m.role, t, workerLabel), ...(ROLE_META[m.role] || ROLE_META.worker), strong: true },
        ...(m.worker_type && m.role === 'worker' ? [{ text: workerTypeLabel(m.worker_type, t) }] : []),
        ...(m.classification ? [{ text: m.classification, bg: '#d1fae5', fg: '#065f46' }] : []),
      ],
      pending: m.must_change_password,
      searchText: `${m.full_name || ''} ${m.username || ''} ${m.classification || ''}`.toLowerCase(),
    });
  }
  for (const sub of subs) {
    out.push({
      key: `sub-${sub.id}`, type: 'sub', name: sub.name,
      line2: sub.contact_name || sub.contact_email || '',
      pills: [
        ...(sub.scope_specialty ? [{ text: sub.scope_specialty, bg: '#ffedd5', fg: '#9a3412' }] : []),
        ...(sub.license_number ? [{ text: `Lic ${sub.license_number}` }] : []),
      ],
      searchText: `${sub.name || ''} ${sub.contact_name || ''} ${sub.scope_specialty || ''}`.toLowerCase(),
    });
  }
  for (const c of clients) {
    out.push({
      key: `customer-${c.id}`, type: 'customer', name: c.name,
      line2: c.contact_name || c.email || '',
      pills: [
        ...(c.contact_phone ? [{ text: c.contact_phone }] : []),
      ],
      searchText: `${c.name || ''} ${c.contact_name || ''} ${c.email || ''}`.toLowerCase(),
    });
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

const DIR_PAGE_SIZE = 30;

function DirectoryView({ entries, loading, search, onSearchChange, typeFilter, onTypeFilterChange, availableTypes, counts, t }) {
  const [page, setPage] = useState(1);
  const lower = search.trim().toLowerCase();
  const filtered = entries.filter(e =>
    (typeFilter === 'all' || e.type === typeFilter) &&
    (!lower || e.searchText.includes(lower))
  );

  // Reset to the first page whenever the result set changes.
  useEffect(() => { setPage(1); }, [search, typeFilter, entries.length]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / DIR_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * DIR_PAGE_SIZE, safePage * DIR_PAGE_SIZE);

  if (loading) return <TabLoader />;

  // Only offer the type filter when more than one type is present.
  const showFilter = availableTypes.length > 1;
  const filterButtons = ['all', ...availableTypes];

  return (
    <div>
      {showFilter && (
        <div className="ops-dir-filter" role="tablist" aria-label="Filter by type">
          {filterButtons.map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={typeFilter === id}
              className={`ops-dir-filter-btn ${typeFilter === id ? 'is-active' : ''}`.trim()}
              onClick={() => onTypeFilterChange(id)}
            >
              {id === 'all' ? t.dirFilterAll : DIR_TYPES[id].label}
              <span className="ops-dir-filter-count">{id === 'all' ? counts.all : counts[id]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="ops-directory-toolbar">
        <input
          type="search"
          placeholder={t.dirSearchPlaceholder}
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          className="ops-directory-search"
          aria-label={t.dirSearchPlaceholder}
        />
        <span className="ops-directory-count">
          {filtered.length} {filtered.length === 1 ? t.teamPersonSingular : t.teamPersonPlural}
        </span>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          mark="D"
          title={lower || typeFilter !== 'all' ? t.teamNoMatches : t.dirEmptyTitle}
          body={lower || typeFilter !== 'all' ? 'Try a different name or filter.' : t.dirEmptyBody}
        />
      ) : (
        <div className="ops-directory-grid">
          {pageItems.map(e => {
            const meta = DIR_TYPES[e.type];
            return (
              <div key={e.key} className="ops-person-card">
                <div className="ops-avatar" style={meta.avatar}>{initials(e.name)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ops-person-name">
                    {e.name}
                    {e.pending && <span style={s.pendingPill} title={t.teamNotSignedInYet}>{t.teamPendingBadge}</span>}
                  </div>
                  <div className="ops-person-meta">
                    {showFilter && <span style={{ ...s.typeChip, ...meta.chip }}>{meta.label}</span>}
                    {e.pills.map((p, i) => (
                      <span
                        key={i}
                        style={p.strong
                          ? { ...s.rolePill, background: p.bg, color: p.fg }
                          : { ...s.typePill, ...(p.bg ? { background: p.bg, color: p.fg } : {}) }}
                      >
                        {p.text}
                      </span>
                    ))}
                  </div>
                  {e.line2 && <div className="ops-person-username">{e.line2}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Pagination page={safePage} pages={pageCount} onChange={setPage} />
    </div>
  );
}

export default function TeamPage() {
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  // Per-tab capability. Team/Roles use granular perms; Subs/Customers writes
  // are admin-gated server-side, so they follow role.
  const canManageTeam  = useHasAnyPerm(['manage_workers', 'view_workers_list']);
  const canManageRoles = useHasAnyPerm(['manage_roles', 'assign_roles']);

  const [features, setFeatures] = useState({});
  const [team, setTeam] = useState([]);
  const [teamLoading, setTeamLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  // Admin-only state (workers, settings) — fetched when the admin opens the
  // Team manage tab. Keeps worker page loads lean.
  const [adminWorkers, setAdminWorkers] = useState([]);
  const [adminSettings, setAdminSettings] = useState(null);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminLoadError, setAdminLoadError] = useState(null);
  // Extra records the unified Directory roster needs (admins only).
  const [dirSubs, setDirSubs] = useState([]);
  const [dirClients, setDirClients] = useState([]);

  const workerLabel = features?.label_worker || adminSettings?.label_worker || 'Team Member';
  const clientLabel = features?.label_client || adminSettings?.label_client || 'Customer';
  const subsEnabled = isAdmin && features?.module_subs !== false;

  // Tabs depend on capability + which modules are on. Directory is always
  // present; the management tabs appear only for users who can use them.
  const TEAM_TABS = [
    'directory',
    ...(canManageTeam ? ['team'] : []),
    ...(subsEnabled ? ['subs'] : []),
    ...(isAdmin ? ['customers'] : []),
    ...(canManageRoles ? ['roles'] : []),
  ];
  const hashTab = window.location.hash.replace('#', '');
  const [teamTab, setTeamTab] = useState(TEAM_TABS.includes(hashTab) ? hashTab : 'directory');
  const switchTab = id => { setTeamTab(id); history.replaceState(null, '', '#' + id); };
  const activeTab = TEAM_TABS.includes(teamTab) ? teamTab : 'directory';

  const loadTeam = useCallback(() => {
    setTeamLoading(true);
    api.get('/team')
      .then(r => setTeam(r.data.team || []))
      .catch(silentError('teampage'))
      .finally(() => setTeamLoading(false));
  }, []);

  const loadAdmin = useCallback(async () => {
    setAdminLoadError(null);
    try {
      const [w, s, f] = await Promise.all([
        api.get('/admin/workers', { params: { all_roles: true } }),
        api.get('/admin/settings'),
        getOrFetch('settings', () => api.get('/settings').then(r => r.data)),
      ]);
      setAdminWorkers(w.data);
      setAdminSettings(s.data);
      setFeatures(f);
      setAdminLoaded(true);
    } catch (err) {
      setAdminLoadError(err?.message || 'Failed to load admin data');
    }
  }, []);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  useEffect(() => {
    // Always fetch settings so the AppSwitcher's module_* filters know what the
    // company has turned off.
    getOrFetch('settings', () => api.get('/settings').then(r => r.data))
      .then(setFeatures).catch(silentError('teampage-settings'));
  }, []);

  // Sub firms + customers feed the unified Directory roster (admin only). The
  // Subs/Customers management tabs load their own data, so this is just for the
  // combined view.
  useEffect(() => {
    if (!isAdmin) return;
    api.get('/admin/clients').then(r => setDirClients(r.data || [])).catch(silentError('dir-clients'));
  }, [isAdmin]);
  useEffect(() => {
    if (!subsEnabled) { setDirSubs([]); return; }
    api.get('/subcontractors', { params: { limit: 500 } })
      .then(r => setDirSubs(r.data.items || []))
      .catch(silentError('dir-subs'));
  }, [subsEnabled]);

  useEffect(() => {
    if (canManageTeam && activeTab === 'team' && !adminLoaded) loadAdmin();
  }, [activeTab, canManageTeam, adminLoaded, loadAdmin]);

  const handleWorkerAdded    = w  => { setAdminWorkers(prev => [...prev, { ...w, total_entries: 0, total_hours: 0, regular_hours: 0, overtime_hours: 0, prevailing_hours: 0 }]); loadTeam(); };
  const handleWorkerDeleted  = id => { setAdminWorkers(prev => prev.filter(w => w.id !== id)); loadTeam(); };
  const handleWorkerUpdated  = w  => { setAdminWorkers(prev => prev.map(x => x.id === w.id ? { ...x, ...w } : x)); loadTeam(); };
  const handleWorkerRestored = w  => { setAdminWorkers(prev => [...prev, w]); loadTeam(); };

  const entries = toEntries({
    team,
    subs: subsEnabled ? dirSubs : [],
    clients: isAdmin ? dirClients : [],
    t, workerLabel, clientLabel,
  });
  const availableTypes = ['team', ...(subsEnabled ? ['sub'] : []), ...(isAdmin ? ['customer'] : [])];
  const counts = {
    all: entries.length,
    team: entries.filter(e => e.type === 'team').length,
    sub: entries.filter(e => e.type === 'sub').length,
    customer: entries.filter(e => e.type === 'customer').length,
  };

  const tabs = [
    { id: 'directory', label: t.dirDirectoryTab },
    ...(canManageTeam ? [{ id: 'team', label: plural(workerLabel) }] : []),
    ...(subsEnabled ? [{ id: 'subs', label: t.subSubcontractors }] : []),
    ...(isAdmin ? [{ id: 'customers', label: plural(clientLabel) }] : []),
    ...(canManageRoles ? [{ id: 'roles', label: t.teamRolesTab || 'Roles' }] : []),
  ];

  return (
    <PageShell currentApp="team" features={features} maxWidth={940}>
        <PageIntro
          introId="directory"
          kicker="Directory"
          title={isAdmin ? 'Everyone you work with, in one place.' : 'Find the people you work with.'}
          description={isAdmin
            ? 'The Directory shows your team, subcontractors, and customers together. Each tab manages one of them; Roles defines permissions.'
            : 'The directory keeps names, roles, and classifications easy to scan.'}
          meta={<span className="ops-pill">{counts.all} {counts.all === 1 ? 'record' : 'records'}</span>}
        />
        {tabs.length > 1 && (
          <TabBar active={activeTab} onChange={switchTab} tabs={tabs} />
        )}

        <ErrorBoundary key={activeTab} mode="inline" label={t.dirDirectoryTab}>
          {activeTab === 'directory' && (
            <DirectoryView
              entries={entries}
              loading={teamLoading}
              search={search}
              onSearchChange={setSearch}
              typeFilter={typeFilter}
              onTypeFilterChange={setTypeFilter}
              availableTypes={availableTypes}
              counts={counts}
              t={t}
            />
          )}
          {activeTab === 'team' && canManageTeam && (
            <>
              <RetryBanner message={adminLoadError} onRetry={loadAdmin} />
              {!adminLoaded && !adminLoadError ? <TabLoader /> : (
                <Suspense fallback={<TabLoader />}>
                  <ManageWorkers
                    workers={adminWorkers}
                    onWorkerAdded={handleWorkerAdded}
                    onWorkerDeleted={handleWorkerDeleted}
                    onWorkerUpdated={handleWorkerUpdated}
                    onWorkerRestored={handleWorkerRestored}
                    defaultRate={adminSettings?.default_hourly_rate ?? 0}
                    defaultTempPassword={adminSettings?.default_temp_password ?? ''}
                    showRate={true}
                    identityEditable={true}
                    currency={adminSettings?.currency ?? 'USD'}
                    currentUser={user}
                    trackClassifications={adminSettings?.cp_track_classifications !== false}
                    trackFringes={adminSettings?.cp_track_fringes !== false}
                    collectSsn={adminSettings?.cp_collect_ssn !== false}
                    workerLabel={workerLabel}
                  />
                </Suspense>
              )}
            </>
          )}
          {activeTab === 'subs' && subsEnabled && (
            <SubsDirectoryPanel />
          )}
          {activeTab === 'customers' && isAdmin && (
            <ManageClients settings={adminSettings || features} />
          )}
          {activeTab === 'roles' && canManageRoles && (
            <Suspense fallback={<TabLoader />}>
              <ManageRoles />
            </Suspense>
          )}
        </ErrorBoundary>
    </PageShell>
  );
}

const s = {
  searchRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  search:    { flex: 1, minWidth: 220, padding: '9px 14px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 },
  counter:   { fontSize: 13, color: '#6b7280', fontWeight: 600 },
  grid:      { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 },
  card:      { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start' },
  avatar:    { width: 44, height: 44, borderRadius: '50%', background: '#e0e7ff', color: '#3730a3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16, flexShrink: 0 },
  name:      { fontSize: 15, fontWeight: 700, color: '#111827', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  meta:      { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  typeChip:  { fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  rolePill:  { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  typePill:  { fontSize: 11, fontWeight: 600, background: '#f3f4f6', color: '#4b5563', padding: '2px 8px', borderRadius: 10 },
  classPill: { fontSize: 11, fontWeight: 600, background: '#d1fae5', color: '#065f46', padding: '2px 8px', borderRadius: 10 },
  username:  { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  pendingPill: { fontSize: 10, fontWeight: 700, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  empty:     { padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 14 },
};
