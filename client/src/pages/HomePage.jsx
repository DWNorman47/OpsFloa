import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import AppHeader from '../components/AppHeader';
import { useAuth } from '../contexts/AuthContext';
import { userCanSeeModule, canSeeTimeclockApp } from '../modulePermissions';
import { userHasAnyPerm } from '../hooks/usePerm';
import { useT } from '../hooks/useT';
import { labelSg, labelPl } from '../companyLabels';

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
  const t = useT();
  const [settings, setSettings] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [clockStatus, setClockStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showPlaces, setShowPlaces] = useState(false);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const terms = useMemo(() => ({
    work: labelSg(settings?.label_work, 'work', user?.language),
    client: labelSg(settings?.label_client, 'client', user?.language),
    worker: labelSg(settings?.label_worker, 'worker', user?.language),
    workerPlural: labelPl(settings?.label_worker, 'worker', user?.language),
    field: labelSg(settings?.label_field, 'field', user?.language),
  }), [settings, user?.language]);

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
        list.push({ title: t.hpActionReviewApprovalsTitle, detail: t.hpActionReviewApprovalsDetail, to: '/timeclock#wf-approvals', icon: 'A', primary: true });
      }
      if (can('workforce')) {
        list.push({ title: t.hpActionWhosWorkingTitle, detail: t.hpActionWhosWorkingDetail, to: '/timeclock#wf-live', icon: 'L', primary: !list.length });
      }
      if (enabled(settings, 'module_projects') && can('projects')) {
        list.push({ title: `${t.hpActionAddWork} ${terms.work.toLowerCase()}`, detail: `${t.hpActionAddWorkDetailCreate} ${terms.work.toLowerCase()} ${t.hpActionAddWorkDetailManage} ${terms.client.toLowerCase()} ${t.hpActionAddWorkDetailRecords}`, to: '/projects', icon: 'W' });
      }
      if (enabled(settings, 'module_team') && can('team')) {
        list.push({ title: t.hpActionInviteTeamTitle, detail: `${t.hpActionInviteTeamDetailAdd} ${terms.workerPlural.toLowerCase()} ${t.hpActionInviteTeamDetailAccess}`, to: '/team', icon: 'T' });
      }
      if (can('administration')) {
        list.push({ title: t.hpActionTuneSetupTitle, detail: t.hpActionTuneSetupDetail, to: '/administration', icon: 'S' });
      }
    } else {
      if (can('timeclock')) {
        list.push({
          title: clockStatus ? t.hpActionClockOut : t.hpActionClockIn,
          detail: clockStatus ? `${t.hpActionClockActiveOn} ${clockStatus.project_name || t.hpWork}` : t.hpActionClockInDetail,
          to: '/timeclock#clock',
          icon: 'C',
          primary: true,
        });
        list.push({ title: t.hpActionMyTimesheetTitle, detail: t.hpActionMyTimesheetDetail, to: '/timeclock#timesheet', icon: 'H' });
      }
      if (enabled(settings, 'module_field', false) && can('field')) {
        list.push({ title: t.hpActionSubmitUpdateTitle, detail: `${t.hpActionSubmitUpdateDetail} ${terms.field.toLowerCase()}`, to: '/field', icon: 'U' });
      }
      if (enabled(settings, 'module_inventory', false) && can('inventory')) {
        list.push({ title: t.hpActionInventoryTitle, detail: t.hpActionInventoryDetail, to: '/inventory', icon: 'I' });
      }
    }

    return list.slice(0, 5);
  }, [user, isAdmin, settings, clockStatus, terms, t]);

  const places = useMemo(() => {
    if (!user) return [];
    const all = [
      ['timeclock', t.hpPlaceTimeClockName, '/timeclock', t.hpPlaceTimeClockDetail],
      ['field', terms.field, '/field', t.hpPlaceFieldDetail],
      ['projects', terms.work, '/projects', `${terms.work}, ${t.hpPlaceProjectsDetail}`],
      ['team', t.hpPlaceDirectoryName, '/team', `${terms.workerPlural}, ${t.hpPlaceDirectoryDetail}`],
      ['inventory', t.hpPlaceInventoryName, '/inventory', t.hpPlaceInventoryDetail],
      ['financial_reports', t.hpPlaceReportsName, '/financial-reports', t.hpPlaceReportsDetail],
      ['administration', t.hpPlaceAdminName, '/administration', t.hpPlaceAdminDetail],
      ['account', t.hpPlaceAccountName, '/account', t.hpPlaceAccountDetail],
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
  }, [user, settings, isAdmin, terms, t]);

  return (
    <div className="home-page">
      <AppHeader currentApp="home" features={settings || {}} userRole={user?.role} />
      <main className="home-shell" id="main">
        <section className="home-hero">
          <div>
            <p className="home-kicker">{isAdmin ? t.hpKickerAdmin : t.hpKickerWorker}</p>
            <h1>{isAdmin ? t.hpHeadingAdmin : `${t.hpHeadingWorkerHi} ${user?.full_name?.split(' ')[0] || t.hpHeadingWorkerThere}, ${t.hpHeadingWorkerRest}`}</h1>
            <p>
              {isAdmin
                ? t.hpIntroAdmin
                : t.hpIntroWorker}
            </p>
          </div>
          {isAdmin ? (
            <div className="home-metrics">
              <Metric label={t.hpMetricPendingApprovals} value={loading ? '-' : kpis?.pending_approvals ?? 0} tone={(kpis?.pending_approvals || 0) > 0 ? 'attention' : 'good'} />
              <Metric label={t.hpMetricClockedInNow} value={loading ? '-' : kpis?.clocked_in_count ?? 0} />
              <Metric label={t.hpMetricHoursThisWeek} value={loading ? '-' : kpis?.company_hours_this_week ?? 0} />
              <Metric label={t.hpMetricOtWatch} value={loading ? '-' : kpis?.overtime_workers_this_week ?? 0} tone={(kpis?.overtime_workers_this_week || 0) > 0 ? 'attention' : 'good'} />
            </div>
          ) : (
            <div className="home-worker-status">
              <span className={clockStatus ? 'live' : ''}>{clockStatus ? t.hpStatusClockedIn : t.hpStatusReady}</span>
              <strong>{clockStatus?.project_name || t.hpStatusNoActiveShift}</strong>
              <small>{clockStatus ? t.hpStatusShiftTracked : t.hpStatusStartWhenReady}</small>
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <h2>{t.hpMostImportantNow}</h2>
            <p>{isAdmin ? t.hpMostImportantSubAdmin : t.hpMostImportantSubWorker}</p>
          </div>
          <div className="home-actions">
            {actions.map(action => <ActionCard key={action.title} action={action} />)}
            {!loading && actions.length === 0 && (
              <div className="home-empty-action">
                <strong>{t.hpEmptyActionTitle}</strong>
                <span>{t.hpEmptyActionDetail}</span>
              </div>
            )}
          </div>
        </section>

        <section className="home-section home-more">
          <div className="home-section-head">
            <div>
              <h2>{t.hpMorePlaces}</h2>
              <p>{t.hpMorePlacesSub}</p>
            </div>
            <button
              type="button"
              className="home-more-toggle"
              aria-expanded={showPlaces}
              onClick={() => setShowPlaces(v => !v)}
            >
              {showPlaces ? t.hpHideTools : `${t.hpShowTools1} ${places.length} ${t.hpShowTools2}`}
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
              {t.hpTuneToolsLink}
            </Link>
          )}
        </section>
      </main>
    </div>
  );
}
