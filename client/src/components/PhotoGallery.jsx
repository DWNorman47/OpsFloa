import React, { useState, useEffect } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import Pagination from './Pagination';
import { SkeletonList } from './Skeleton';
import FieldFilters from './FieldFilters';
import { downloadBlob } from '../utils/csv';
import { openVideoConverter } from '../utils/videoConvert';
import { useConfirm } from './ConfirmDialog';

import { silentError } from '../errorReporter';
function fmtDate(str, locale = 'en-US') {
  if (!str) return '';
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return String(str);
  return parsed.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function isVideo(item) {
  return item.media_type === 'video' || /\.(mp4|mov|webm|avi|m4v)$/i.test(item.url || '');
}

function MediaTile({ item, onClick }) {
  const video = isVideo(item);
  const label = [item.caption || (video ? 'Video' : 'Photo'), item.project_name].filter(Boolean).join(' - ');
  return (
    <div style={styles.tile} onClick={onClick} role="button" tabIndex={0} aria-label={label} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick()}>
      {video ? (
        <div style={styles.videoThumb}>
          <video src={item.url} style={styles.tileImg} preload="metadata" muted playsInline aria-hidden="true" />
          <div style={styles.playOverlay}>Play</div>
        </div>
      ) : (
        <img src={item.url} style={styles.tileImg} alt="" loading="lazy" aria-hidden="true" />
      )}
      {item.caption && <div style={styles.tileCaption}>{item.caption}</div>}
      {item.project_name && <div style={styles.tileProject}>{item.project_name}</div>}
    </div>
  );
}

