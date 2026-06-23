import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  filterGuideTasks,
  findGuideTask,
  getGuideTaskAvailability,
  GUIDE_TASKS,
} from '../guideContent';
import { userHasAnyPerm } from '../hooks/usePerm';

function GuideStatus({ availability }) {
  return (
    <span className={`guide-status ${availability.ready ? 'is-ready' : 'needs-setup'}`.trim()}>
      {availability.ready ? 'Ready' : 'Needs setup'}
    </span>
  );
}

function GuideIssuePanel({ task, availability, user, features }) {
  if (availability.ready) return null;
  const canOpenSettings = userHasAnyPerm(user, ['manage_settings']) && features?.module_administration !== false;
  return (
    <div className="guide-issue-panel">
      <div className="guide-issue-title">Before this guide will work</div>
      {availability.missingModules.length > 0 && (
        <p>Turn on: {availability.missingModules.join(', ')}.</p>
      )}
      {availability.missingRole && (
        <p>This usually needs {availability.missingRole}.</p>
      )}
      {availability.missingPermission && (
        <p>Your role may need permission to {availability.missingPermission}.</p>
      )}
      {canOpenSettings ? (
        <a className="guide-secondary-link" href="/administration#workspace">
          Open Company Settings
        </a>
      ) : (
        <p>Ask an owner or admin to turn it on or adjust your role.</p>
      )}
      <div className="guide-issue-footnote">
        Guide: {task.title}
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

function GuideDetail({ task, user, features, onBack, onNavigate, onSelect }) {
  const availability = getGuideTaskAvailability(task, user, features);
  const related = (task.related || []).map(findGuideTask).filter(Boolean);
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
        All guides
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
          <h3>Before you start</h3>
          <ul className="guide-before-list">
            {task.before.map(item => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      <section className="guide-section">
        <h3>Steps</h3>
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
          {task.routeLabel || 'Take me there'}
        </a>
        <a href="/help" className="guide-secondary-link" onClick={event => {
          event.preventDefault();
          onNavigate('/help');
        }}>
          Open Help page
        </a>
      </div>

      {related.length > 0 && (
        <section className="guide-related">
          <h3>Related guides</h3>
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

  const tasks = useMemo(() => filterGuideTasks(query, currentApp, GUIDE_TASKS), [query, currentApp]);
  const selectedTask = selectedId ? findGuideTask(selectedId) : null;
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
            <div className="guide-eyebrow">Guide</div>
            <h1 id="guide-drawer-title">What are you trying to do?</h1>
          </div>
          <button type="button" className="guide-close" aria-label="Close guide" onClick={onClose}>
            x
          </button>
        </header>

        <div className="guide-search-wrap">
          <label htmlFor="guide-search">Search task guides</label>
          <input
            id="guide-search"
            ref={searchRef}
            type="search"
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setSelectedId(null);
            }}
            placeholder="Search by task or question"
          />
        </div>

        <div className="guide-help-cta">
          <a href="/help" className="guide-help-button" onClick={event => {
            event.preventDefault();
            navigateFromGuide('/help');
          }}>
            Open Help page
          </a>
        </div>

        <div className="guide-body">
          {selectedTask ? (
            <GuideDetail
              task={selectedTask}
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
                  <strong>No guide found.</strong>
                  <span>Try a simpler search like "time", "PO", "inventory", or "setup".</span>
                </div>
              )}

              {currentAppTasks.length > 0 && (
                <section className="guide-list-section">
                  <h2>Useful here</h2>
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

              {otherTasks.length > 0 && (
                <section className="guide-list-section">
                  <h2>{currentAppTasks.length > 0 ? 'More guides' : 'Guides'}</h2>
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
