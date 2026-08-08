import React, { useState, useEffect } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';
import { useT } from '../hooks/useT';
import { SkeletonList } from './Skeleton';
import ModalShell from './ModalShell';
import EmptyState from './EmptyState';

import { silentError } from '../errorReporter';
import HelpTip from './HelpTip';
import { useAuth } from '../contexts/AuthContext';
import { labelSg } from '../companyLabels';
import { formatCurrency } from '../utils';
export default function ManageProjects({ projects, onProjectAdded, onProjectDeleted, onProjectUpdated, onProjectRestored, showWageType = true, nameEditable = true, showGeofenceBudget = true, defaultPrevailingRate = '', currency = 'USD', settings = null }) {
  const toast = useToast();
  const t = useT();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [wageType, setWageType] = useState('regular');
  const [prevailingRate, setPrevailingRate] = useState('');
  const [error, setError] = useState('');
  const [archivedConflict, setArchivedConflict] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editWageType, setEditWageType] = useState('regular');
  const [editPrevailingRate, setEditPrevailingRate] = useState('');
  const [editGeoLat, setEditGeoLat] = useState('');
  const [editGeoLng, setEditGeoLng] = useState('');
  const [editGeoRadius, setEditGeoRadius] = useState('');
  const [editBudgetHours, setEditBudgetHours] = useState('');
  const [editBudgetDollars, setEditBudgetDollars] = useState('');
  const [editRequiredChecklist, setEditRequiredChecklist] = useState('');
  const [editClientName, setEditClientName] = useState('');
  const [editJobNumber, setEditJobNumber] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editStartDate, setEditStartDate] = useState('');
  const [editEndDate, setEditEndDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStatus, setEditStatus] = useState('in_progress');
  const [editProgressPct, setEditProgressPct] = useState('');
  const [editHourLimitMode, setEditHourLimitMode] = useState('off');
  const [editDailyHourLimit, setEditDailyHourLimit] = useState('');
  const [editWeeklyHourLimit, setEditWeeklyHourLimit] = useState('');
  const [editOverflowProjectId, setEditOverflowProjectId] = useState('');
  const [checklistTemplates, setChecklistTemplates] = useState([]);
  const [confirmingClearGeoId, setConfirmingClearGeoId] = useState(null);
  const [confirmingClearBudgetId, setConfirmingClearBudgetId] = useState(null);
  const [geoLocating, setGeoLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [archived, setArchived] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState(null); // { id, name }
  const [archiveDownloading, setArchiveDownloading] = useState(false);
  const [mergeSource, setMergeSource] = useState(null); // { id, name }
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeSaving, setMergeSaving] = useState(false);

  const loadArchived = async () => {
    setLoadingArchived(true);
    try {
      const r = await api.get('/admin/projects/archived');
      setArchived(r.data);
    } finally {
      setLoadingArchived(false);
    }
  };

  useEffect(() => {
    loadArchived();
    api.get('/safety-checklists/templates').then(r => setChecklistTemplates(r.data)).catch(silentError('manageprojects'));
  }, []);

  const handleAdd = async e => {
    e.preventDefault();
    setError('');
    setArchivedConflict(null);
    setSaving(true);
    try {
      const payload = { name, wage_type: wageType };
      if (wageType === 'prevailing' && prevailingRate !== '') payload.prevailing_wage_rate = parseFloat(prevailingRate);
      const r = await api.post('/admin/projects', payload);
      onProjectAdded(r.data);
      setName('');
      setWageType('regular');
      setPrevailingRate('');
    } catch (err) {
      const data = err.response?.data;
      if (data?.archived_id) {
        setArchivedConflict({ id: data.archived_id, name: data.archived_name });
        setError(data.error);
      } else {
        setError(data?.error || t.failedCreateProject);
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleExpand = (p) => {
    if (expandedId === p.id) {
      setExpandedId(null);
      setGeoError('');
    } else {
      setExpandedId(p.id);
      setGeoError('');
      setEditName(p.name);
      setEditWageType(p.wage_type);
      setEditPrevailingRate(p.prevailing_wage_rate != null ? String(p.prevailing_wage_rate) : '');
      setEditGeoLat(p.geo_lat || '');
      setEditGeoLng(p.geo_lng || '');
      setEditGeoRadius(p.geo_radius_ft || '');
      setEditBudgetHours(p.budget_hours || '');
      setEditBudgetDollars(p.budget_dollars || '');
      setEditRequiredChecklist(p.required_checklist_template_id ? String(p.required_checklist_template_id) : '');
      setEditClientName(p.client_name || '');
      setEditJobNumber(p.job_number || '');
      setEditAddress(p.address || '');
      setEditStartDate(p.start_date ? p.start_date.split('T')[0] : '');
      setEditEndDate(p.end_date ? p.end_date.split('T')[0] : '');
      setEditDescription(p.description || '');
      setEditStatus(p.status || 'in_progress');
      setEditProgressPct(p.progress_pct != null ? String(p.progress_pct) : '');
      setEditHourLimitMode(p.hour_limit_mode || 'off');
      setEditDailyHourLimit(p.daily_hour_limit != null ? String(p.daily_hour_limit) : '');
      setEditWeeklyHourLimit(p.weekly_hour_limit != null ? String(p.weekly_hour_limit) : '');
      setEditOverflowProjectId(p.hour_limit_overflow_project_id ? String(p.hour_limit_overflow_project_id) : '');
    }
  };

  const handleEditSave = async (id) => {
    if (nameEditable && !editName.trim()) return;
    const payload = {};
    if (nameEditable) payload.name = editName.trim();
    if (showWageType) payload.wage_type = editWageType;
    payload.prevailing_wage_rate = editWageType === 'prevailing' && editPrevailingRate !== '' ? parseFloat(editPrevailingRate) : null;
    if (editGeoLat && editGeoLng && editGeoRadius) {
      payload.geo_lat = editGeoLat;
      payload.geo_lng = editGeoLng;
      payload.geo_radius_ft = editGeoRadius;
    }
    if (editBudgetHours !== '') payload.budget_hours = editBudgetHours || null;
    if (editBudgetDollars !== '') payload.budget_dollars = editBudgetDollars || null;
    payload.required_checklist_template_id = editRequiredChecklist ? parseInt(editRequiredChecklist) : null;
    payload.client_name = editClientName || null;
    payload.job_number = editJobNumber || null;
    payload.address = editAddress || null;
    payload.start_date = editStartDate || null;
    payload.end_date = editEndDate || null;
    payload.description = editDescription || null;
    payload.status = editStatus;
    payload.progress_pct = editProgressPct !== '' ? parseInt(editProgressPct, 10) : null;
    payload.hour_limit_mode = editHourLimitMode;
    payload.daily_hour_limit = editDailyHourLimit !== '' ? parseFloat(editDailyHourLimit) : null;
    payload.weekly_hour_limit = editWeeklyHourLimit !== '' ? parseFloat(editWeeklyHourLimit) : null;
    payload.hour_limit_overflow_project_id = (editHourLimitMode === 'hard' && editOverflowProjectId) ? parseInt(editOverflowProjectId) : null;
    try {
      const r = await api.patch(`/admin/projects/${id}`, payload);
      onProjectUpdated(r.data);
      setExpandedId(null);
      toast(t.projectUpdated, 'success');
    } catch (err) {
      toast(err?.response?.data?.error || t.failedUpdateProject, 'error');
    }
  };

  const handleClearGeofence = async (id) => {
    setConfirmingClearGeoId(null);
    try {
      const r = await api.patch(`/admin/projects/${id}`, { clear_geofence: true });
      onProjectUpdated(r.data);
      setEditGeoLat('');
      setEditGeoLng('');
      setEditGeoRadius('');
    } catch {
      toast(t.failedRemoveGeofence, 'error');
    }
  };

  const handleClearBudget = async (id) => {
    setConfirmingClearBudgetId(null);
    try {
      const r = await api.patch(`/admin/projects/${id}`, { budget_hours: null, budget_dollars: null });
      onProjectUpdated(r.data);
      setEditBudgetHours('');
      setEditBudgetDollars('');
    } catch {
      toast(t.failedRemoveBudget, 'error');
    }
  };

  const hasBudget = p => parseFloat(p.budget_hours) > 0 || parseFloat(p.budget_dollars) > 0;

  const statusLabel = st => ({ planning: 'Planning', in_progress: 'In Progress', on_hold: 'On Hold', completed: 'Completed' }[st] || st);
  const statusBadgeStyle = st => ({
    planning:    { background: '#dbeafe', color: '#1d4ed8' },
    on_hold:     { background: '#fef3c7', color: '#92400e' },
    completed:   { background: '#d1fae5', color: '#065f46' },
  }[st] || {});

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGeoError(t.geolocationNotSupported);
      return;
    }
    setGeoLocating(true);
    setGeoError('');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setEditGeoLat(pos.coords.latitude.toFixed(6));
        setEditGeoLng(pos.coords.longitude.toFixed(6));
        setGeoLocating(false);
      },
      err => {
        setGeoLocating(false);
        if (err.code === 1) setGeoError(t.locationAccessDenied);
        else if (err.code === 2) setGeoError(t.locationUnavailable);
        else setGeoError(t.locationTimeout);
      },
      { timeout: 8000 }
    );
  };

  const handleRemove = (id, projectName) => {
    setArchiveTarget({ id, name: projectName });
  };

  const handleConfirmArchive = async () => {
    if (!archiveTarget) return;
    try {
      await api.delete(`/admin/projects/${archiveTarget.id}`);
      onProjectDeleted(archiveTarget.id);
      if (expandedId === archiveTarget.id) setExpandedId(null);
      loadArchived();
      toast(t.projectArchived.replace('{name}', archiveTarget.name), 'success');
      setArchiveTarget(null);
    } catch {
      toast(t.failedRemoveProject, 'error');
    }
  };

  const handleDownloadMediaUrls = async () => {
    if (!archiveTarget) return;
    setArchiveDownloading(true);
    try {
      const r = await api.get(`/admin/projects/${archiveTarget.id}/media-urls`);
      const { urls } = r.data;
      if (!urls.length) { toast(t.noMediaFilesFound, 'info'); return; }
      const blob = new Blob([urls.join('\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${archiveTarget.name.replace(/[^a-z0-9]/gi, '_')}_media_urls.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast(t.failedFetchMedia, 'error');
    } finally {
      setArchiveDownloading(false);
    }
  };

  const handleDownloadZip = async () => {
    if (!archiveTarget) return;
    setArchiveDownloading(true);
    try {
      const r = await api.get(`/admin/projects/${archiveTarget.id}/media-zip`, { responseType: 'blob' });
      const blob = new Blob([r.data], { type: 'application/zip' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${archiveTarget.name.replace(/[^a-z0-9]/gi, '_')}_media.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast(t.noMediaDownload, 'error');
    } finally {
      setArchiveDownloading(false);
    }
  };

  const handleConfirmMerge = async () => {
    if (!mergeSource || !mergeTargetId) return;
    setMergeSaving(true);
    try {
      await api.post(`/admin/projects/${mergeSource.id}/merge-into/${mergeTargetId}`);
      onProjectDeleted(mergeSource.id);
      if (expandedId === mergeSource.id) setExpandedId(null);
      setMergeSource(null);
      setMergeTargetId('');
      toast(t.projectMergedInto.replace('{name}', projects.find(p => p.id === parseInt(mergeTargetId))?.name), 'success');
    } catch {
      toast(t.failedMergeProjects, 'error');
    } finally {
      setMergeSaving(false);
    }
  };

  const handleRestore = async (id) => {
    try {
      const r = await api.patch(`/admin/projects/${id}/restore`);
      onProjectRestored(r.data);
      setArchived(prev => prev.filter(p => p.id !== id));
    } catch {
      toast(t.failedRestoreProject, 'error');
    }
  };

  const handleRestoreConflict = async () => {
    if (!archivedConflict) return;
    await handleRestore(archivedConflict.id);
    setArchivedConflict(null);
    setError('');
  };

  const clientLabel = labelSg(settings?.label_client, 'client', user?.language);
  const workNamePlaceholder = 'Project name';

  return (
    <div style={s.card}>
      <h3 style={s.cardTitle}>Manage Project</h3>
      <form onSubmit={handleAdd} style={s.form} className="manage-projects-form">
        <input
          style={s.input}
          placeholder={workNamePlaceholder}
          value={name}
          onChange={e => { setName(e.target.value); setError(''); setArchivedConflict(null); }}
          required
        />
        {showWageType && (
          <select style={s.select} value={wageType} onChange={e => { setWageType(e.target.value); setPrevailingRate(''); }}>
            <option value="regular">{t.regularWages}</option>
            <option value="prevailing">{t.prevailingWages}</option>
          </select>
        )}
        {showWageType && wageType === 'prevailing' && (
          <input style={{ ...s.input, maxWidth: 120 }} type="number" min="0" step="0.01" placeholder={`Rate (${defaultPrevailingRate || '45.00'})`} value={prevailingRate} onChange={e => setPrevailingRate(e.target.value)} />
        )}
        <button style={{ ...s.addBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.adding : t.add}</button>
      </form>
      {error && (
        <div role="alert" style={s.errorBox}>
          <p style={s.errorText}>{error}</p>
          {archivedConflict && (
            <button type="button" style={s.restoreInlineBtn} onClick={handleRestoreConflict}>
              Restore "{archivedConflict.name}"
            </button>
          )}
        </div>
      )}

      {projects.length === 0 ? (
        <EmptyState
          mark="W"
          title="No project yet"
          body="Create the project your team clocks time against. This can be a project, job, route, case, or any other unit your company uses."
        />
      ) : (
        <div style={s.list}>
          {projects.map(p => {
            const isExpanded = expandedId === p.id;
            return (
              <div key={p.id} style={s.item}>
                <button style={s.itemBar} onClick={() => toggleExpand(p)}>
                  <div style={s.itemLeft}>
                    <span style={s.itemName}>{p.name}</span>
                    {p.status && p.status !== 'in_progress' && (
                      <span style={{ ...s.statusBadge, ...statusBadgeStyle(p.status) }}>{statusLabel(p.status)}</span>
                    )}
                    {p.client_name && <span style={s.clientTag}>{p.client_name}</span>}
                    {p.geo_radius_ft && <span style={s.indicatorBadge} title={`Geofence: ${p.geo_radius_ft.toLocaleString()} ft radius`}>📍</span>}
                    {hasBudget(p) && <span style={s.indicatorBadge} title={[parseFloat(p.budget_hours) > 0 && `${p.budget_hours} hrs`, parseFloat(p.budget_dollars) > 0 && formatCurrency(Number(p.budget_dollars), currency)].filter(Boolean).join(' / ')}>💰</span>}
                    {p.required_checklist_template_id && <span style={s.indicatorBadge} title={t.checklistRequiredBadge}>☑</span>}
                    {showWageType && (
                      <span style={{ ...s.wageBadge, background: p.wage_type === 'prevailing' ? '#d97706' : '#2563eb' }}>
                        {p.wage_type === 'prevailing' ? t.prevailingWages : t.regularWages}
                      </span>
                    )}
                    {showWageType && p.wage_type === 'prevailing' && p.prevailing_wage_rate != null && (
                      <span style={s.rateTag}>${parseFloat(p.prevailing_wage_rate).toFixed(2)}/hr</span>
                    )}
                  </div>
                  <span style={{ ...s.chevron, transform: isExpanded ? 'rotate(180deg)' : 'none' }}>▾</span>
                </button>

                {isExpanded && (
                  <div style={s.panel}>
                    {/* Name + wage type */}
                    <div style={s.section}>
                      <div style={s.sectionTitle}>Details</div>
                      <div style={s.fieldsGrid}>
                        {nameEditable && (
                          <div style={s.fieldGroup}>
                            <label htmlFor="mp-name" style={s.fieldLabel}>Name</label>
                            <input
                              id="mp-name"
                              style={s.editInput}
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Escape') setExpandedId(null); }}
                              autoFocus
                              placeholder={workNamePlaceholder}
                            />
                          </div>
                        )}
                        {showWageType && (
                          <div style={s.fieldGroup}>
                            <label htmlFor="mp-wage-type" style={s.fieldLabel}>{t.mpWageType}</label>
                            <select id="mp-wage-type" style={s.editInput} value={editWageType} onChange={e => { setEditWageType(e.target.value); setEditPrevailingRate(''); }}>
                              <option value="regular">{t.regularWages}</option>
                              <option value="prevailing">{t.prevailingWages}</option>
                            </select>
                          </div>
                        )}
                        {editWageType === 'prevailing' && (
                          <div style={s.fieldGroup}>
                            <label htmlFor="mp-rate" style={s.fieldLabel}>{t.mpRatePerHr}</label>
                            <input id="mp-rate" style={s.editInput} type="number" min="0" step="0.01" placeholder={defaultPrevailingRate || '45.00'} value={editPrevailingRate} onChange={e => setEditPrevailingRate(e.target.value)} />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Work Info */}
                    <div style={s.section}>
                      <div style={s.sectionTitle}>Project info</div>
                      <div style={s.fieldsGrid}>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mp-status" style={s.fieldLabel}>{t.mpStatus}</label>
                          <select id="mp-status" style={s.editInput} value={editStatus} onChange={e => setEditStatus(e.target.value)}>
                            <option value="planning">{t.mpStatusPlanning}</option>
                            <option value="in_progress">{t.mpStatusInProgress}</option>
                            <option value="on_hold">{t.mpStatusOnHold}</option>
                            <option value="completed">{t.mpStatusCompleted}</option>
                          </select>
                        </div>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mp-client-name" style={s.fieldLabel}>{clientLabel} name</label>
                          <input id="mp-client-name" style={s.editInput} value={editClientName} onChange={e => setEditClientName(e.target.value)} placeholder={`${clientLabel} name`} />
                        </div>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mp-job-number" style={s.fieldLabel}>{t.mpJobNumber}</label>
                          <input id="mp-job-number" style={s.editInput} value={editJobNumber} onChange={e => setEditJobNumber(e.target.value)} placeholder={t.jobNumberPlaceholder} />
                        </div>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mp-start-date" style={s.fieldLabel}>{t.mpStartDate}</label>
                          <input id="mp-start-date" style={s.editInput} type="date" value={editStartDate} onChange={e => setEditStartDate(e.target.value)} />
                        </div>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mp-end-date" style={s.fieldLabel}>{t.mpTargetEndDate}</label>
                          <input id="mp-end-date" style={s.editInput} type="date" value={editEndDate} onChange={e => setEditEndDate(e.target.value)} />
                        </div>
                      </div>
                      <div style={{ ...s.fieldGroup, marginTop: 8 }}>
                        <label htmlFor="mp-address" style={s.fieldLabel}>{t.mpAddressLocation}</label>
                        <input id="mp-address" style={s.editInput} maxLength={255} value={editAddress} onChange={e => setEditAddress(e.target.value)} placeholder="Project address or location" />
                      </div>
                      <div style={{ ...s.fieldGroup, marginTop: 8 }}>
                        <label htmlFor="mp-description" style={s.fieldLabel}>{t.mpDescription}</label>
                        <textarea id="mp-description" style={{ ...s.editInput, minHeight: 60, resize: 'vertical' }} maxLength={1000} value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Notes about this project" />
                        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(editDescription || '').length}/1000</div>
                      </div>
                      <div style={{ ...s.fieldGroup, marginTop: 8 }}>
                        <label htmlFor="mp-progress" style={s.fieldLabel}>Progress % (0–100)</label>
                        <input id="mp-progress" style={s.editInput} type="number" min="0" max="100" value={editProgressPct} onChange={e => setEditProgressPct(e.target.value)} placeholder={t.progressPctPlaceholder} />
                      </div>
                    </div>

                    {/* Geofence */}
                    {showGeofenceBudget && (
                      <div style={s.section}>
                        <div style={s.sectionTitle}>{t.geofenceOptional}<HelpTip text={t.geofenceHelp} side="bottom" /></div>
                        <div style={s.geoFields}>
                          <input style={s.geoInput} type="number" step="0.000001" placeholder={t.latitude} value={editGeoLat} onChange={e => setEditGeoLat(e.target.value)} />
                          <input style={s.geoInput} type="number" step="0.000001" placeholder={t.longitude} value={editGeoLng} onChange={e => setEditGeoLng(e.target.value)} />
                          <input style={s.geoInput} type="number" min="50" step="50" placeholder={t.radiusFt} value={editGeoRadius} onChange={e => setEditGeoRadius(e.target.value)} />
                          <button style={{ ...s.geoLocBtn, ...(geoLocating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="button" onClick={useMyLocation} disabled={geoLocating}>
                            {geoLocating ? t.loading : t.myLocation}
                          </button>
                          {p.geo_radius_ft && (confirmingClearGeoId === p.id ? (
                            <>
                              <button style={s.confirmClearBtn} type="button" onClick={() => handleClearGeofence(p.id)}>{t.confirm}</button>
                              <button style={s.cancelClearBtn} type="button" onClick={() => setConfirmingClearGeoId(null)}>{t.cancel}</button>
                            </>
                          ) : (
                            <button style={s.clearBtn} type="button" onClick={() => setConfirmingClearGeoId(p.id)}>✕ Clear</button>
                          ))}
                        </div>
                        {geoError && <p style={s.geoErrorText}>{geoError}</p>}
                        <p style={s.hint}>{t.geofenceNote}</p>
                      </div>
                    )}

                    {/* Budget */}
                    {showGeofenceBudget && (
                      <div style={s.section}>
                        <div style={s.sectionTitle}>{t.budgetOptional}</div>
                        <div style={s.geoFields}>
                          <div style={s.budgetField}>
                            <label htmlFor="mp-budget-hours" style={s.budgetLabel}>{t.hours}</label>
                            <input id="mp-budget-hours" style={s.geoInput} type="number" min="0" step="0.5" placeholder={t.budgetHoursPlaceholder} value={editBudgetHours} onChange={e => setEditBudgetHours(e.target.value)} />
                          </div>
                          <div style={s.budgetField}>
                            <label htmlFor="mp-budget-dollars" style={s.budgetLabel}>{t.budgetDollars}</label>
                            <input id="mp-budget-dollars" style={s.geoInput} type="number" min="0" step="100" placeholder={t.budgetDollarsPlaceholder} value={editBudgetDollars} onChange={e => setEditBudgetDollars(e.target.value)} />
                          </div>
                          {hasBudget(p) && (confirmingClearBudgetId === p.id ? (
                            <>
                              <button style={{ ...s.confirmClearBtn, alignSelf: 'flex-end' }} type="button" onClick={() => handleClearBudget(p.id)}>{t.confirm}</button>
                              <button style={{ ...s.cancelClearBtn, alignSelf: 'flex-end' }} type="button" onClick={() => setConfirmingClearBudgetId(null)}>{t.cancel}</button>
                            </>
                          ) : (
                            <button style={{ ...s.clearBtn, alignSelf: 'flex-end' }} type="button" onClick={() => setConfirmingClearBudgetId(p.id)}>✕ Clear</button>
                          ))}
                        </div>
                        <p style={s.hint}>{t.budgetNote}</p>
                      </div>
                    )}

                    {/* Clock-in Checklist */}
                    <div style={s.section}>
                      <div style={s.sectionTitle}>{t.clockInChecklist}</div>
                      <select
                        style={s.editInput}
                        value={editRequiredChecklist}
                        onChange={e => setEditRequiredChecklist(e.target.value)}
                      >
                        <option value="">{t.noChecklistRequired}</option>
                        {checklistTemplates.map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                      <p style={s.hint}>{t.clockInChecklistHint}</p>
                    </div>

                    {/* Hour limits */}
                    <div style={s.section}>
                      <div style={s.sectionTitle}>{t.hourLimitTitle}</div>
                      <select style={s.editInput} value={editHourLimitMode} onChange={e => setEditHourLimitMode(e.target.value)}>
                        <option value="off">{t.hourLimitOff}</option>
                        <option value="warn">{t.hourLimitWarn}</option>
                        <option value="hard">{t.hourLimitHard}</option>
                      </select>
                      {editHourLimitMode !== 'off' && (
                        <div style={s.geoFields}>
                          <div style={s.budgetField}>
                            <label style={s.budgetLabel}>{t.hourLimitDaily}</label>
                            <input style={s.geoInput} type="number" min="0" step="0.5" placeholder={t.hourLimitHoursPlaceholder} value={editDailyHourLimit} onChange={e => setEditDailyHourLimit(e.target.value)} />
                          </div>
                          <div style={s.budgetField}>
                            <label style={s.budgetLabel}>{t.hourLimitWeekly}</label>
                            <input style={s.geoInput} type="number" min="0" step="1" placeholder={t.hourLimitHoursPlaceholder} value={editWeeklyHourLimit} onChange={e => setEditWeeklyHourLimit(e.target.value)} />
                          </div>
                        </div>
                      )}
                      {editHourLimitMode === 'hard' && (
                        <div style={{ marginTop: 8 }}>
                          <label style={s.budgetLabel}>{t.hourLimitOverflow}</label>
                          <select style={s.editInput} value={editOverflowProjectId} onChange={e => setEditOverflowProjectId(e.target.value)}>
                            <option value="">{t.hourLimitOverflowNone}</option>
                            {projects.filter(op => op.id !== p.id && op.active !== false).map(op => (
                              <option key={op.id} value={op.id}>{op.name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <p style={s.hint}>{t.hourLimitHint}</p>
                    </div>

                    {/* Actions */}
                    <div style={s.actionRow}>
                      <button style={s.saveBtn} onClick={() => handleEditSave(p.id)}>{t.save}</button>
                      <button style={s.cancelBtn} onClick={() => setExpandedId(null)}>{t.cancel}</button>
                      {projects.length > 1 && (
                        <button style={s.mergeBtn} onClick={() => { setMergeSource({ id: p.id, name: p.name }); setMergeTargetId(''); }}>{t.mergeIntoBtn}</button>
                      )}
                      <button style={s.removeBtn} onClick={() => handleRemove(p.id, p.name)}>{t.remove}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {mergeSource && (
        <div style={s.modalOverlay}>
          <ModalShell
            onClose={() => !mergeSaving && setMergeSource(null)}
            titleId="mp-merge-title"
            style={s.modal}
          >
            <div id="mp-merge-title" style={s.modalTitle}>Merge "{mergeSource.name}"</div>
            <p style={s.modalBody}>
              All time entries, field reports, and other data will be moved to the target project.
              "{mergeSource.name}" will be permanently deleted. This cannot be undone.
            </p>
            <div style={s.fieldGroup}>
              <label htmlFor="mp-merge-into" style={s.fieldLabel}>{t.mergeIntoLabel}</label>
              <select
                id="mp-merge-into"
                style={s.editInput}
                value={mergeTargetId}
                onChange={e => setMergeTargetId(e.target.value)}
              >
                <option value="">Select project</option>
                {projects.filter(p => p.id !== mergeSource.id).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div style={s.modalActions}>
              <button style={{ ...s.cancelBtn, ...(mergeSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => setMergeSource(null)} disabled={mergeSaving}>{t.cancel}</button>
              <button style={{ ...s.mergeConfirmBtn, ...(!mergeTargetId || mergeSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleConfirmMerge} disabled={!mergeTargetId || mergeSaving}>
                {mergeSaving ? t.saving : t.mergeAndDelete}
              </button>
            </div>
          </ModalShell>
        </div>
      )}

      {archiveTarget && (
        <div style={s.modalOverlay}>
          <ModalShell
            onClose={() => setArchiveTarget(null)}
            titleId="mp-archive-title"
            style={s.modal}
          >
            <div id="mp-archive-title" style={s.modalTitle}>Archive "{archiveTarget.name}"?</div>
            <p style={s.modalBody}>
              Time entries will be kept and the project can be restored later from Inactive.
            </p>
            {settings?.media_delete_on_project_archive && (
              <div style={s.modalWarn}>
                <strong>Media will be permanently deleted.</strong> The delete media on archive setting is active. All photos and attachments for this project will be removed from storage and cannot be recovered.
              </div>
            )}
            <div style={s.modalDownload}>
              <button style={{ ...s.downloadBtn, ...(archiveDownloading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDownloadZip} disabled={archiveDownloading}>
                {archiveDownloading ? t.preparing : t.downloadMediaZip}
              </button>
              {!settings?.media_delete_on_project_archive && (
                <button style={{ ...s.downloadBtn, background: '#6b7280', marginTop: 4, ...(archiveDownloading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDownloadMediaUrls} disabled={archiveDownloading}>
                  {t.downloadMediaUrls}
                </button>
              )}
              <span style={s.downloadHint}>{t.mpArchiveDownloadHint}</span>
            </div>
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setArchiveTarget(null)}>{t.cancel}</button>
              <button style={s.archiveBtn} onClick={handleConfirmArchive}>Archive Project</button>
            </div>
          </ModalShell>
        </div>
      )}

      <div style={s.historyFooter}>
        <button style={s.historyToggle} onClick={() => setShowHistory(v => !v)}>
          {showHistory ? '▾' : '▸'} {t.history} {archived.length > 0 ? `(${archived.length})` : ''}
        </button>
        {showHistory && (
          <div style={s.historyList}>
            {loadingArchived ? (
              <SkeletonList count={3} rows={1} />
            ) : archived.length === 0 ? (
              <p style={s.empty}>No inactive projects.</p>
            ) : (
              archived.map(p => (
                <div key={p.id} style={s.historyItem}>
                  <div style={s.itemLeft}>
                    <span style={{ ...s.itemName, color: '#6b7280' }}>{p.name}</span>
                    {showWageType && <span style={{ fontSize: 12, color: '#d1d5db' }}>{p.wage_type === 'prevailing' ? t.prevailingWages : t.regularWages}</span>}
                  </div>
                  <button style={s.restoreBtn} onClick={() => handleRestore(p.id)}>{t.restore}</button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  cardTitle: { fontSize: 17, fontWeight: 700, marginBottom: 14 },
  form: { display: 'flex', gap: 10, marginBottom: 12 },
  input: { flex: 1, padding: '8px 11px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 },
  select: { padding: '8px 11px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 },
  addBtn: { padding: '8px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  errorBox: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
  errorText: { color: '#e53e3e', fontSize: 13, margin: 0 },
  restoreInlineBtn: { background: '#059669', color: '#fff', border: 'none', padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  list: { display: 'flex', flexDirection: 'column', gap: 2 },
  item: { border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden' },
  itemBar: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', gap: 10 },
  itemLeft: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  itemName: { fontSize: 14, fontWeight: 600, color: '#111827' },
  chevron: { fontSize: 14, color: '#6b7280', transition: 'transform 0.2s', flexShrink: 0, display: 'inline-block' },
  panel: { padding: '4px 16px 16px', borderTop: '1px solid #f3f4f6', background: '#f9fafb', display: 'flex', flexDirection: 'column', gap: 0 },
  section: { borderBottom: '1px solid #eeeeee', paddingBottom: 12, paddingTop: 12 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  fieldsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 3 },
  fieldLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280' },
  editInput: { padding: '6px 9px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' },
  wageBadge: { color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' },
  rateTag: { fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' },
  indicatorBadge: { fontSize: 13, lineHeight: 1, cursor: 'default' },
  geoFields: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  geoInput: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, width: 120 },
  geoLocBtn: { padding: '5px 10px', background: '#0369a1', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  clearBtn: { padding: '5px 10px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 6, fontSize: 11, cursor: 'pointer', flexShrink: 0 },
  confirmClearBtn: { padding: '5px 10px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  cancelClearBtn: { padding: '5px 10px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 6, fontSize: 11, cursor: 'pointer', flexShrink: 0 },
  geoErrorText: { fontSize: 11, color: '#dc2626', margin: '4px 0 0', fontWeight: 600 },
  hint: { fontSize: 11, color: '#6b7280', margin: '4px 0 0', opacity: 0.8 },
  budgetField: { display: 'flex', flexDirection: 'column', gap: 3 },
  budgetLabel: { fontSize: 11, color: '#92400e', fontWeight: 600 },
  actionRow: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 14, flexWrap: 'wrap' },
  saveBtn: { padding: '7px 16px', background: '#059669', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  cancelBtn: { padding: '7px 14px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 7, fontSize: 13, cursor: 'pointer' },
  removeBtn: { padding: '6px 14px', background: 'none', border: '1px solid #fca5a5', color: '#ef4444', borderRadius: 6, fontSize: 13, cursor: 'pointer', marginLeft: 'auto' },
  mergeBtn: { padding: '6px 14px', background: 'none', border: '1px solid #c4b5fd', color: '#8b5cf6', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  mergeConfirmBtn: { padding: '8px 18px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  historyFooter: { marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 },
  historyToggle: { background: 'none', border: 'none', color: '#6b7280', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '2px 0' },
  historyList: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 },
  historyItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f9fafb', borderRadius: 7 },
  restoreBtn: { padding: '4px 12px', background: 'none', border: '1px solid #6ee7b7', color: '#059669', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal: { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 440, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: 14 },
  modalTitle: { fontSize: 16, fontWeight: 700, color: '#111827' },
  modalBody: { fontSize: 14, color: '#374151', margin: 0 },
  modalWarn: { fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px' },
  modalDownload: { display: 'flex', flexDirection: 'column', gap: 5, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' },
  downloadBtn: { padding: '6px 14px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer', alignSelf: 'flex-start' },
  downloadHint: { fontSize: 12, color: '#6b7280' },
  modalActions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  archiveBtn: { padding: '8px 18px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  statusBadge: { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
  clientTag: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },
};
