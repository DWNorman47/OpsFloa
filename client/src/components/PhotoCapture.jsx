import React, { useRef, useState } from 'react';
import { useT } from '../hooks/useT';

// Compress an image file to a JPEG data URL, max 1200px wide, quality 0.75
function compressImage(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1200;
      let { width, height } = img;
      if (width > MAX) { height = Math.round((height * MAX) / width); width = MAX; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve({ url: canvas.toDataURL('image/jpeg', 0.75), caption: '' });
    };
    img.src = url;
  });
}

export default function PhotoCapture({ photos, onChange, maxPhotos = 10 }) {
  const t = useT();
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [compressing, setCompressing] = useState(false);

  const handleFiles = async files => {
    const arr = Array.from(files).slice(0, maxPhotos - photos.length);
    if (!arr.length) return;
    setCompressing(true);
    const compressed = await Promise.all(arr.map(compressImage));
    onChange([...photos, ...compressed]);
    setCompressing(false);
  };

  const updateCaption = (i, caption) => {
    const next = photos.map((p, idx) => idx === i ? { ...p, caption } : p);
    onChange(next);
  };

  const remove = i => onChange(photos.filter((_, idx) => idx !== i));

  return (
    <div style={styles.wrap}>
      <div style={styles.photoGrid}>
        {photos.map((p, i) => (
          <div key={i} style={styles.photoCard}>
            <div style={styles.photoImgWrap}>
              <img src={p.url} alt={`photo ${i + 1}`} style={styles.photoImg} loading="lazy" />
              <button style={styles.removeBtn} onClick={() => remove(i)} aria-label={t.removePhoto}>✕</button>
            </div>
            <input
              name={`photo_caption_${i}`}
              style={styles.captionInput}
              type="text"
              placeholder={t.captionOptional}
              value={p.caption}
              onChange={e => updateCaption(i, e.target.value)}
              maxLength={500}
            />
          </div>
        ))}

        {photos.length < maxPhotos && (
          <div style={styles.addCard}>
            {compressing ? (
              <span style={styles.compressingText}>{t.photoProcessing}</span>
            ) : (
              <>
                <button style={styles.addBtn} onClick={() => cameraRef.current.click()} aria-label={t.takePhoto}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span style={styles.addLabel}>{t.photoCamera}</span>
                </button>
                <button style={styles.addBtn} onClick={() => fileRef.current.click()} aria-label={t.uploadPhoto}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span style={styles.addLabel}>{t.photoUpload}</span>
                </button>
              </>
            )}
            {/* Camera input — opens native camera on mobile */}
            <input ref={cameraRef} name="photo_camera_capture" type="file" accept="image/*" capture="environment"
              style={{ display: 'none' }} onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
            {/* File picker — opens gallery */}
            <input ref={fileRef} name="photo_file_upload" type="file" accept="image/*" multiple
              style={{ display: 'none' }} onChange={e => { handleFiles(e.target.files); e.target.value = ''; }} />
          </div>
        )}
      </div>
      {photos.length > 0 && (
        <p style={styles.hint}>{photos.length} photo{photos.length !== 1 ? 's' : ''} · tap a photo to add a caption</p>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  photoGrid: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  photoCard: { display: 'flex', flexDirection: 'column', gap: 4, width: 120 },
  photoImgWrap: { position: 'relative', width: 120, height: 90, borderRadius: 8, overflow: 'hidden', background: '#f3f4f6' },
  photoImg: { width: '100%', height: '100%', objectFit: 'cover' },
  removeBtn: {
    position: 'absolute', top: 3, right: 3, width: 20, height: 20,
    background: 'rgba(0,0,0,0.55)', color: '#fff', border: 'none', borderRadius: '50%',
    fontSize: 11, lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  captionInput: { fontSize: 11, padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 5, color: '#374151' },
  addCard: {
    width: 120, height: 90, borderRadius: 8, border: '2px dashed #d1d5db',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, background: '#fafafa',
  },
  addBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
    background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4,
  },
  addLabel: { fontSize: 10, fontWeight: 600 },
  compressingText: { fontSize: 12, color: '#6b7280' },
  hint: { fontSize: 11, color: '#6b7280', margin: 0 },
};
