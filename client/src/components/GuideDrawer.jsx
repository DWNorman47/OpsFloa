import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  filterGuideTasks,
  findGuideTask,
  getGuideTaskAvailability,
  getGuideTasks,
} from '../guideContent';
import { userHasAnyPerm } from '../hooks/usePerm';
import { useT } from '../hooks/useT';

function GuideStatus({ availability }) {
  const t = useT();
  return (
    <span className={`guide-status ${availability.ready ? 'is-ready' : 'needs-setup'}`.trim()}>
      {availability.ready ? t.gdReady : t.gdNeedsSetup}
    </span>
  );
}

function GuideIssuePanel({ task, availability, user, features }) {
  const t = useT();
  if (availability.ready) return null;
  const canOpenSettings = userHasAnyPerm(user, ['manage_settings']) && features?.module_administration !== false;
  return (
    <div className="guide-issue-panel">
      <div className="guide-issue-title">{t.gdBeforeThisWorks}</div>
      {availability.missingModules.length > 0 && (
        <p>{t.gdTurnOn}: {availability.missingModules.join(', ')}.</p>
      )}
      {availability.missingRole && (
        <p>{t.gdUsuallyNeeds} {availability.missingRole}.</p>
      )}
      {availability.missingPermission && (
        <p>{t.gdRoleMayNeedPermission} {availability.missingPermission}.</p>
      )}
      {canOpenSettings ? (
        <a className="guide-secondary-link" href="/administration#workspace">
          {t.gdOpenCompanySettings}
        </a>
      ) : (
        <p>{t.gdAskOwnerOrAdmin}</p>
      )}
      <div className="guide-issue-footnote">
        {t.gdGuideLabel}: {task.title}
      </div>
    </div>
  );
}

function GuideTaskCard({ task, availability, onSelect }) {
  return (
    <button type="button" className="guide-task-card" onClick={() => onSelect(task.id)}>
      <span className="guide-task-topline">
        <span>{task.category}</span>
        <GuideStatus availability={availability} />
      </span>
      <span className="guide-task-title">{task.title}</span>
      <span className="guide-task-summary">{task.summary}</span>
    </button>
  );
}

