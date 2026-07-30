import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useT } from '../../hooks/useT';
import { useModalA11y } from '../../hooks/useModalA11y';
import { escapeHtml } from '../../utils/html';

// QR payload: {"app":"opsfloa","asset":true,"id":42,"name":"Compactor","unit":"CMP-3"}
// Stick the printed tag on the tool; scanning it identifies the asset.
export function buildAssetQRPayload(asset) {
  return JSON.stringify({ app: 'opsfloa', asset: true, id: asset.id, name: asset.name, unit: asset.unit_number || null });
}

export function parseAssetQR(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.app === 'opsfloa' && parsed.asset === true && parsed.id != null) return parsed;
  } catch {}
  return null;
}

export default function AssetLabelModal({ asset, onClose }) {
  const t = useT();
  const [qrDataUrl, setQrDataUrl] = useState('');
  const modalRef = useModalA11y(onClose);

  useEffect(() => {
    QRCode.toDataURL(buildAssetQRPayload(asset), { width: 220, margin: 1, errorCorrectionLevel: 'M' })
      .then(setQrDataUrl).catch(console.error);
  }, [asset.id, asset.name, asset.unit_number]);

  const printLabel = () => {
    if (!qrDataUrl) return;
    const win = window.open('', '_blank', 'width=380,height=480');
    if (!win) return;
    const safe = escapeHtml;
    win.document.write(`<!DOCTYPE html><html><head>
      <title>${safe(t.eqLabelType)}: ${safe(asset.name)}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; display: flex; align-items: center;
               justify-content: center; min-height: 100vh; background: #fff; }
        .label { text-align: center; padding: 24px; border: 2px solid #374151;
                 border-radius: 12px; max-width: 320px; width: 100%; }
        .type  { font-size: 11px; font-weight: 700; color: #9ca3af; letter-spacing: .08em;
                 text-transform: uppercase; margin-bottom: 6px; }
        .name  { font-size: 22px; font-weight: 800; color: #111827; margin-bottom: 4px; }
        .unit  { font-size: 13px; color: #6b7280; font-family: monospace; margin-bottom: 4px; }
        .qr    { margin: 16px auto; display: block; width: 180px; height: 180px; }
        .footer{ font-size: 10px; color: #9ca3af; margin-top: 8px; }
        @media print { body { min-height: unset; } .label { border: 1px solid #374151; } }
      </style>
    </head><body>
      <div class="label">
        <div class="type">${safe(t.eqLabelType)}</div>
        <div class="name">${safe(asset.name)}</div>
        ${asset.unit_number ? `<div class="unit">${safe(asset.unit_number)}</div>` : ''}
        <img class="qr" src="${safe(qrDataUrl)}" alt="QR Code" />
        <div class="footer">OpsFloa ${safe(t.eqLabelType)} · ID ${safe(asset.id)}</div>
      </div>
      <script>window.onload = () => { window.print(); }<\/script>
    </body></html>`);
    win.document.close();
  };

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="asset-label-title" style={s.modal}>
        <div style={s.header}>
          <h3 id="asset-label-title" style={s.title}>{t.eqLabelTitle}</h3>
          <button style={s.closeBtn} aria-label={t.labelModalClose} onClick={onClose}>✕</button>
        </div>
        <div style={s.preview}>
          <div style={s.previewType}>{t.eqLabelType}</div>
          <div style={s.previewName}>{asset.name}</div>
          {asset.unit_number && <div style={s.previewSku}>{asset.unit_number}</div>}
          {qrDataUrl
            ? <img src={qrDataUrl} alt="QR Code" style={s.qr} />
            : <div style={s.qrPlaceholder}>{t.labelModalGenerating}</div>}
          <div style={s.previewFooter}>OpsFloa {t.eqLabelType} · ID {asset.id}</div>
        </div>
        <p style={s.hint}>{t.eqLabelHint} <strong>{asset.name}</strong>.</p>
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
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 16 },
  modal: { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 16, fontWeight: 700, color: '#111827' },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 0 },
  preview: { border: '2px solid #374151', borderRadius: 10, padding: '20px 16px', textAlign: 'center', marginBottom: 16, background: '#fff' },
  previewType: { fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 },
  previewName: { fontSize: 22, fontWeight: 800, color: '#111827', marginBottom: 2 },
  previewSku: { fontSize: 13, color: '#6b7280', fontFamily: 'monospace', marginBottom: 2 },
  qr: { width: 160, height: 160, margin: '12px auto', display: 'block' },
  qrPlaceholder: { width: 160, height: 160, margin: '12px auto', background: '#f3f4f6', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#6b7280' },
  previewFooter: { fontSize: 10, color: '#6b7280', marginTop: 6 },
  hint: { fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.5 },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  printBtn: { padding: '9px 20px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};
