import React, { useRef, useState, useEffect } from 'react';
import { useT } from '../hooks/useT';
import { useModalA11y } from '../hooks/useModalA11y';

export default function SignatureModal({ onConfirm, onCancel, required = false }) {
  const t = useT();
  const canvasRef = useRef(null);
  const modalRef = useModalA11y(onCancel);
  const [drawing, setDrawing] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const getPos = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  };

  const startDraw = e => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const pos = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setDrawing(true);
  };

  const draw = e => {
    e.preventDefault();
    if (!drawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const pos = getPos(e, canvas);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    setIsEmpty(false);
  };

  const stopDraw = e => {
    e.preventDefault();
    setDrawing(false);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setIsEmpty(true);
  };

  const confirm = () => {
    onConfirm(canvasRef.current.toDataURL('image/png'));
  };

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="signature-modal-title" style={styles.modal}>
        <h3 id="signature-modal-title" style={styles.title}>{t.signInvoice}</h3>
        <p style={styles.hint}>{t.signatureHint}</p>
        <div style={styles.canvasWrap}>
          <canvas
            ref={canvasRef}
            width={480}
            height={160}
            style={styles.canvas}
            onMouseDown={startDraw}
            onMouseMove={draw}
            onMouseUp={stopDraw}
            onMouseLeave={stopDraw}
            onTouchStart={startDraw}
            onTouchMove={draw}
            onTouchEnd={stopDraw}
          />
          <button style={styles.clearBtn} onClick={clear}>{t.clear}</button>
        </div>
        <div style={styles.actions}>
          <button style={{ ...styles.confirmBtn, ...(isEmpty ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={confirm} disabled={isEmpty}>
            {t.signAndExport}
          </button>
          {!required && (
            <button style={styles.skipBtn} onClick={() => onConfirm(null)}>
              {t.exportWithoutSignature}
            </button>
          )}
          <button style={styles.cancelBtn} onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 540, width: '100%', boxShadow: '0 8px 40px rgba(0,0,0,0.18)' },
  title: { fontSize: 18, fontWeight: 700, margin: '0 0 6px' },
  hint: { fontSize: 13, color: '#6b7280', margin: '0 0 16px' },
  canvasWrap: { position: 'relative', border: '1px solid #d1d5db', borderRadius: 8, background: '#fafafa', overflow: 'hidden' },
  canvas: { display: 'block', width: '100%', height: 160, cursor: 'crosshair', touchAction: 'none' },
  clearBtn: { position: 'absolute', top: 8, right: 8, background: 'none', border: '1px solid #d1d5db', color: '#6b7280', padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  actions: { display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' },
  confirmBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  skipBtn: { background: 'none', border: '1px solid #d1d5db', color: '#374151', padding: '9px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: 'none', color: '#6b7280', padding: '9px 8px', fontSize: 13, cursor: 'pointer', marginLeft: 'auto' },
};