function GuideDetail({ task, allTasks, user, features, onBack, onNavigate, onSelect }) {
  const t = useT();
  const availability = getGuideTaskAvailability(task, user, features);
  const related = (task.related || []).map(id => findGuideTask(id, allTasks)).filter(Boolean);
  const canNavigate = availability.ready;

  const handlePrimary = event => {
    event.preventDefault();
    if (!canNavigate) {
      return;
    }
    onNavigate(task.route);
  };

  return (
    <div className="guide-detail">
      <button type="button" className="guide-back-btn" onClick={onBack}>
        {t.gdAllGuides}
      </button>

      <div className="guide-detail-heading">
        <div>
          <div className="guide-kicker">{task.category}</div>
          <h2>{task.title}</h2>
        </div>
        <GuideStatus availability={availability} />
      </div>

      <p className="guide-detail-summary">{task.summary}</p>

      <GuideIssuePanel task={task} availability={availability} user={user} features={features} />

      {task.before?.length > 0 && (
        <section className="guide-section">
          <h3>{t.gdBeforeYouStart}</h3>
          <ul className="guide-before-list">
            {task.before.map(item => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      <section className="guide-section">
        <h3>{t.gdSteps}</h3>
        <ol className="guide-steps">
          {task.steps.map(step => <li key={step}>{step}</li>)}
        </ol>
      </section>

      <div className="guide-actions">
        <a
          href={task.route}
          className={`guide-primary-link ${canNavigate ? '' : 'is-disabled'}`.trim()}
          aria-disabled={!canNavigate}
          onClick={handlePrimary}
        >
          {task.routeLabel || t.gdTakeMeThere}
        </a>
        <a href="/help" className="guide-secondary-link" onClick={event => {
          event.preventDefault();
          onNavigate('/help');
        }}>
          {t.gdOpenHelpPage}
        </a>
      </div>

      {related.length > 0 && (
        <section className="guide-related">
          <h3>{t.gdRelatedGuides}</h3>
          <div className="guide-related-list">
            {related.map(item => (
              <button type="button" key={item.id} onClick={() => onSelect(item.id)}>
                {item.title}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function GuideDrawer({ open, onClose, currentApp, features = {} }) {
  const t = useT();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const searchRef = useRef(null);

  const navigateFromGuide = route => {
    onClose();
    navigate(route);
    window.setTimeout(() => window.dispatchEvent(new Event('hashchange')), 0);
  };

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelectedId(null);
    }
  }, [open]);

  // Resolve guide content to the user's language (falls back to English), then
  // search/sort against that resolved text so matches follow what users see.
  const localizedTasks = useMemo(() => getGuideTasks(user?.language), [user?.language]);
  const tasks = useMemo(
    () => filterGuideTasks(query, currentApp, localizedTasks),
    [query, currentApp, localizedTasks],
  );
  const selectedTask = selectedId ? findGuideTask(selectedId, localizedTasks) : null;
  const hasSearch = query.trim().length > 0;
  const currentAppTasks = tasks.filter(task => task.app === currentApp);
  const otherTasks = tasks.filter(task => task.app !== currentApp);

  if (!open) return null;

  return (
    <div className="guide-backdrop" onMouseDown={onClose}>
      <aside
        className="guide-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-drawer-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="guide-header">
          <div>
            <div className="guide-eyebrow">{t.gdEyebrow}</div>
            <h1 id="guide-drawer-title">{t.gdWhatTryingToDo}</h1>
          </div>
          <button type="button" className="guide-close" aria-label={t.gdCloseGuide} onClick={onClose}>
            X
          </button>
        </header>

        <div className="guide-search-wrap">
          <label htmlFor="guide-search">{t.gdSearchLabel}</label>
          <input
            id="guide-search"
            ref={searchRef}
            type="search"
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setSelectedId(null);
            }}
            placeholder={t.gdSearchPlaceholder}
          />
        </div>

        <div className="guide-help-cta">
          <a href="/help" className="guide-help-button" onClick={event => {
            event.preventDefault();
            navigateFromGuide('/help');
          }}>
            {t.gdOpenHelpPage}
          </a>
        </div>

        <div className="guide-body">
          {selectedTask ? (
            <GuideDetail
              task={selectedTask}
              allTasks={localizedTasks}
              user={user}
              features={features}
              onBack={() => setSelectedId(null)}
              onNavigate={navigateFromGuide}
              onSelect={setSelectedId}
            />
          ) : (
            <>
              {tasks.length === 0 && (
                <div className="guide-empty">
                  <strong>{t.gdNoGuideFound}</strong>
                  <span>{t.gdNoGuideSuggestion}</span>
                </div>
              )}

              {hasSearch && tasks.length > 0 && (
                <section className="guide-list-section">
                  <h2>{t.gdBestMatches}</h2>
                  <div className="guide-task-list">
                    {tasks.map(task => (
                      <GuideTaskCard
                        key={task.id}
                        task={task}
                        availability={getGuideTaskAvailability(task, user, features)}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                </section>
              )}

              {!hasSearch && currentAppTasks.length > 0 && (
                <section className="guide-list-section">
                  <h2>{t.gdUsefulHere}</h2>
                  <div className="guide-task-list">
                    {currentAppTasks.map(task => (
                      <GuideTaskCard
                        key={task.id}
                        task={task}
                        availability={getGuideTaskAvailability(task, user, features)}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                </section>
              )}

              {!hasSearch && otherTasks.length > 0 && (
                <section className="guide-list-section">
                  <h2>{currentAppTasks.length > 0 ? t.gdMoreGuides : t.gdGuides}</h2>
                  <div className="guide-task-list">
                    {otherTasks.map(task => (
                      <GuideTaskCard
                        key={task.id}
                        task={task}
                        availability={getGuideTaskAvailability(task, user, features)}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