function Lightbox({ items, index, onClose, onDelete, deleting = false, locale = 'en-US', lang }) {
  const [idx, setIdx] = useState(index);
  const [downloading, setDownloading] = useState(false);
  const [converting, setConverting] = useState(false);
  const t = useT();
  const item = items[idx];
  const video = isVideo(item);
  const canDelete = Boolean(item?.id && onDelete);
  const canDownload = Boolean(item?.id && item?.url);

  const downloadItem = async () => {
    if (!canDownload || downloading) return;
    setDownloading(true);
    try {
      const res = await api.get(`/field-reports/photos/${item.id}/download`, { responseType: 'blob' });
      const ext = (item.url.split('?')[0].split('.').pop() || (video ? 'mp4' : 'jpg')).toLowerCase();
      downloadBlob(res.data, `field-photo-${item.id}.${ext}`);
    } catch {
      window.open(item.url, '_blank', 'noopener');
    } finally {
      setDownloading(false);
    }
  };

  const convertItem = async () => {
    if (!canDownload || converting) return;
    setConverting(true);
    try {
      const res = await api.get(`/field-reports/photos/${item.id}/download`, { responseType: 'blob' });
      const ext = (item.url.split('?')[0].split('.').pop() || 'mov').toLowerCase();
      openVideoConverter({ blob: res.data, filename: `field-video-${item.id}.${ext}`, lang });
    } catch {
      window.open(item.url, '_blank', 'noopener');
    } finally {
      setConverting(false);
    }
  };

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setIdx(i => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIdx(i => Math.min(items.length - 1, i + 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <button style={styles.exitBtn} aria-label={t.labelModalClose || 'Close image viewer'} onClick={onClose}>Exit</button>
      {canDelete && (
        <button
          type="button"
          style={{ ...styles.deleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
          onClick={e => {
            e.stopPropagation();
            onDelete(item);
          }}
          disabled={deleting}
        >
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      )}
      <div style={styles.lbContent} onClick={e => e.stopPropagation()}>
        {video ? (
          <video
            key={item.url}
            src={item.url}
            style={styles.lightboxVideo}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <img src={item.url} style={styles.lightboxImg} alt="" />
        )}
      </div>
      <div style={styles.lightboxMeta} onClick={e => e.stopPropagation()}>
        {item.caption && <div style={styles.caption}>{item.caption}</div>}
        <div style={styles.metaLine}>
          {item.worker_name && <span>{item.worker_name} / </span>}
          {item.project_name && <span>{item.project_name} / </span>}
          <span>{fmtDate(item.reported_at, locale)}</span>
          {item.lat && (
            <a href={`https://www.google.com/maps?q=${item.lat},${item.lng}`}
               target="_blank" rel="noopener noreferrer" style={styles.mapLink}>
              Map
            </a>
          )}
        </div>
      </div>
      {canDownload && (
        <div style={styles.actionRow} onClick={e => e.stopPropagation()}>
          <button
            type="button"
            style={{ ...styles.downloadBtn, marginTop: 0, ...(downloading ? { opacity: 0.6, cursor: 'wait' } : {}) }}
            onClick={downloadItem}
            disabled={downloading}
          >
            {downloading ? (t.downloading || 'Downloading…') : (t.downloadImage || 'Download')}
          </button>
          {video && (
            <button
              type="button"
              style={{ ...styles.downloadBtn, marginTop: 0, ...(converting ? { opacity: 0.6, cursor: 'wait' } : {}) }}
              onClick={convertItem}
              disabled={converting}
            >
              {converting ? (t.opening || 'Opening…') : (t.convertVideo || 'Convert')}
            </button>
          )}
        </div>
      )}
      <div style={styles.navRow} onClick={e => e.stopPropagation()}>
        <button style={{ ...styles.navBtn, ...(idx === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.prevPhoto} onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0}>{'<'}</button>
        <span style={styles.navCount}>{idx + 1} / {items.length}</span>
        <button style={{ ...styles.navBtn, ...(idx === items.length - 1 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.nextPhoto} onClick={() => setIdx(i => Math.min(items.length - 1, i + 1))} disabled={idx === items.length - 1}>{'>'}</button>
      </div>
      <button style={styles.closeBtn} aria-label={t.labelModalClose} onClick={onClose}>X</button>
    </div>
  );
}

export default function PhotoGallery({ projects, activeProject = '', onProjectChange }) {
  const { user } = useAuth();
  const t = useT();
  const locale = langToLocale(user?.language);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ project_id: activeProject != null ? String(activeProject) : '' });
  const [lightbox, setLightbox] = useState(null);
  const [deletingMedia, setDeletingMedia] = useState(false);
  const [zipping, setZipping] = useState(false);
  const { confirm, dialog } = useConfirm();
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const hasFilters = Boolean(filters.project_id || filters.from || filters.to);

  const setFilter = (k, v) => { setPage(1); setFilters(f => ({ ...f, [k]: v })); };
  const clearFilters = () => { setPage(1); setFilters({}); onProjectChange?.(''); };
  useEffect(() => { setFilters(f => ({ ...f, project_id: activeProject != null ? String(activeProject) : '' })); }, [activeProject]);

  const loadMedia = async (f = filters, p = page) => {
    try {
      const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: p, limit: 100 };
      const r = await api.get('/field-reports/photos', { params });
      setMedia(r.data.items);
      setPages(r.data.pages || 1);
    } catch (err) { silentError('photo-gallery fetch')(err); }
  };

  useEffect(() => { loadMedia(filters, page).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!loading) loadMedia(filters, page); }, [filters, page]);

  const grouped = media.reduce((acc, item) => {
    const day = item.reported_at?.substring(0, 10) ?? 'Unknown';
    if (!acc[day]) acc[day] = [];
    acc[day].push(item);
    return acc;
  }, {});

  const days = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  const photoCount = media.filter(m => !isVideo(m)).length;
  const videoCount = media.filter(m => isVideo(m)).length;

  // Bulk download of a project's media, via the existing (admin-only, per-project)
  // /admin/projects/:id/media-zip endpoint. Fetched as a blob so the JWT rides along;
  // only offered when a specific project is selected, since the ZIP is per-project.
  const downloadZip = async () => {
    if (!filters.project_id || zipping) return;
    setZipping(true);
    try {
      const res = await api.get(`/admin/projects/${filters.project_id}/media-zip`, { responseType: 'blob' });
      const proj = projects.find(p => String(p.id) === String(filters.project_id));
      const name = (proj?.name || 'project').replace(/[^a-z0-9]/gi, '_');
      downloadBlob(res.data, `${name}_media.zip`);
    } catch (err) {
      const status = err.response?.status;
      alert(status === 404 ? (t.noMediaDownload || 'No media found to download.') : (t.downloadFailed || "Couldn't download. Try again."));
    } finally {
      setZipping(false);
    }
  };

  const deleteMedia = async (item) => {
    if (!item?.id || deletingMedia) return;
    if (!await confirm({ title: t.mediaDeleteTitle, body: t.mediaDeleteBody, confirmLabel: t.mediaDeleteConfirm, tone: 'danger' })) return;
    setDeletingMedia(true);
    try {
      await api.delete(`/field-reports/photos/${item.id}`);
      setMedia(prev => prev.filter(m => m.id !== item.id));
      setLightbox(null);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete image.');
    } finally {
      setDeletingMedia(false);
    }
  };

  return (
    <div>
      <div className="field-gallery-toprow" style={styles.topRow}>
        <h1 style={styles.heading}>{t.mediaGallery}</h1>
        <span style={styles.count}>
          {photoCount > 0 && `${photoCount} photo${photoCount !== 1 ? 's' : ''}`}
          {photoCount > 0 && videoCount > 0 && ' · '}
          {videoCount > 0 && `${videoCount} video${videoCount !== 1 ? 's' : ''}`}
          {media.length === 0 && '0 items'}
        </span>
      </div>

      <FieldFilters activeCount={Object.values(filters).filter(Boolean).length}>
        {projects.length > 0 && (
          <label style={styles.filterField}>
            <span style={styles.dateLabel}>Project</span>
            <select style={styles.filterSelect} value={filters.project_id || ''} onChange={e => { setFilter('project_id', e.target.value); onProjectChange?.(e.target.value); }}>
              <option value="">{`All Projects`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label style={styles.dateField}>
          <span style={styles.dateLabel}>{t.fromDate}</span>
          <input style={styles.filterInput} type="date" value={filters.from || ''} onChange={e => setFilter('from', e.target.value)} title={t.fromDate} />
        </label>
        <label style={styles.dateField}>
          <span style={styles.dateLabel}>{t.toDate}</span>
          <input style={styles.filterInput} type="date" value={filters.to || ''} onChange={e => setFilter('to', e.target.value)} title={t.toDate} />
        </label>
        {hasFilters && (
          <button type="button" style={styles.clearFiltersBtn} onClick={clearFilters}>
            Clear filters
          </button>
        )}
        {isAdmin && filters.project_id && media.length > 0 && (
          <button type="button" style={{ ...styles.zipBtn, ...(zipping ? { opacity: 0.6, cursor: 'wait' } : {}) }} onClick={downloadZip} disabled={zipping}>
            {zipping ? (t.zippingMedia || 'Preparing ZIP…') : (t.downloadMediaZip || 'Download all (ZIP)')}
          </button>
        )}
      </FieldFilters>

      {lightbox !== null && (
        <Lightbox
          items={media}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onDelete={deleteMedia}
          deleting={deletingMedia}
          locale={locale}
          lang={user?.language}
        />
      )}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : media.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No media yet</p>
          <p style={styles.emptyText}>Photos and videos added to work notes will appear here for review.</p>
          <a style={styles.emptyCtaBtn} href="#notes">Open work notes</a>
        </div>
      ) : (
        <>
          {days.map(day => (
            <div key={day} style={styles.dayGroup}>
              <div style={styles.dayHeader}>
                <span style={styles.dayLabel}>{fmtDate(day + 'T12:00:00', locale)}</span>
                <span style={styles.dayCount}>{grouped[day].length} item{grouped[day].length !== 1 ? 's' : ''}</span>
              </div>
              <div style={styles.grid}>
                {grouped[day].map(item => {
                  const idx = media.indexOf(item);
                  return <MediaTile key={item.id} item={item} onClick={() => setLightbox(idx)} />;
                })}
              </div>
            </div>
          ))}
          <Pagination page={page} pages={pages} onChange={setPage} />
        </>
      )}
      {dialog}
    </div>
  );
}

const styles = {
  topRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  count: { fontSize: 13, color: '#6b7280', fontWeight: 500 },
  filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20, alignItems: 'end' },
  filterField: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180, flex: '1 1 auto' },
  filterSelect: { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151' },
  dateField: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150, flex: '1 1 auto' },
  dateLabel: { fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' },
  filterInput: { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151' },
  clearFiltersBtn: { minHeight: 34, padding: '7px 12px', border: '1px solid #d1d5db', borderRadius: 7, background: '#fff', color: '#374151', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  zipBtn: { minHeight: 34, padding: '7px 14px', border: 'none', borderRadius: 7, background: '#059669', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15 },
  emptyCtaBtn: { display: 'inline-block', marginTop: 14, background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer', textDecoration: 'none' },
  dayGroup: { marginBottom: 28 },
  dayHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  dayLabel: { fontSize: 14, fontWeight: 700, color: '#374151' },
  dayCount: { fontSize: 12, color: '#6b7280' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 },
  tile: { position: 'relative', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', aspectRatio: '1', background: '#111827' },
  videoThumb: { width: '100%', height: '100%', position: 'relative' },
  tileImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  playOverlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: '#fff', background: 'rgba(0,0,0,0.35)', pointerEvents: 'none', textTransform: 'uppercase', letterSpacing: '0.08em' },
  tileCaption: { position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.65))', color: '#fff', fontSize: 10, padding: '14px 6px 5px', lineHeight: 1.3 },
  tileProject: { position: 'absolute', top: 5, left: 5, background: 'rgba(109,40,217,0.85)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 8 },
  // Lightbox
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.95)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16 },
  lbContent: { maxWidth: '100%', maxHeight: '72vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  lightboxImg: { maxWidth: '100%', maxHeight: '72vh', objectFit: 'contain', borderRadius: 8 },
  lightboxVideo: { maxWidth: '100%', maxHeight: '72vh', borderRadius: 8, outline: 'none' },
  lightboxMeta: { marginTop: 12, textAlign: 'center' },
  caption: { color: '#fff', fontSize: 14, marginBottom: 4 },
  metaLine: { color: 'rgba(255,255,255,0.6)', fontSize: 12, display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', alignItems: 'center' },
  mapLink: { color: '#60a5fa', textDecoration: 'none', fontWeight: 600 },
  actionRow: { display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap', justifyContent: 'center' },
  downloadBtn: { marginTop: 14, background: 'rgba(255,255,255,0.16)', color: '#fff', border: '1px solid rgba(255,255,255,0.28)', borderRadius: 999, padding: '9px 20px', fontSize: 14, fontWeight: 800, cursor: 'pointer', lineHeight: 1 },
  navRow: { display: 'flex', alignItems: 'center', gap: 20, marginTop: 16 },
  navBtn: { background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', fontSize: 24, width: 44, height: 44, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  navCount: { color: '#fff', fontSize: 13 },
  // Offset the top bar below the phone's status bar / notch (safe-area insets) so the
  // buttons don't collide with the OS UI on mobile.
  exitBtn: { position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 16px)', right: 'calc(env(safe-area-inset-right, 0px) + 16px)', background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.28)', color: '#fff', fontSize: 14, fontWeight: 800, borderRadius: 999, padding: '9px 16px', cursor: 'pointer', lineHeight: 1 },
  deleteBtn: { position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 16px)', left: 'calc(env(safe-area-inset-left, 0px) + 16px)', background: 'rgba(220,38,38,0.9)', border: '1px solid rgba(255,255,255,0.24)', color: '#fff', fontSize: 14, fontWeight: 800, borderRadius: 999, padding: '9px 16px', cursor: 'pointer', lineHeight: 1 },
  closeBtn: { display: 'none' },
};
