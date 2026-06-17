/**
 * ImportItemsModal — bulk import of inventory items from an Excel/CSV file.
 *
 * Flow: Download template → Upload file → Preview grid with errors highlighted
 * → Confirm. Parsing happens client-side via SheetJS, so the server only sees
 * a clean JSON payload.
 */

import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import api from '../../api';
import ModalShell from '../ModalShell';
import { useT } from '../../hooks/useT';

const TEMPLATE_COLUMNS = [
  'name', 'sku', 'description', 'category',
  'unit', 'unit_spec', 'unit_cost', 'reorder_point', 'reorder_qty',
];

const TEMPLATE_SAMPLE = [
  {
    name: 'Disposable Gloves',
    sku: 'SUP-GLV-M',
    description: 'Medium nitrile gloves',
    category: 'Supplies',
    unit: 'each',
    unit_spec: '',
    unit_cost: 4.25,
    reorder_point: 50,
    reorder_qty: 200,
  },
  {
    name: 'Printer Paper',
    sku: 'OFF-PAPER-LTR',
    description: 'Letter size copy paper',
    category: 'Office',
    unit: 'box',
    unit_spec: '1 lb',
    unit_cost: 8.5,
    reorder_point: 10,
    reorder_qty: 40,
  },
];

function downloadTemplate() {
  const ws = XLSX.utils.json_to_sheet(TEMPLATE_SAMPLE, { header: TEMPLATE_COLUMNS });
  ws['!cols'] = TEMPLATE_COLUMNS.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Items');
  XLSX.writeFile(wb, 'inventory-items-template.xlsx');
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

const HEADER_ALIASES = {
  name:          'name',
  item:          'name',
  item_name:     'name',
  sku:           'sku',
  part_number:   'sku',
  description:   'description',
  desc:          'description',
  category:      'category',
  unit:          'unit',
  uom:           'unit',
  unit_spec:     'unit_spec',
  spec:          'unit_spec',
  unit_cost:     'unit_cost',
  cost:          'unit_cost',
  price:         'unit_cost',
  reorder_point: 'reorder_point',
  reorder_at:    'reorder_point',
  min:           'reorder_point',
  minimum:       'reorder_point',
  reorder_qty:   'reorder_qty',
  reorder_quantity: 'reorder_qty',
  reorder:       'reorder_qty',
};

function parseWorkbookToRows(wb) {
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return raw.map(r => {
    const out = {};
    Object.entries(r).forEach(([k, v]) => {
      const norm = normalizeHeader(k);
      const target = HEADER_ALIASES[norm];
      if (target) out[target] = v;
    });
    return out;
  }).filter(r => Object.values(r).some(v => String(v).trim() !== ''));
}

function validateRow(row) {
  const errs = [];
  if (!String(row.name || '').trim()) errs.push('name');
  if (String(row.name || '').trim().length > 255) errs.push('name>255');
  if (String(row.sku || '').trim().length > 100) errs.push('sku>100');
  if (String(row.description || '').trim().length > 1000) errs.push('description>1000');
  if (String(row.category || '').trim().length > 100) errs.push('category>100');
  if (row.unit_cost !== '' && row.unit_cost != null && isNaN(parseFloat(row.unit_cost))) errs.push('unit_cost');
  return errs;
}

export default function ImportItemsModal({ onClose, onDone }) {
  const t = useT();
  const fileRef = useRef(null);
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleFile = async f => {
    setError('');
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const parsed = parseWorkbookToRows(wb);
      if (parsed.length === 0) {
        setError(t.invImportNoRows || 'No data rows found. Check the file has a header row matching the template.');
        setRows(null); return;
      }
      if (parsed.length > 1000) {
        setError((t.invImportTooMany || 'Too many rows — import at most 1000 at a time.'));
        setRows(null); return;
      }
      setRows(parsed);
      setFileName(f.name);
    } catch (e) {
      setError(t.invImportParseFailed || 'Failed to parse file. Upload .xlsx or .csv.');
      setRows(null);
    }
  };

  const submit = async () => {
    if (!rows) return;
    setSubmitting(true);
    setError('');
    try {
      const r = await api.post('/inventory/items/bulk', { items: rows, update_existing: updateExisting });
      setResult(r.data);
    } catch (e) {
      setError(e.response?.data?.error || t.invImportFailed || 'Import failed');
    } finally {
      setSubmitting(false);
    }
  };

  const finish = () => { onDone(); onClose(); };

  const validRows = rows ? rows.map(validateRow) : [];
  const totalErrors = validRows.filter(e => e.length > 0).length;

  return (
    <div style={s.overlay} onClick={onClose}>
      <ModalShell onClose={onClose} titleId="imp-title" className="inventory-import-modal" style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <div id="imp-title" style={s.title}>{t.invImportTitle || 'Import Items'}</div>
          <button style={s.close} aria-label={t.labelModalClose || 'Close'} onClick={onClose}>✕</button>
        </div>

        {!result && (
          <div className="inventory-import-body" style={s.body}>
            {error && <div role="alert" style={s.error}>{error}</div>}

            {!rows && (
              <>
                <p style={s.intro}>
                  {t.invImportIntro || 'Upload an Excel (.xlsx) or CSV file with columns matching the template. Name is required; other columns are optional.'}
                </p>
                <button type="button" style={s.linkBtn} onClick={downloadTemplate}>
                  {t.invImportDownloadTemplate || 'Download template'}
                </button>
                <div className="inventory-import-dropzone" style={s.dropzone} onClick={() => fileRef.current?.click()}>
                  <div style={s.dropIcon}>📄</div>
                  <div style={s.dropText}>{t.invImportChooseFile || 'Click to choose a file'}</div>
                  <div style={s.dropHint}>.xlsx or .csv</div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={e => handleFile(e.target.files?.[0])}
                    style={{ display: 'none' }}
                  />
                </div>
              </>
            )}

            {rows && (
              <>
                <div className="inventory-import-preview-header" style={s.previewHeader}>
                  <div>
                    <div style={s.fileName}>{fileName}</div>
                    <div style={s.rowCount}>
                      {rows.length} {rows.length === 1 ? (t.invImportRowSingular || 'row') : (t.invImportRowPlural || 'rows')}
                      {totalErrors > 0 && (
                        <span style={s.errorCount}>
                          {' • '}
                          {totalErrors} {t.invImportWithErrors || 'with errors'}
                        </span>
                      )}
                    </div>
                  </div>
                  <button type="button" style={s.linkBtn} onClick={() => { setRows(null); setFileName(''); }}>
                    {t.invImportChangeFile || 'Change file'}
                  </button>
                </div>

                <div style={s.tableWrap}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>#</th>
                        {TEMPLATE_COLUMNS.map(c => <th key={c} style={s.th}>{c}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const errs = validRows[i];
                        return (
                          <tr key={i} style={errs.length > 0 ? s.rowError : (i % 2 === 0 ? s.rowEven : s.row)}>
                            <td style={s.tdNum}>{i + 1}</td>
                            {TEMPLATE_COLUMNS.map(c => {
                              const isErr = errs.includes(c) || (c === 'name' && errs.includes('name'));
                              return <td key={c} style={isErr ? s.tdError : s.td}>{String(r[c] ?? '')}</td>;
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <label style={s.checkRow}>
                  <input
                    type="checkbox"
                    checked={updateExisting}
                    onChange={e => setUpdateExisting(e.target.checked)}
                  />
                  <span>
                    <strong>{t.invImportUpdateExisting || 'Update existing items by SKU'}</strong>
                    <div style={s.checkHint}>
                      {t.invImportUpdateExistingHint || "When checked, rows whose SKU matches an existing item will overwrite it. Otherwise duplicates are skipped."}
                    </div>
                  </span>
                </label>

                <div className="inventory-import-actions" style={s.actions}>
                  <button type="button" style={s.cancel} onClick={onClose} disabled={submitting}>
                    {t.cancel || 'Cancel'}
                  </button>
                  <button type="button" style={s.primary} onClick={submit} disabled={submitting || totalErrors === rows.length}>
                    {submitting
                      ? (t.invImportImporting || 'Importing…')
                      : `${t.invImportAction || 'Import'} ${rows.length - totalErrors}`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {result && (
          <div className="inventory-import-body" style={s.body}>
            <div style={s.successIcon}>✓</div>
            <div style={s.resultTitle}>{t.invImportDone || 'Import complete'}</div>
            <div className="inventory-import-result-stats" style={s.resultStats}>
              <div style={s.stat}>
                <div style={s.statNum}>{result.imported.length}</div>
                <div style={s.statLabel}>{t.invImportAddedLabel || 'added'}</div>
              </div>
              <div style={s.stat}>
                <div style={s.statNum}>{result.updated.length}</div>
                <div style={s.statLabel}>{t.invImportUpdatedLabel || 'updated'}</div>
              </div>
              <div style={{ ...s.stat, ...(result.skipped.length > 0 ? s.statSkipped : {}) }}>
                <div style={s.statNum}>{result.skipped.length}</div>
                <div style={s.statLabel}>{t.invImportSkippedLabel || 'skipped'}</div>
              </div>
            </div>

            {result.skipped.length > 0 && (
              <div style={s.skippedBlock}>
                <div style={s.skippedHeader}>{t.invImportSkippedHeader || 'Skipped rows'}</div>
                <div style={s.skippedList}>
                  {result.skipped.map((r, i) => (
                    <div key={i} className="inventory-import-skipped-row" style={s.skippedRow}>
                      <span style={s.skippedNum}>#{r.row}</span>
                      <span style={s.skippedName}>{r.name || '(no name)'}</span>
                      <span style={s.skippedReason}>{r.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="inventory-import-actions" style={s.actions}>
              <button type="button" style={s.primary} onClick={finish}>{t.done || 'Done'}</button>
            </div>
          </div>
        )}
      </ModalShell>
    </div>
  );
}

const s = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 },
  modal:   { background: '#fff', borderRadius: 12, maxWidth: 860, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' },
  title:   { fontSize: 17, fontWeight: 700, color: '#111827' },
  close:   { background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: 4 },
  body:    { padding: 20, overflow: 'auto' },
  intro:   { fontSize: 14, color: '#4b5563', lineHeight: 1.5, marginTop: 0 },
  linkBtn: { background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: 0, marginBottom: 16 },
  dropzone: { border: '2px dashed #d1d5db', borderRadius: 10, padding: 40, textAlign: 'center', cursor: 'pointer', background: '#f9fafb' },
  dropIcon: { display: 'none' },
  dropText: { fontSize: 15, fontWeight: 600, color: '#111827', marginBottom: 4 },
  dropHint: { fontSize: 12, color: '#6b7280' },
  error:   { background: '#fee2e2', color: '#991b1b', padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 12 },

  previewHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 12 },
  fileName: { fontSize: 14, fontWeight: 700, color: '#111827' },
  rowCount: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  errorCount: { color: '#b91c1c', fontWeight: 600 },
  tableWrap: { border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'auto', maxHeight: 280, marginBottom: 16 },
  table:    { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:       { textAlign: 'left', padding: '6px 8px', background: '#f3f4f6', fontWeight: 700, color: '#374151', position: 'sticky', top: 0, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' },
  td:       { padding: '5px 8px', borderBottom: '1px solid #f3f4f6', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' },
  tdError:  { padding: '5px 8px', borderBottom: '1px solid #f3f4f6', background: '#fee2e2', color: '#991b1b', whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' },
  tdNum:    { padding: '5px 8px', borderBottom: '1px solid #f3f4f6', color: '#9ca3af', fontVariantNumeric: 'tabular-nums' },
  row:      { background: '#fff' },
  rowEven:  { background: '#fafafa' },
  rowError: { background: '#fef2f2' },

  checkRow:    { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', fontSize: 13, color: '#374151', cursor: 'pointer' },
  checkHint:   { fontSize: 12, color: '#6b7280', marginTop: 2 },

  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 16, marginTop: 8, borderTop: '1px solid #e5e7eb' },
  cancel:  { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 16px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  primary: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },

  successIcon: { display: 'none' },
  resultTitle: { fontSize: 16, fontWeight: 700, textAlign: 'center', color: '#111827', marginBottom: 16 },
  resultStats: { display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 18 },
  stat:        { flex: 1, textAlign: 'center', background: '#f0fdf4', borderRadius: 10, padding: '14px 8px', border: '1px solid #d1fae5' },
  statSkipped: { background: '#fef3c7', borderColor: '#fde68a' },
  statNum:     { fontSize: 24, fontWeight: 800, color: '#111827' },
  statLabel:   { fontSize: 12, color: '#6b7280', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },

  skippedBlock:  { border: '1px solid #fde68a', borderRadius: 8, background: '#fffbeb', padding: 12, marginBottom: 12 },
  skippedHeader: { fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 8 },
  skippedList:   { maxHeight: 180, overflow: 'auto' },
  skippedRow:    { display: 'flex', gap: 10, padding: '4px 0', fontSize: 12, borderBottom: '1px solid #fef3c7' },
  skippedNum:    { color: '#9ca3af', fontVariantNumeric: 'tabular-nums', minWidth: 32 },
  skippedName:   { flex: 1, color: '#111827', fontWeight: 600 },
  skippedReason: { color: '#b45309' },
};
