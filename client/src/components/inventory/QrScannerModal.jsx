import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useModalA11y } from '../../hooks/useModalA11y';

// Native QR scanning where available (Android/desktop Chrome). iOS Safari and
// browsers without BarcodeDetector fall back to a text field a keyboard-wedge
// scanner types into (matching the inventory count-scan convention).
const hasBarcodeDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;

export default function QrScannerModal({ onDetect, onClose, title }) {
  const t = useT();
  const modalRef = useModalA11y(onClose);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const doneRef = useRef(false);
  const [manual, setManual] = useState(!hasBarcodeDetector);
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');

  useEffect(() => {
    if (manual) return undefined;
    let cancelled = false;
    let detector;
    try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); }
    catch { setManual(true); return undefined; }

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach(tr => tr.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (doneRef.current || cancelled) return;
          try {
            const codes = await detector.detect(v);
            const raw = codes && codes[0] && codes[0].rawValue;
            if (raw) { doneRef.current = true; onDetect(raw); return; }
          } catch { /* transient decode error — keep scanning */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setStatus(t.eqScanNoCamera);
        setManual(true);
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(tr => tr.stop());
    };
  }, [manual]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitManual = e => { e.preventDefault(); if (text.trim()) onDetect(text.trim()); };

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-label={title || t.eqScanTitle} style={s.modal}>
        <div style={s.header}>
          <h3 style={s.title}>{title || t.eqScanTitle}</h3>
          <button style={s.closeBtn} onClick={onClose} aria-label={t.labelModalClose}>✕</button>
        </div>
        {!manual ? (
          <>
            <div style={s.videoWrap}>
              <video ref={videoRef} style={s.video} muted playsInline />
              <div style={s.reticle} />
            </div>
            <p style={s.hint}>{t.eqScanHint}</p>
            <button type="button" style={s.linkBtn} onClick={() => setManual(true)}>{t.eqScanTypeInstead}</button>
          </>
        ) : (
          <form onSubmit={submitManual}>
            <p style={s.hint}>{status || t.eqScanManualHint}</p>
            <input style={s.input} autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={t.eqScanPlaceholder} />
            <div style={s.actions}>
              <button type="button" style={s.cancelBtn} onClick={onClose}>{t.cancel}</button>
              <button type="submit" style={s.okBtn}>{t.eqScanFind}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 16 },
  modal: { background: '#fff', borderRadius: 14, padding: 20, maxWidth: 380, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: 700, color: '#111827' },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0 },
  videoWrap: { position: 'relative', width: '100%', aspectRatio: '1 / 1', background: '#000', borderRadius: 10, overflow: 'hidden' },
  video: { width: '100%', height: '100%', objectFit: 'cover' },
  reticle: { position: 'absolute', inset: '18%', border: '3px solid rgba(255,255,255,0.85)', borderRadius: 12, boxShadow: '0 0 0 100vmax rgba(0,0,0,0.15)' },
  hint: { fontSize: 13, color: '#6b7280', margin: '12px 0', lineHeight: 1.5, textAlign: 'center' },
  linkBtn: { display: 'block', margin: '0 auto', background: 'none', border: 'none', color: 'var(--ops-page-accent, #2563eb)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  input: { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 15, fontFamily: 'monospace' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  cancelBtn: { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  okBtn: { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};
