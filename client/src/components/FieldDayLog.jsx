import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import PhotoCapture from './PhotoCapture';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import { SkeletonList } from './Skeleton';
import { safeLocal } from '../utils/safeStorage';
import { useConfirm } from './ConfirmDialog';

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toLocaleDateString('en-CA');
}

function shiftDate(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
}

function dayLabel(dateStr, t, locale = 'en-US') {
  const today = todayISO();
  if (dateStr === today) return t ? t.today : 'Today';
  if (dateStr === shiftDate(today, -1)) return t ? t.yesterday : 'Yesterday';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(locale, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function getRecentProjects() {
  try { return JSON.parse(safeLocal.getItem('field-recent-projects') || '[]'); } catch { return []; }
}

function markProjectUsed(id) {
  if (!id) return;
  const recent = getRecentProjects().filter(x => x !== String(id));
  safeLocal.setItem('field-recent-projects', JSON.stringify([String(id), ...recent].slice(0, 30)));
}

function sortProjects(projects) {
  const recent = getRecentProjects();
  return [...projects].sort((a, b) => {
    const ai = recent.indexOf(String(a.id));
    const bi = recent.indexOf(String(b.id));
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    // Neither recently used — newest project first
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

function getLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { timeout: 8000 }
    );
  });
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

export function Lightbox({ photos, startIndex, onClose, onDelete, deleting = false }) {
  const t = useT();
  const [idx, setIdx] = useState(startIndex);
  const item = photos[idx];
  const isVid = item.media_type === 'video' || /\.(mp4|mov|webm|avi|m4v)$/i.test(item.url || '');
  const canDelete = Boolean(item.id && !item.pending && onDelete);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setIdx(i => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIdx(i => Math.min(photos.length - 1, i + 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={s.lbBackdrop} onClick={onClose}>
      <button type="button" style={s.lbCloseBtn} onClick={onClose} aria-label={t.labelModalClose || 'Close image viewer'}>
        Exit
      </button>
      {canDelete && (
        <button
          type="button"
          style={{ ...s.lbDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
          onClick={e => {
            e.stopPropagation();
            onDelete(item);
          }}
          disabled={deleting}
        >
          {deleting ? 'Deleting...' : 'Delete image'}
        </button>
      )}
      {isVid ? (
        <video key={item.url} src={item.url} style={s.lbImg} controls autoPlay playsInline onClick={e => e.stopPropagation()} />
      ) : (
        <img src={item.url} style={s.lbImg} alt="" onClick={e => e.stopPropagation()} />
      )}
      {item.caption && <div style={s.lbCaption}>{item.caption}</div>}
      <div style={s.lbNav} onClick={e => e.stopPropagation()}>
        <button style={{ ...s.lbBtn, ...(idx === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.prevPhoto} onClick={() => setIdx(i => i - 1)} disabled={idx === 0}>{'<'}</button>
        <span style={s.lbCount}>{idx + 1} / {photos.length}</span>
        <button style={{ ...s.lbBtn, ...(idx === photos.length - 1 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.nextPhoto} onClick={() => setIdx(i => i + 1)} disabled={idx === photos.length - 1}>{'>'}</button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FieldDayLog({ projects, isAdmin, activeProject, onProjectChange }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const { onSync } = useOffline() || {};

  const [project, setProject] = useState(activeProject != null ? String(activeProject) : '');
  const [date, setDate] = useState(todayISO());
  const [dayReports, setDayReports] = useState([]);
  const [loading, setLoading] = useState(false);

  const [photoOpen, setPhotoOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [capturePhotos, setCapturePhotos] = useState([]);
  const [captureNote, setCaptureNote] = useState('');
  const [captureVideo, setCaptureVideo] = useState(null); // { file, previewUrl }
  const [videoCaption, setVideoCaption] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [lightbox, setLightbox] = useState(null); // { photos, index }
  const [deletingPhoto, setDeletingPhoto] = useState(false);
  const { confirm, dialog } = useConfirm();
  const loadSeqRef = useRef(0);

  const today = todayISO();
  const isToday = date === today;
  const isPastDay = date < today;

  // The project is the shared Field "active project" (FieldPage seeds it from the
  // clocked-in job). Keep in sync if it changes elsewhere while this tab is open.
  useEffect(() => {
    const next = activeProject != null ? String(activeProject) : '';
    setProject(prev => (prev === next ? prev : next));
  }, [activeProject]);

  const load = async (proj = project, d = date) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const params = { from: d, to: d };
      if (proj) params.project_id = proj;
      const r = await api.get('/field-reports', { params });
      if (seq === loadSeqRef.current) setDayReports(r.data.items || []);
    } catch {
      if (seq === loadSeqRef.current) setError(t.failedLoadFieldReports);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => { if (isAdmin || project !== '' || projects.length === 0) load(); }, [project, date, isAdmin]);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) load(project, date); }); }, [onSync, project, date]);

  const closeAll = () => { setPhotoOpen(false); setNoteOpen(false); setVideoOpen(false); };

  const selectProject = id => {
    setProject(id);
    onProjectChange?.(id); // write back to the shared Field project so other tabs follow
    if (!isAdmin && id) {
      safeLocal.setItem('field-last-project', id);
      markProjectUsed(id);
    }
    closeAll();
  };

  const prevDay = () => { setDate(d => shiftDate(d, -1)); closeAll(); };
  const nextDay = () => { if (!isToday) { setDate(d => shiftDate(d, 1)); closeAll(); } };

  const openPhoto = () => { setPhotoOpen(o => !o); setNoteOpen(false); setVideoOpen(false); setError(''); };
  const openNote  = () => { setNoteOpen(o => !o); setPhotoOpen(false); setVideoOpen(false); setError(''); };
  const openVideo = () => { setVideoOpen(o => !o); setPhotoOpen(false); setNoteOpen(false); setError(''); };

  const submitPhotos = async () => {
    if (capturePhotos.length === 0) { setError(t.atLeastOnePhoto); return; }
    setSaving(true); setError('');
    const { lat, lng } = await getLocation();
    try {
      const r = await api.post('/field-reports', {
        project_id: project || undefined,
        photos: capturePhotos,
        lat, lng,
        report_date: date,
      });
      const item = r.data?.offline
        ? { id: 'pending-' + Date.now(), pending: true, photos: capturePhotos.map(p => ({ url: p.url, caption: p.caption || '' })), notes: null, reported_at: new Date().toISOString(), project_id: project }
        : r.data;
      setDayReports(prev => [item, ...prev]);
      setCapturePhotos([]);
      setPhotoOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  const submitNote = async () => {
    if (!captureNote.trim()) { setError(t.enterANote); return; }
    setSaving(true); setError('');
    const { lat, lng } = await getLocation();
    try {
      const r = await api.post('/field-reports', {
        project_id: project || undefined,
        notes: captureNote,
        lat, lng,
        report_date: date,
      });
      const item = r.data?.offline
        ? { id: 'pending-' + Date.now(), pending: true, notes: captureNote, photos: [], reported_at: new Date().toISOString(), project_id: project }
        : r.data;
      setDayReports(prev => [item, ...prev]);
      setCaptureNote('');
      setNoteOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  const submitVideo = async () => {
    if (!captureVideo) { setError(t.selectVideoFirst); return; }
    setSaving(true); setError(''); setUploadProgress(0);
    try {
      const contentType = captureVideo.file.type || 'video/mp4';
      const { data: { uploadUrl, publicUrl } } = await api.get('/field-reports/upload-url', { params: { contentType } });

      // Upload directly to R2 with progress
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = e => { if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error('Upload failed'));
        xhr.onerror = reject;
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.send(captureVideo.file);
      });

      const { lat, lng } = await getLocation();
      const r = await api.post('/field-reports', {
        project_id: project || undefined,
        photos: [{ url: publicUrl, caption: videoCaption, media_type: 'video' }],
        lat, lng,
        report_date: date,
      });
      setDayReports(prev => [r.data, ...prev]);
      setCaptureVideo(null);
      setVideoCaption('');
      setVideoOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || t.uploadFailed);
    } finally { setSaving(false); setUploadProgress(0); }
  };

  const handleReview = async (id) => {
    try {
      await api.patch(`/field-reports/${id}/review`);
      setDayReports(prev => prev.map(r => r.id === id ? { ...r, status: 'reviewed' } : r));
    } catch { setError(t.failedMarkReviewed); }
  };

  const handleDeletePhoto = async (photo) => {
    if (!photo?.id || deletingPhoto) return;
    if (!await confirm({ title: t.mediaDeleteTitle, body: t.mediaDeleteBody, confirmLabel: t.mediaDeleteConfirm, tone: 'danger' })) return;
    setDeletingPhoto(true);
    setError('');
    try {
      await api.delete(`/field-reports/photos/${photo.id}`);
      setDayReports(prev => prev.map(r => ({
        ...r,
        photos: (r.photos || []).filter(p => p.id !== photo.id),
      })));
      setLightbox(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete image.');
    } finally {
      setDeletingPhoto(false);
    }
  };

  // Flatten all photos across the day's reports
  const allPhotos = dayReports.flatMap(r =>
    (r.photos || []).map(p => ({
      ...p,
      worker_name: r.worker_name,
      reported_at: r.reported_at,
      pending: r.pending,
    }))
  );

  // Reports that have notes
  const allNotes = dayReports.filter(r => r.notes?.trim());

  const unreviewedNotes = allNotes.filter(r => r.status !== 'reviewed' && !r.pending).length;

  const sorted = sortProjects(projects);

  return (
    <div>
      {lightbox && (
        <Lightbox
          photos={lightbox.photos}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
          onDelete={handleDeletePhoto}
          deleting={deletingPhoto}
        />
      )}

      {/* Top bar — project + date nav */}
      <div style={s.topBar} className="field-day-topbar">
        <label style={s.projectField}>
          <span style={s.projectLabel}>Project</span>
          <select style={s.projectSelect} value={project} onChange={e => selectProject(e.target.value)}>
            <option value="">{`All Projects`}</option>
            {sorted.map(p => (
              <option key={p.id} value={String(p.id)}>{p.name}</option>
            ))}
          </select>
        </label>

        <div style={s.dateNav} className="field-day-date-nav">
          <button style={s.dateArrow} aria-label={t.prevDay} onClick={prevDay}>{'<'}</button>
          <span style={s.dateLabel}>
            {dayLabel(date, t, locale)}
            {isPastDay && <span style={s.readOnlyText}>({t.readOnlyLabel || 'read-only'})</span>}
          </span>
          <button style={{ ...s.dateArrow, opacity: isToday ? 0.3 : 1, ...(isToday ? { cursor: 'not-allowed' } : {}) }} aria-label={t.nextDay} onClick={nextDay} disabled={isToday}>{'>'}</button>
        </div>
      </div>

      {/* Action row — today only */}
      {isToday && (
        <div style={s.actionRow} className="field-day-actions">
          <button style={photoOpen ? { ...s.actionBtn, ...s.actionBtnOn } : s.actionBtn} onClick={openPhoto}>
            {t.photosSection}
          </button>
          <button style={videoOpen ? { ...s.actionBtn, ...s.actionBtnOn } : s.actionBtn} onClick={openVideo}>
            {t.videoSection}
          </button>
          <button style={noteOpen ? { ...s.actionBtn, ...s.actionBtnOn } : s.actionBtn} onClick={openNote}>
            {t.noteSection}
          </button>
        </div>
      )}

      {/* Photo capture panel */}
      {photoOpen && (
        <div style={s.capturePanel}>
          <PhotoCapture photos={capturePhotos} onChange={setCapturePhotos} />
          {error && <p role="alert" style={s.error}>{error}</p>}
          <div style={s.captureActions} className="field-day-capture-actions">
            <button style={{ ...s.submitBtn, ...(saving || capturePhotos.length === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submitPhotos} disabled={saving || capturePhotos.length === 0}>
              {saving ? t.submitting : capturePhotos.length > 0
                ? `${t.submitPhotos} (${capturePhotos.length})`
                : t.submitPhotos}
            </button>
            <button style={s.cancelBtn} onClick={() => { setPhotoOpen(false); setCapturePhotos([]); setError(''); }}>{t.cancel}</button>
          </div>
        </div>
      )}

      {/* Note input panel */}
      {noteOpen && (
        <div style={s.capturePanel}>
          <textarea
            style={s.noteTextarea}
            rows={5}
            maxLength={2000}
            placeholder={t.noteFieldPlaceholder}
            value={captureNote}
            onChange={e => setCaptureNote(e.target.value)}
            autoFocus
          />
          <div style={s.charCount}>{captureNote.length}/2000</div>
          {error && <p role="alert" style={s.error}>{error}</p>}
          <div style={s.captureActions} className="field-day-capture-actions">
            <button style={{ ...s.submitBtn, ...(saving || !captureNote.trim() ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submitNote} disabled={saving || !captureNote.trim()}>
              {saving ? t.submitting : t.submitNote}
            </button>
            <button style={s.cancelBtn} onClick={() => { setNoteOpen(false); setCaptureNote(''); setError(''); }}>{t.cancel}</button>
          </div>
        </div>
      )}

      {/* Video capture panel */}
      {videoOpen && (
        <div style={s.capturePanel}>
          {captureVideo ? (
            <div style={s.videoPreviewWrap}>
              <video src={captureVideo.previewUrl} style={s.videoPreview} controls playsInline />
              <button style={s.removeBtnSm} onClick={() => { URL.revokeObjectURL(captureVideo.previewUrl); setCaptureVideo(null); }}>{t.removeVideo}</button>
            </div>
          ) : (
            <label style={s.videoPickerLabel}>
              <input
                type="file"
                accept="video/*"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files[0];
                  if (file) setCaptureVideo({ file, previewUrl: URL.createObjectURL(file) });
                  e.target.value = '';
                }}
              />
              <span style={s.videoPickerText}>{t.tapToRecord}</span>
            </label>
          )}
          <input
            style={{ ...s.noteTextarea, marginTop: 10, height: 'auto', resize: 'none', rows: 1 }}
            placeholder={t.captionOptional}
            value={videoCaption}
            onChange={e => setVideoCaption(e.target.value)}
          />
          {uploadProgress > 0 && uploadProgress < 100 && (
            <div style={s.progressBar}>
              <div style={{ ...s.progressFill, width: `${uploadProgress}%` }} />
              <span style={s.progressLabel}>{uploadProgress}%</span>
            </div>
          )}
          {error && <p role="alert" style={s.error}>{error}</p>}
          <div style={s.captureActions} className="field-day-capture-actions">
            <button style={{ ...s.submitBtn, ...(saving || !captureVideo ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={submitVideo} disabled={saving || !captureVideo}>
              {saving ? (uploadProgress > 0 ? `${t.uploading} ${uploadProgress}%` : t.submitting) : t.submitVideo}
            </button>
            <button style={s.cancelBtn} onClick={() => { if (captureVideo) URL.revokeObjectURL(captureVideo.previewUrl); setCaptureVideo(null); setVideoCaption(''); setVideoOpen(false); setError(''); }}>{t.cancel}</button>
          </div>
        </div>
      )}

      {/* Day content */}
      {loading ? (
        <SkeletonList count={3} rows={2} />
      ) : dayReports.length === 0 ? (
        <div style={s.empty}>
          <p style={s.emptyText}>
            {isToday ? t.nothingLoggedToday : t.noFieldNotesDay}
          </p>
        </div>
      ) : (
        <>
          {/* Photos section */}
          {allPhotos.length > 0 && (
            <div style={s.section}>
              <div style={s.sectionHead}>
                <span style={s.sectionTitle}>{t.photosSection}</span>
                <span style={s.sectionCount}>{allPhotos.length}</span>
              </div>
              <div style={s.photoGrid}>
                {allPhotos.map((p, i) => {
                  const vid = p.media_type === 'video' || /\.(mp4|mov|webm|avi|m4v)$/i.test(p.url || '');
                  return (
                    <div key={i} style={s.photoCell} onClick={() => setLightbox({ photos: allPhotos, index: i })} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setLightbox({ photos: allPhotos, index: i })}>
                      {vid ? (
                        <>
                          <video src={p.url} style={s.photoThumb} preload="metadata" muted playsInline />
                          <div style={s.playOverlay}>Play</div>
                        </>
                      ) : (
                        <img src={p.url} style={s.photoThumb} alt={p.caption || `photo ${i + 1}`} loading="lazy" />
                      )}
                      {p.caption && <div style={s.photoCaption}>{p.caption}</div>}
                      {isAdmin && p.worker_name && <div style={s.photoWorker}>{p.worker_name}</div>}
                      {p.pending && <div style={s.pendingDot}>⏳</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Notes section */}
          {allNotes.length > 0 && (
            <div style={s.section}>
              <div style={s.sectionHead}>
                <span style={s.sectionTitle}>{t.notesSection}</span>
                <span style={s.sectionCount}>{allNotes.length}</span>
                {isAdmin && unreviewedNotes > 0 && (
                  <span style={s.unreviewedBadge}>{unreviewedNotes} {t.unreviewedLabel}</span>
                )}
              </div>
              <div style={s.notesList}>
                {allNotes.map(r => (
                  <div key={r.id} style={s.noteCard}>
                    <div style={s.noteCardHead}>
                      {isAdmin && r.worker_name && (
                        <span style={s.noteWorker}>{r.worker_name}</span>
                      )}
                      <span style={s.noteTime}>
                        {new Date(r.reported_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}
                      </span>
                      {r.pending && <span style={s.pendingBadge}>⏳ {t.pendingSync}</span>}
                      {r.lat && (
                        <a href={`https://www.google.com/maps?q=${r.lat},${r.lng}`} target="_blank" rel="noopener noreferrer" style={s.mapLink}>Map</a>
                      )}
                      {isAdmin && !r.pending && r.status !== 'reviewed' && (
                        <button style={s.reviewBtn} onClick={() => handleReview(r.id)}>✓ {t.reviewBtn}</button>
                      )}
                      {r.status === 'reviewed' && (
                        <span style={s.reviewedBadge}>✓ {t.reviewedLabel}</span>
                      )}
                    </div>
                    <p style={s.noteText}>{r.notes}</p>
                    {/* Any photos attached to this note report */}
                    {r.photos?.length > 0 && (
                      <div style={s.notePhotoStrip}>
                        {r.photos.map((p, i) => (
                          <img
                            key={i}
                            src={p.url}
                            style={s.noteThumb}
                            alt=""
                            onClick={() => setLightbox({ photos: r.photos, index: i })}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {dialog}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  topBar: { display: 'flex', gap: 10, alignItems: 'end', marginBottom: 16, flexWrap: 'wrap' },
  projectField: { display: 'flex', flex: 1, minWidth: 180, flexDirection: 'column', gap: 4 },
  projectLabel: { fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' },
  projectSelect: { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', fontWeight: 600, color: '#111827' },
  dateNav: { display: 'flex', alignItems: 'center', gap: 2, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '4px 8px' },
  dateArrow: { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#374151', padding: '2px 6px', lineHeight: 1 },
  dateLabel: { fontSize: 14, fontWeight: 700, color: '#111827', minWidth: 96, textAlign: 'center', display: 'inline-flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 },
  readOnlyText: { fontSize: 11, fontWeight: 700, color: '#64748b', marginTop: 2 },
  actionRow: { display: 'flex', gap: 10, marginBottom: 16 },
  actionBtn: { flex: 1, padding: '13px 0', background: '#fff', border: '2px solid #e5e7eb', borderRadius: 10, fontSize: 14, fontWeight: 600, color: '#374151', cursor: 'pointer', textAlign: 'center' },
  actionBtnOn: { borderColor: '#059669', color: '#059669', background: '#f0fdf4' },
  capturePanel: { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 2px 8px rgba(0,0,0,0.07)', marginBottom: 16 },
  noteTextarea: { width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6, boxSizing: 'border-box' },
  charCount: { fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 3 },
  captureActions: { display: 'flex', gap: 8, marginTop: 12 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '10px 16px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: '8px 0 0' },
  section: { marginBottom: 22 },
  sectionHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  sectionTitle: { fontSize: 12, fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em' },
  sectionCount: { fontSize: 11, fontWeight: 700, color: '#fff', background: '#9ca3af', padding: '1px 7px', borderRadius: 10 },
  unreviewedBadge: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '1px 8px', borderRadius: 10 },
  photoGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 6 },
  photoCell: { position: 'relative', cursor: 'pointer', borderRadius: 8, overflow: 'hidden', aspectRatio: '1' },
  photoThumb: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  photoCaption: { position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 10, padding: '3px 5px', lineHeight: 1.3 },
  photoWorker: { position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4, textTransform: 'uppercase' },
  pendingDot: { position: 'absolute', top: 4, right: 4, fontSize: 13 },
  playOverlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#fff', background: 'rgba(0,0,0,0.3)', pointerEvents: 'none' },
  videoPreviewWrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  videoPreview: { width: '100%', maxHeight: 240, borderRadius: 8, background: '#111', outline: 'none' },
  removeBtnSm: { alignSelf: 'flex-start', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  videoPickerLabel: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, border: '2px dashed #d1d5db', borderRadius: 10, padding: '28px 16px', cursor: 'pointer', background: '#fafafa' },
  videoPickerText: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
  progressBar: { position: 'relative', height: 8, background: '#e5e7eb', borderRadius: 4, marginTop: 10, overflow: 'hidden' },
  progressFill: { height: '100%', background: '#059669', borderRadius: 4, transition: 'width 0.2s' },
  progressLabel: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#374151', fontWeight: 700 },
  notesList: { display: 'flex', flexDirection: 'column', gap: 8 },
  noteCard: { background: '#fff', borderRadius: 10, padding: '12px 14px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
  noteCardHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
  noteWorker: { fontSize: 11, fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.04em' },
  noteTime: { fontSize: 12, color: '#6b7280' },
  pendingBadge: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6 },
  mapLink: { fontSize: 11, fontWeight: 800, color: 'var(--ops-page-accent)', textDecoration: 'none', background: '#eff6ff', borderRadius: 999, padding: '2px 7px' },
  reviewBtn: { marginLeft: 'auto', background: '#059669', color: '#fff', border: 'none', padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  reviewedBadge: { marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#065f46', background: '#d1fae5', padding: '2px 8px', borderRadius: 10 },
  noteText: { fontSize: 14, color: '#374151', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
  notePhotoStrip: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 },
  noteThumb: { width: 72, height: 54, objectFit: 'cover', borderRadius: 6, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { textAlign: 'center', padding: '46px 20px' },
  emptyText: { color: '#6b7280', fontSize: 15 },
  // Lightbox
  lbBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'pointer' },
  lbImg: { maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain', borderRadius: 8 },
  lbCaption: { color: '#fff', fontSize: 14, marginTop: 12, opacity: 0.85 },
  lbNav: { display: 'flex', alignItems: 'center', gap: 20, marginTop: 16 },
  lbBtn: { background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', fontSize: 24, width: 44, height: 44, borderRadius: '50%', cursor: 'pointer' },
  lbCount: { color: '#fff', fontSize: 13 },
  // Offset below the status bar / notch (safe-area insets) so the buttons clear the OS UI.
  lbCloseBtn: { position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 16px)', right: 'calc(env(safe-area-inset-right, 0px) + 16px)', background: 'rgba(255,255,255,0.16)', color: '#fff', border: '1px solid rgba(255,255,255,0.28)', borderRadius: 999, padding: '9px 16px', fontSize: 14, fontWeight: 800, cursor: 'pointer', lineHeight: 1 },
  lbDeleteBtn: { position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 16px)', left: 'calc(env(safe-area-inset-left, 0px) + 16px)', background: 'rgba(220,38,38,0.9)', color: '#fff', border: '1px solid rgba(255,255,255,0.24)', borderRadius: 999, padding: '9px 16px', fontSize: 14, fontWeight: 800, cursor: 'pointer', lineHeight: 1 },
};
