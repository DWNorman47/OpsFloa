import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import AppHeader from '../components/AppHeader';
import { useAuth } from '../contexts/AuthContext';
import { userCanSeeModule, canSeeTimeclockApp } from '../modulePermissions';
import { userHasAnyPerm } from '../hooks/usePerm';

function enabled(settings, key, fallback = true) {
  if (!settings) return fallback;
  return settings[key] !== false;
}

// Labels are stored singular; pluralize by appending "s" (unless already plural),
// matching the convention used across the rest of the app.
function plural(label) {
  if (!label) return '';
  return /s$/i.test(label) ? label : `${label}s`;
}

function ActionCard({ action }) {
  return (
    <Link to={action.to} className={`home-action ${action.primary ? 'primary' : ''}`}>
      <span>
        <strong>{action.title}</strong>
        <small>{action.detail}</small>
      </span>
    </Link>
  );
}

function Metric({ label, value, tone = 'neutral' }) {
  return (
    <div className={`home-metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [clockStatus, setClockStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showPlaces, setShowPlaces] = useState(false);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const terms = useMemo(() => ({
    work: settings?.label_work || 'Project',
    client: settings?.label_client || 'Customer',
    worker: settings?.label_worker || 'Team Member',
    field: settings?.label_field || 'Field Work',
  }), [settings]);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      try {
        const requests = [api.get('/settings')];
        if (isAdmin) requests.push(api.get('/admin/kpis'));
        else requests.push(api.get('/clock/status'));
        const [settingsRes, secondRes] = await Promise.all(requests);
        if (!alive) return;
        setSettings(settingsRes.data);
        if (isAdmin) setKpis(secondRes.data);
        else setClockStatus(secondRes.data);
      } catch {
        if (!alive) return;
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [isAdmin]);

  const actions = useMemo(() => {
    if (!user) return [];
    const can = id => userCanSeeModule(user, id);
    const hasAny = keys => userHasAnyPerm(user, keys);
    const list = [];

    if (isAdmin) {
      if (can('workforce') && hasAny(['approve_entries'])) {
        list.push({ title: 'Review approvals', detail: 'Clear pending time before payroll', to: '/timeclock#wf-approvals', icon: 'A', primary: true });
      }
      if (can('workforce')) {
        list.push({ title: "Who's working", detail: 'See live clock-ins and exceptions', to: '/timeclock#wf-live', icon: 'L', primary: !list.length });
      }
      if (enabled(settings, 'module_projects') && can('projects')) {
        list.push({ title: `Add ${terms.work.toLowerCase()}`, detail: `Create ${terms.work.toLowerCase()} or manage ${terms.client.toLowerCase()} records`, to: '/projects', icon: 'W' });
      }
      if (enabled(settings, 'module_team') && can('team')) {
        list.push({ title: 'Invite team', detail: `Add ${plural(terms.worker).toLowerCase()} and set access`, to: '/team', icon: 'T' });
      }
      if (can('administration')) {
        list.push({ title: 'Tune setup', detail: 'Modules, features, billing, and integrations', to: '/administration', icon: 'S' });
      }
    } else {
      if (can('timeclock')) {
        list.push({
          title: clockStatus ? 'Clock out' : 'Clock in',
          detail: clockStatus ? `Active on ${clockStatus.project_name || 'work'}` : 'Start your day in one tap',
          to: '/timeclock#clock',
          icon: 'C',
          primary: true,
        });
        list.push({ title: 'My timesheet', detail: 'Review today and recent entries', to: '/timeclock#timesheet', icon: 'H' });
      }
      if (enabled(settings, 'module_field', false) && can('field')) {
        list.push({ title: 'Submit update', detail: `Notes, reports, photos, or ${terms.field.toLowerCase()}`, to: '/field', icon: 'U' });
      }
      if (enabled(settings, 'module_inventory', false) && can('inventory')) {
        list.push({ title: 'Inventory', detail: 'Check stock or record movement', to: '/inventory', icon: 'I' });
      }
    }

    return list.slice(0, 5);
  }, [user, isAdmin, settings, clockStatus, terms]);

  const places = useMemo(() => {
    if (!user) return [];
    const all = [
      ['timeclock', 'Time Clock', '/timeclock', 'Clock in, submit time, oversight'],
      ['field', terms.field, '/field', 'Reports, photos, checklists, issues'],
      ['projects', terms.work, '/projects', `${terms.work}, estimates, change orders, billing`],
      ['team', 'Directory', '/team', `${plural(terms.worker)}, subcontractors, customers`],
      ['inventory', 'Inventory', '/inventory', 'Items, locations, counts'],
      ['financial_reports', 'Reports', '/financial-reports', 'P&L, WIP, and performance'],
      ['administration', 'Admin', '/administration', 'Company setup and integrations'],
      ['account', 'Account', '/account', 'Profile and password'],
    ];
    return all.filter(([id]) => {
      if (['projects', 'financial_reports', 'administration'].includes(id) && !isAdmin) return false;
      if (id === 'field' && !enabled(settings, 'module_field', false)) return false;
      if (id === 'projects' && !enabled(settings, 'module_projects')) return false;
      if (id === 'inventory' && !enabled(settings, 'module_inventory', false)) return false;
      // Reports is hidden only when BOTH its halves are off (matches AppSwitcher).
      if (id === 'financial_reports' && !enabled(settings, 'module_financial_reports') && !enabled(settings, 'module_analytics')) return false;
      if (id === 'team' && !enabled(settings, 'module_team')) return false;
      // Time Clock hosts the Workforce group — visible to oversight-only users too.
      if (id === 'timeclock') return canSeeTimeclockApp(user);
      return userCanSeeModule(user, id);
    });
  }, [user, settings, isAdmin, terms]);

  return (
    <div className="home-page">
      <AppHeader currentApp="home" features={settings || {}} userRole={user?.role} />
      <main className="home-shell" id="main">
        <section className="home-hero">
          <div>
            <p className="home-kicker">{isAdmin ? 'Operations home' : 'Your work today'}</p>
            <h1>{isAdmin ? 'Start with what needs attention.' : `Hi ${user?.full_name?.split(' ')[0] || 'there'}, keep the day simple.`}</h1>
            <p>
              {isAdmin
                ? 'OpsFloa keeps the full toolset nearby, but your home screen stays focused on the next few decisions.'
                : 'The actions you need most are here. Everything else is still available when you look for it.'}
            </p>
          </div>
          {isAdmin ? (
            <div className="home-metrics">
              <Metric label="Pending approvals" value={loading ? '-' : kpis?.pending_approvals ?? 0} tone={(kpis?.pending_approvals || 0) > 0 ? 'attention' : 'good'} />
              <Metric label="Clocked in now" value={loading ? '-' : kpis?.clocked_in_count ?? 0} />
              <Metric label="Hours this week" value={loading ? '-' : kpis?.company_hours_this_week ?? 0} />
              <Metric label="OT watch" value={loading ? '-' : kpis?.overtime_workers_this_week ?? 0} tone={(kpis?.overtime_workers_this_week || 0) > 0 ? 'attention' : 'good'} />
            </div>
          ) : (
            <div className="home-worker-status">
              <span className={clockStatus ? 'live' : ''}>{clockStatus ? 'Clocked in' : 'Ready'}</span>
              <strong>{clockStatus?.project_name || 'No active shift'}</strong>
              <small>{clockStatus ? 'Your current shift is being tracked.' : 'Start when you are ready.'}</small>
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <h2>Most important now</h2>
            <p>{isAdmin ? 'The workday should begin with decisions, not navigation.' : 'Keep the daily path short.'}</p>
          </div>
          <div className="home-actions">
            {actions.map(action => <ActionCard key={action.title} action={action} />)}
            {!loading && actions.length === 0 && (
              <div className="home-empty-action">
                <strong>Nothing urgent right now.</strong>
                <span>Your available tools are still nearby when you need them.</span>
              </div>
            )}
          </div>
        </section>

        <section className="home-section home-more">
          <div className="home-section-head">
            <div>
              <h2>More places</h2>
              <p>Available because of this company setup and your role.</p>
            </div>
            <button
              type="button"
              className="home-more-toggle"
              aria-expanded={showPlaces}
              onClick={() => setShowPlaces(v => !v)}
            >
              {showPlaces ? 'Hide tools' : `Show ${places.length} tools`}
            </button>
          </div>
          {showPlaces && (
            <div className="home-place-grid">
              {places.map(([id, name, to, detail]) => (
                <Link key={id} to={to} className="home-place">
                  <strong>{name}</strong>
                  <span>{detail}</span>
                </Link>
              ))}
            </div>
          )}
          {!showPlaces && isAdmin && userCanSeeModule(user, 'administration') && (
            <Link to="/administration#workspace" className="home-quiet-link">
              Tune which tools appear for this company
            </Link>
          )}
        </section>
      </main>
    </div>
  );
}
