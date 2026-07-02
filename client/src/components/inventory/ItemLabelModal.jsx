import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useT } from '../../hooks/useT';
import { useModalA11y } from '../../hooks/useModalA11y';

// QR payload format: {"app":"opsfloa","item":true,"id":42,"sku":"SKU123","name":"2x4 Lumber"}
// Scanned by the Count tab to auto-jump to that item in the count list.

export function buildItemQRPayload(item) {
  return JSON.stringify({ app: 'opsfloa', item: true, id: item.id, sku: item.sku || null, name: item.name });
}

export function parseItemQR(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.app === 'opsfloa' && parsed.item === true && parsed.id != null) return parsed;
  } catch {}
  return null;
}

export default function ItemLabelModal({ item, onClose }) {
  const t = useT();
  const [qrDataUrl, setQrDataUrl] = useState('');
  const modalRef = useModalA11y(onClose);

  useEffect(() => {
    const payload = buildItemQRPayload(item);
    QRCode.toDataURL(payload, { width: 220, margin: 1, errorCorrectionLevel: 'M' })
      .then(setQrDataUrl)
      .catch(console.error);
  }, [item.id, item.sku, item.name]);

  const printLabel = () => {
    if (!qrDataUrl) return;
    const win = window.open('', '_blank', 'width=380,height=480');
    win.document.write(`<!DOCTYPE html><html><head>
      <title>${t.invilItem}: ${item.name}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; display: flex; align-items: center;
               justify-content: center; min-height: 100vh; background: #fff; }
        .label { text-align: center; padding: 24px; border: 2px solid #374151;
                 border-radius: 12px; max-width: 320px; width: 100%; }
        .type  { font-size: 11px; font-weight: 700; color: #9ca3af; letter-spacing: .08em;
                 text-transform: uppercase; margin-bottom: 6px; }
        .name  { font-size: 22px; font-weight: 800; color: #111827; margin-bottom: 4px; }
        .sku   { font-size: 13px; color: #6b7280; font-family: monospace; margin-bottom: 4px; }
        .qr    { margin: 16px auto; display: block; width: 180px; height: 180px; }
        .footer{ font-size: 10px; color: #9ca3af; margin-top: 8px; }
        @media print {
          body { min-height: unset; }
          .label { border: 1px solid #374151; }
        }
      </style>
    </head><body>
      <div class="label">
        <div class="type">${t.invilItemType}</div>
        <div class="name">${item.name}</div>
        ${item.sku ? `<div class="sku">${item.sku}</div>` : ''}
        <img class="qr" src="${qrDataUrl}" alt="QR Code" />
        <div class="footer">OpsFloa ${t.invilInventory} · ID ${item.id}</div>
      </div>
      <script>window.onload = () => { window.print(); }<\/script>
    </body></html>`);
    win.document.close();
  };

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="item-label-title" style={s.modal}>
        <div style={s.header}>
          <h3 id="item-label-title" style={s.title}>{t.itemLabelTitle}</h3>
          <button style={s.closeBtn} aria-label={t.labelModalClose} onClick={onClose}>✕</button>
        </div>

        <div style={s.preview}>
          <div style={s.previewType}>{t.invilItemType}</div>
          <div style={s.previewName}>{item.name}</div>
          {item.sku && <div style={s.previewSku}>{item.sku}</div>}
          {qrDataUrl
            ? <img src={qrDataUrl} alt="QR Code" style={s.qr} />
            : <div style={s.qrPlaceholder}>{t.labelModalGenerating}</div>
          }
          <div style={s.previewFooter}>OpsFloa {t.invilInventory} · ID {item.id}</div>
        </div>

        <p style={s.hint}>
          {t.itemLabelHint} <strong>{item.name}</strong>.
        </p>

        <div style={s.actions}>
          <button style={s.cancelBtn} onClick={onClose}>{t.labelModalClose}</button>
          <button style={{ ...s.printBtn, ...(!qrDataUrl ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={printLabel} disabled={!qrDataUrl}>
            {t.labelModalPrint}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  overlay:       { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex',
                   alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 16 },
  modal:         { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 360, width: '100%',
                   boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  header:        { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title:         { fontSize: 16, fontWeight: 700, color: '#111827' },
  closeBtn:      { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0 },
  preview:       { border: '2px solid #374151', borderRadius: 10, padding: '20px 16px',
                   textAlign: 'center', marginBottom: 16, background: '#fff' },
  previewType:   { fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: '0.08em',
                   textTransform: 'uppercase', marginBottom: 4 },
  previewName:   { fontSize: 22, fontWeight: 800, color: '#111827', marginBottom: 2 },
  previewSku:    { fontSize: 13, color: '#6b7280', fontFamily: 'monospace', marginBottom: 2 },
  qr:            { width: 160, height: 160, margin: '12px auto', display: 'block' },
  qrPlaceholder: { width: 160, height: 160, margin: '12px auto', background: '#f3f4f6',
                   borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                   fontSize: 13, color: '#6b7280' },
  previewFooter: { fontSize: 10, color: '#6b7280', marginTop: 6 },
  hint:          { fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.5 },
  actions:       { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn:     { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff',
                   fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  printBtn:      { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#92400e',
                   color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};
