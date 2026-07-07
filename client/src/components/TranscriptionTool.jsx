import React, { useEffect, useRef, useState } from 'react';
import api from '../api';

/**
 * Voice transcription tool (Tools module).
 *
 * Upload a meeting/call recording → the server runs it through AssemblyAI
 * with speaker diarization → view a "who said what" transcript with
 * per-recording editable speaker names, click-to-seek playback, and
 * copy/download export.
 */

// file.type fallback for OSes that hand us an empty MIME (common for .m4a)
const EXT_TO_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm', mp4: 'video/mp4',
  mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
};

const SPEAKER_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f'];

function speakerColor(speaker) {
  const idx = (speaker?.charCodeAt(0) || 65) - 65;
  return SPEAKER_COLORS[((idx % SPEAKER_COLORS.length) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length];
}

function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(seconds) {
  if (!seconds) return '';
  return fmtClock(seconds * 1000);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function speakerLabel(recording, speaker) {
  return recording?.speaker_names?.[speaker]?.trim() || `Speaker ${speaker}`;
}

function transcriptText(detail) {
  return (detail.utterances || [])
    .map(u => `[${fmtClock(u.start_ms)}] ${speakerLabel(detail, u.speaker)}: ${u.text}`)
    .join('\n');
}

const STATUS_CHIP = {
  uploaded:   { label: 'Queued',        bg: '#e0e7ff', fg: '#3730a3' },
  processing: { label: 'Transcribing…', bg: '#fef3c7', fg: '#92400e' },
  completed:  { label: 'Ready',         bg: '#d1fae5', fg: '#065f46' },
  failed:     { label: 'Failed',        bg: '#fee2e2', fg: '#991b1b' },
};

function StatusChip({ status }) {
  const c = STATUS_CHIP[status] || STATUS_CHIP.uploaded;
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {c.label}
    </span>
  );
}

function mergeRecordingsByDate(existing, incoming) {
  const byId = new Map(existing.map(item => [item.id, item]));
  incoming.forEach(item => byId.set(item.id, item));
  return [...byId.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export default function TranscriptionTool() {
  const [recordings, setRecordings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(null); // null = idle
  const [uploadError, setUploadError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [nameEdits, setNameEdits] = useState({});
  const [titleEdit, setTitleEdit] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);
  const audioRef = useRef(null);

  const loadList = ({ nextPage = 1, append = false, quiet = true } = {}) => api.get('/recordings', {
    params: { page: nextPage, limit: 50 },
    suppressToast: quiet,
  })
    .then(r => {
      const items = r.data.items || [];
      setRecordings(prev => (append ? mergeRecordingsByDate(prev, items) : items));
      setPage(r.data.page || nextPage);
      setPages(r.data.pages || 1);
      setTotal(r.data.total || items.length);
    })
    .catch(() => { /* interceptor-level errors are enough */ });

  useEffect(() => {
    loadList({ quiet: true }).finally(() => setLoading(false));
  }, []);

  // Poll the list while anything is still being transcribed.
  const anyPending = recordings.some(r => r.status === 'processing' || r.status === 'uploaded');
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => loadList({ nextPage: 1, append: true, quiet: true }), 8000);
    return () => clearInterval(t);
  }, [anyPending]);

  const openDetail = async id => {
    setSelectedId(id);
    setDetailLoading(true);
    setCopied(false);
    try {
      const { data } = await api.get(`/recordings/${id}`);
      setDetail(data);
      setNameEdits(data.speaker_names || {});
      setTitleEdit(data.title || '');
    } catch {
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  // Refresh the open detail while it's still processing.
  useEffect(() => {
    if (!detail || (detail.status !== 'processing' && detail.status !== 'uploaded')) return;
    const t = setInterval(async () => {
      try {
        const { data } = await api.get(`/recordings/${detail.id}`, { suppressToast: true });
        setDetail(data);
        if (data.status === 'completed') loadList({ nextPage: 1, append: true, quiet: true });
      } catch { /* next tick */ }
    }, 6000);
    return () => clearInterval(t);
  }, [detail?.id, detail?.status]);

  const handleFile = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError('');

    const ext = file.name.split('.').pop()?.toLowerCase();
    const contentType = file.type || EXT_TO_MIME[ext] || '';
    if (!contentType) { setUploadError('Unrecognized file type. Use mp3, m4a, wav, aac, ogg, flac, or a video file (mp4, mov, webm, mkv, avi, 3gp).'); return; }

    setUploadProgress(0);
    try {
      const { data: { uploadId, uploadUrl, publicUrl } } = await api.post('/recordings/upload-url',
        { contentType, size: file.size }, { suppressToast: true });

      // Direct browser→R2 upload with progress
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = ev => { if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100)); };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error('Upload failed')));
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.send(file);
      });

      const { data: recording } = await api.post('/recordings', {
        upload_id: uploadId,
        title: file.name.replace(/\.[^.]+$/, ''),
        audio_url: publicUrl,
      });
      setRecordings(prev => [recording, ...prev]);
      setTotal(prev => prev + 1);
    } catch (err) {
      setUploadError(err.response?.data?.error || err.message || 'Upload failed. Please try again.');
    } finally {
      setUploadProgress(null);
    }
  };

  const retry = async id => {
    try {
      const { data } = await api.post(`/recordings/${id}/retry`);
      setRecordings(prev => prev.map(r => (r.id === id ? { ...r, ...data } : r)));
      if (detail?.id === id) setDetail(d => ({ ...d, ...data }));
    } catch { /* toast via interceptor */ }
  };

  const remove = async id => {
    if (!window.confirm('Delete this recording and its transcript? This cannot be undone.')) return;
    try {
      await api.delete(`/recordings/${id}`);
      setRecordings(prev => prev.filter(r => r.id !== id));
      if (detail?.id === id) { setDetail(null); setSelectedId(null); }
    } catch { /* toast via interceptor */ }
  };

  const saveDetailEdits = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const { data } = await api.patch(`/recordings/${detail.id}`, {
        title: titleEdit,
        speaker_names: nameEdits,
      });
      setDetail(d => ({ ...d, ...data }));
      setRecordings(prev => prev.map(r => (r.id === data.id ? { ...r, ...data } : r)));
    } catch { /* toast via interceptor */ } finally {
      setSaving(false);
    }
  };

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText(detail));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  const downloadTranscript = () => {
    const blob = new Blob([transcriptText(detail)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(detail.title || 'transcript').replace(/[^\w\- ]+/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const seekTo = ms => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = ms / 1000;
    el.play().catch(() => {});
  };

  const loadMore = async () => {
    if (loadingMore || page >= pages) return;
    setLoadingMore(true);
    try {
      await loadList({ nextPage: page + 1, append: true, quiet: true });
    } finally {
      setLoadingMore(false);
    }
  };

  const uniqueSpeakers = detail
    ? [...new Set((detail.utterances || []).map(u => u.speaker))]
    : [];

  // ---------- detail view ----------
  if (selectedId) {
    return (
      <div>
        <button className="ops-button-secondary" onClick={() => { setSelectedId(null); setDetail(null); }} style={{ marginBottom: 14 }}>
          &larr; All recordings
        </button>

        {detailLoading && <div className="ops-loading-state">Loading transcript…</div>}

        {detail && !detailLoading && (
          <div style={styles.card}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={titleEdit}
                onChange={e => setTitleEdit(e.target.value)}
                placeholder="Recording title"
                style={styles.titleInput}
                aria-label="Recording title"
              />
              <StatusChip status={detail.status} />
            </div>
            <div style={styles.metaRow}>
              {fmtDate(detail.created_at)}
              {detail.duration_seconds ? ` · ${fmtDuration(detail.duration_seconds)}` : ''}
              {detail.uploader_name ? ` · ${detail.uploader_name}` : ''}
              {detail.language_code ? ` · ${detail.language_code.toUpperCase()}` : ''}
            </div>

            {detail.media_deleted_at ? (
              <div style={{ ...styles.notice, marginTop: 12 }}>
                The video file was removed after transcription to save storage — the transcript below is kept.
              </div>
            ) : (
              <audio ref={audioRef} controls src={detail.audio_url} style={{ width: '100%', marginTop: 12 }} preload="metadata" />
            )}

            {(detail.status === 'processing' || detail.status === 'uploaded') && (
              <div style={styles.notice}>Transcribing — this usually takes a few minutes for longer recordings. The page updates automatically.</div>
            )}

            {detail.status === 'failed' && (
              <div style={{ ...styles.notice, background: '#fee2e2', color: '#991b1b' }}>
                {detail.error_message || 'Transcription failed.'}
                <button className="ops-button-secondary" onClick={() => retry(detail.id)} style={{ marginLeft: 10 }}>Retry</button>
              </div>
            )}

            {detail.status === 'completed' && (
              <>
                {uniqueSpeakers.length > 0 && (
                  <div style={styles.speakerPanel}>
                    <div style={styles.panelHeading}>Speakers — set names so the transcript reads naturally</div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {uniqueSpeakers.map(sp => (
                        <label key={sp} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          <span style={{ ...styles.speakerDot, background: speakerColor(sp) }} aria-hidden="true" />
                          <span style={{ color: '#475569' }}>Speaker {sp}</span>
                          <input
                            value={nameEdits[sp] || ''}
                            onChange={e => setNameEdits(prev => ({ ...prev, [sp]: e.target.value }))}
                            placeholder={`Speaker ${sp}`}
                            maxLength={100}
                            style={styles.nameInput}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, margin: '14px 0', flexWrap: 'wrap' }}>
                  <button className="ops-button-primary" onClick={saveDetailEdits} disabled={saving}>
                    {saving ? 'Saving…' : 'Save names & title'}
                  </button>
                  <button className="ops-button-secondary" onClick={copyTranscript}>{copied ? 'Copied!' : 'Copy transcript'}</button>
                  <button className="ops-button-secondary" onClick={downloadTranscript}>Download .txt</button>
                  <button className="ops-button-secondary" onClick={() => remove(detail.id)} style={{ color: '#b91c1c' }}>Delete</button>
                </div>

                <div>
                  {(detail.utterances || []).map((u, i) => {
                    const name = (nameEdits[u.speaker] || '').trim() || `Speaker ${u.speaker}`;
                    return (
                      <div key={i} style={styles.utterance}>
                        <button
                          onClick={() => seekTo(u.start_ms)}
                          title="Jump to this moment"
                          style={styles.timestampBtn}
                        >
                          {fmtClock(u.start_ms)}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: speakerColor(u.speaker), fontWeight: 700, fontSize: 13 }}>{name}</span>
                          <div style={{ color: '#1e293b', fontSize: 14, lineHeight: 1.55 }}>{u.text}</div>
                        </div>
                      </div>
                    );
                  })}
                  {(detail.utterances || []).length === 0 && (
                    <div style={{ color: '#64748b', fontSize: 14 }}>No speech was detected in this recording.</div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---------- list view ----------
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,video/3gpp,.m4a,.mp3,.wav,.aac,.ogg,.flac,.mov,.mkv,.avi,.3gp"
          onChange={handleFile}
          style={{ display: 'none' }}
        />
        <button
          className="ops-button-primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadProgress !== null}
        >
          {uploadProgress !== null ? `Uploading… ${uploadProgress}%` : 'Upload audio or video'}
        </button>
        <span style={{ color: '#64748b', fontSize: 13 }}>
          Meeting, call, or video recordings (mp3, m4a, wav, mp4, mov…). You'll get a transcript that shows
          who said what. Video files are deleted after transcription, so they don't use your storage.
        </span>
      </div>

      {uploadError && <div style={{ ...styles.notice, background: '#fee2e2', color: '#991b1b', marginBottom: 12 }}>{uploadError}</div>}

      {loading && <div className="ops-loading-state">Loading recordings…</div>}

      {!loading && recordings.length === 0 && (
        <div style={styles.card}>
          <div style={{ color: '#475569', fontSize: 14, lineHeight: 1.6 }}>
            No recordings yet. Upload a meeting, phone-call, or video recording and it comes back as a
            speaker-by-speaker transcript — rename "Speaker A/B" to real names, jump the audio to
            any line, and copy or download the text.
          </div>
        </div>
      )}

      {!loading && recordings.map(r => (
        <div key={r.id} style={styles.listRow}>
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => openDetail(r.id)}>
            <div style={{ fontWeight: 600, color: '#0f172a', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.title || 'Untitled recording'}
            </div>
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
              {fmtDate(r.created_at)}
              {r.duration_seconds ? ` · ${fmtDuration(r.duration_seconds)}` : ''}
              {r.uploader_name ? ` · ${r.uploader_name}` : ''}
              {r.project_name ? ` · ${r.project_name}` : ''}
            </div>
          </div>
          <StatusChip status={r.status} />
          {r.status === 'failed' && (
            <button className="ops-button-secondary" onClick={() => retry(r.id)}>Retry</button>
          )}
          <button className="ops-button-secondary" onClick={() => openDetail(r.id)}>Open</button>
          <button
            className="ops-button-secondary"
            onClick={() => remove(r.id)}
            aria-label="Delete recording"
            style={{ color: '#b91c1c' }}
          >
            Delete
          </button>
        </div>
      ))}

      {!loading && total > 0 && (
        <div style={styles.paginationRow}>
          <span>Showing {recordings.length} of {total}</span>
          {page < pages && (
            <button className="ops-button-secondary" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  card: {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: 18,
    boxShadow: 'var(--ops-shadow-sm)',
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: '12px 14px',
    marginBottom: 8,
  },
  titleInput: {
    flex: 1,
    minWidth: 220,
    fontSize: 17,
    fontWeight: 600,
    color: '#0f172a',
    border: '1px solid transparent',
    borderRadius: 6,
    padding: '4px 8px',
    background: 'transparent',
  },
  metaRow: { color: '#64748b', fontSize: 13, marginTop: 4 },
  notice: {
    background: '#eff6ff',
    color: '#1e40af',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
    marginTop: 12,
  },
  speakerPanel: {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: 12,
    marginTop: 14,
  },
  panelHeading: { fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 8 },
  speakerDot: { width: 10, height: 10, borderRadius: 999, display: 'inline-block' },
  nameInput: {
    border: '1px solid #cbd5e1',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 13,
    width: 140,
  },
  utterance: {
    display: 'flex',
    gap: 12,
    padding: '10px 0',
    borderTop: '1px solid #f1f5f9',
  },
  timestampBtn: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    padding: 0,
    marginTop: 2,
    whiteSpace: 'nowrap',
  },
  paginationRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    color: '#64748b',
    fontSize: 13,
    flexWrap: 'wrap',
  },
};
