import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import BinLabelModal from './BinLabelModal';
import { useT } from '../../hooks/useT';
import { SkeletonList } from '../Skeleton';

import { silentError } from '../../errorReporter';
function isHttpUrl(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

// ── Level config ──────────────────────────────────────────────────────────────
// Each level knows its API path, its parent's key name, and which parent level feeds it.

const LEVELS = [
  {
    key: 'locations',
    label: 'Locations',
    apiPath: '/inventory/locations',
    parentKey: null,
    parentLevel: null,
    parentLabel: null,
    typeOptions: ['warehouse', 'job_site', 'truck', 'other'],
  },
  {
    key: 'areas',
    label: 'Areas',
    apiPath: '/inventory/setup/areas',
    parentKey: 'location_id',
    parentLevel: 'locations',
    parentLabel: 'Location',
  },
  {
    key: 'racks',
    label: 'Racks',
    apiPath: '/inventory/setup/racks',
    parentKey: 'area_id',
    parentLevel: 'areas',
    parentLabel: 'Area',
  },
  {
    key: 'bays',
    label: 'Bays',
    apiPath: '/inventory/setup/bays',
    parentKey: 'rack_id',
    parentLevel: 'racks',
    parentLabel: 'Rack',
  },
  {
    key: 'compartments',
    label: 'Compartments',
    apiPath: '/inventory/setup/compartments',
    parentKey: 'bay_id',
    parentLevel: 'bays',
    parentLabel: 'Bay',
  },
];

// ── Photo Thumbnail component ─────────────────────────────────────────────────

function PhotoGrid({ photos, onRemove, onAdd, readOnly }) {
  const t = useT();
  const inputRef = useRef(null);

  const handleFileChange = e => {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => onAdd(ev.target.result);
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  return (
    <div style={pg.wrap}>
      {photos.map((url, i) => (
        <div key={i} style={pg.thumb}>
          <img
            src={url}
            alt=""
            style={pg.img}
            onClick={() => window.open(url, '_blank')}
          />
          {!readOnly && (
            <button style={pg.removeBtn} aria-label={t.removePhoto} onClick={() => onRemove(i)} title={t.removePhoto}>×</button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button style={pg.addBtn} onClick={() => inputRef.current?.click()} title={t.addPhoto}>
          <span style={pg.addIcon}>+</span>
          <span style={pg.addLabel}>Photo</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}

const pg = {
  wrap:      { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  thumb:     { position: 'relative', width: 80, height: 80, borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' },
  img:       { width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' },
  removeBtn: { position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', borderRadius: '50%', width: 20, height: 20, fontSize: 14, lineHeight: '18px', textAlign: 'center', cursor: 'pointer', padding: 0 },
  addBtn:    { width: 80, height: 80, borderRadius: 8, border: '2px dashed #d1d5db', background: '#f9fafb', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 },
  addIcon:   { fontSize: 20, color: '#6b7280', lineHeight: 1 },
  addLabel:  { fontSize: 11, color: '#6b7280', fontWeight: 600 },
};

// ── Entity Edit Form ──────────────────────────────────────────────────────────

function EntityForm({ level, item, parentId, parentOptions, onSave, onCancel, settings }) {
  const t = useT();
  const isLocation = level.key === 'locations';
  const workLabel = settings?.label_work || 'Project';

  const LEVEL_SGl = {
    locations:    t.invSetupLocationSgl,
    areas:        t.invSetupAreaSgl,
    racks:        t.invSetupRackSgl,
    bays:         t.invSetupBaySgl,
    compartments: t.invSetupCompartmentSgl,
  };
  const levelSingular = LEVEL_SGl[level.key] || level.label;

  const [form, setForm] = useState({
    name:       item?.name       || '',
    notes:      item?.notes      || '',
    address:    item?.address    || '',
    type:       item?.type       || 'warehouse',
    project_id: item?.project_id || '',
    [level.parentKey]: parentId || item?.[level.parentKey] || '',
  });
  const [photos, setPhotos] = useState(item?.photo_urls || []);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async e => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) return setError(t.invSetupNameRequired);
    if (level.parentKey && !form[level.parentKey]) return setError(`${levelSingular} ${t.invSetupIsRequired}`);
    setSaving(true);
    try {
      const payload = {
        name:       form.name.trim(),
        notes:      form.notes.trim() || null,
        photo_urls: photos,
        ...(isLocation ? { type: form.type, project_id: form.project_id || null, address: form.address.trim() || null } : {}),
        ...(!isLocation && item == null ? { [level.parentKey]: parseInt(form[level.parentKey]) } : {}),
      };
      if (item) {
        await api.patch(`${level.apiPath}/${item.id}`, payload);
      } else {
        await api.post(level.apiPath, payload);
      }
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || t.invSetupFailedSave);
    } finally {
      setSaving(false);
    }
  };

  const addPhoto   = url  => setPhotos(p => [...p, url]);
  const removePhoto = idx => setPhotos(p => p.filter((_, i) => i !== idx));

  return (
    <form onSubmit={submit} style={ef.form}>
      <h3 style={ef.title}>{item ? `${t.edit} ${levelSingular}` : `${t.add} ${levelSingular}`}</h3>
      {error && <div role="alert" style={ef.error}>{error}</div>}

      {/* Parent selector (only for new items on non-location levels) */}
      {!isLocation && !item && (
        <div style={ef.field}>
          <label htmlFor="isu-parent" style={ef.label}>{LEVEL_SGl[level.parentLevel] || level.parentLabel} *</label>
          <select
            id="isu-parent"
            style={ef.input}
            value={form[level.parentKey]}
            onChange={e => set(level.parentKey, e.target.value)}
            required
          >
            <option value="">{t.selectPlaceholder} {levelSingular}…</option>
            {parentOptions.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      <div style={ef.field}>
        <label htmlFor="isu-name" style={ef.label}>{t.invSetupNameField}</label>
        <input
          id="isu-name"
          style={ef.input}
          value={form.name}
          onChange={e => set('name', e.target.value)}
          placeholder={`e.g. ${level.key === 'locations' ? `${workLabel} Storage` : level.key === 'areas' ? 'Zone A' : level.key === 'racks' ? 'Rack 3' : level.key === 'bays' ? 'Bay 2' : 'C1'}`}
          required
        />
      </div>

      {isLocation && (
        <>
          <div style={ef.field}>
            <label htmlFor="isu-type" style={ef.label}>{t.invSetupTypeField}</label>
            <select id="isu-type" style={ef.input} value={form.type} onChange={e => set('type', e.target.value)}>
              {level.typeOptions.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div style={ef.field}>
            <label htmlFor="isu-address" style={ef.label}>{t.invSetupAddressField} <span style={ef.labelHint}>({t.optional})</span></label>
            <textarea
              id="isu-address"
              style={{ ...ef.input, minHeight: 56, resize: 'vertical' }}
              value={form.address}
              onChange={e => set('address', e.target.value)}
              placeholder={t.invWarehouseAddressPlaceholder}
              maxLength={500}
            />
          </div>
        </>
      )}

      <div style={ef.field}>
        <label htmlFor="isu-notes" style={ef.label}>{t.notes}</label>
        <textarea
          id="isu-notes"
          style={{ ...ef.input, minHeight: 56, resize: 'vertical' }}
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
          placeholder={t.invWarehouseDescPlaceholder}
          maxLength={1000}
        />
      </div>

      <div style={ef.field}>
        <label style={ef.label}>{t.invSetupPhotosField}</label>
        <PhotoGrid photos={photos} onAdd={addPhoto} onRemove={removePhoto} />
      </div>

      <div style={ef.actions}>
        <button type="button" style={ef.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button type="submit" style={{ ...ef.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} disabled={saving}>
          {saving ? t.saving : item ? t.saveChanges : `${t.add} ${levelSingular}`}
        </button>
      </div>
    </form>
  );
}

const ef = {
  form:      { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24, marginBottom: 16 },
  title:     { fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 20 },
  error:     { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 14 },
  field:     { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 },
  label:     { fontSize: 12, fontWeight: 600, color: '#374151' },
  labelHint: { fontWeight: 400, color: '#6b7280' },
  input:     { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff', width: '100%', boxSizing: 'border-box' },
  actions:   { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 },
  cancelBtn: { padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  saveBtn:   { padding: '8px 18px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};

// ── Supplier Panel ────────────────────────────────────────────────────────────

export function SupplierPanel() {
  const t = useT();
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [showAll, setShowAll]     = useState(false);
  const [supplierSearch, setSupplierSearch] = useState('');
  const [editing, setEditing]     = useState(null); // null=list, false=new, obj=editing
  const [form, setForm]           = useState({ name: '', contact_name: '', phone: '', email: '', website: '', notes: '' });
  const [saving, setSaving]       = useState(false);
  const [formErr, setFormErr]     = useState('');
  const [pendingArchiveSupId, setPendingArchiveSupId] = useState(null);
  const [archiveError, setArchiveError] = useState('');
  const [restoreError, setRestoreError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/inventory/suppliers?active=${showAll ? 'all' : 'true'}`);
      setSuppliers(r.data);
    } catch { setError(t.invSetupFailedLoad); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [showAll]);

  const openNew = () => {
    setForm({ name: '', contact_name: '', phone: '', email: '', website: '', notes: '' });
    setFormErr('');
    setEditing(false);
  };

  const openEdit = (sup) => {
    setForm({ name: sup.name, contact_name: sup.contact_name || '', phone: sup.phone || '',
              email: sup.email || '', website: sup.website || '', notes: sup.notes || '' });
    setFormErr('');
    setEditing(sup);
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setFormErr('');
    if (!form.name.trim()) return setFormErr(t.invSetupNameRequired);
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        contact_name: form.contact_name.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        website: form.website.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (editing) await api.patch(`/inventory/suppliers/${editing.id}`, payload);
      else await api.post('/inventory/suppliers', payload);
      setEditing(null);
      load();
    } catch (err) {
      setFormErr(err.response?.data?.error || t.invSetupFailedSave);
    } finally { setSaving(false); }
  };

  const archive = async (sup) => {
    setPendingArchiveSupId(null);
    setArchiveError('');
    try {
      await api.delete(`/inventory/suppliers/${sup.id}`);
      load();
    } catch (err) { setArchiveError(err.response?.data?.error || t.invSetupFailedArchive); }
  };

  const restore = async (sup) => {
    setRestoreError('');
    try {
      await api.patch(`/inventory/suppliers/${sup.id}`, { active: true });
      load();
    } catch { setRestoreError(t.invSetupFailedRestore); }
  };

  const supplierQuery = supplierSearch.trim().toLowerCase();
  const visibleSuppliers = supplierQuery
    ? suppliers.filter(sup => [
        sup.name,
        sup.contact_name,
        sup.phone,
        sup.email,
        sup.website,
        sup.notes,
        sup.active ? 'active' : 'archived',
      ].some(value => String(value || '').toLowerCase().includes(supplierQuery)))
    : suppliers;

  if (editing !== null) {
    return (
      <div style={sp.formWrap}>
        <h3 style={sp.formTitle}>{editing ? t.invSetupEditSupplierTitle : t.invSetupAddSupplierTitle}</h3>
        {formErr && <div style={sp.error}>{formErr}</div>}
        <div style={sp.row}>
          <div style={sp.field}>
            <label htmlFor="isu-sup-name" style={sp.label}>{t.invSetupNameField}</label>
            <input id="isu-sup-name" style={sp.input} maxLength={255} value={form.name} onChange={e => set('name', e.target.value)} placeholder={t.invSupplierNamePlaceholder} />
          </div>
          <div style={sp.field}>
            <label htmlFor="isu-sup-contact-name" style={sp.label}>{t.invSetupContactName}</label>
            <input id="isu-sup-contact-name" style={sp.input} maxLength={255} value={form.contact_name} onChange={e => set('contact_name', e.target.value)} placeholder={t.contactNamePlaceholder} />
          </div>
        </div>
        <div style={sp.row}>
          <div style={sp.field}>
            <label htmlFor="isu-sup-phone" style={sp.label}>{t.invSetupPhone}</label>
            <input id="isu-sup-phone" style={sp.input} maxLength={50} value={form.phone} onChange={e => set('phone', e.target.value)} placeholder={t.contactPhonePlaceholder} />
          </div>
          <div style={sp.field}>
            <label htmlFor="isu-sup-email" style={sp.label}>{t.invSetupEmail}</label>
            <input id="isu-sup-email" style={sp.input} type="email" maxLength={255} value={form.email} onChange={e => set('email', e.target.value)} placeholder={t.invSupplierEmailPlaceholder} />
          </div>
          <div style={sp.field}>
            <label htmlFor="isu-sup-website" style={sp.label}>{t.invSetupWebsite}</label>
            <input id="isu-sup-website" style={sp.input} value={form.website} onChange={e => set('website', e.target.value)} placeholder={t.invSupplierWebsitePlaceholder} />
          </div>
        </div>
        <div style={sp.field}>
          <label htmlFor="isu-sup-notes" style={sp.label}>{t.notes}</label>
          <textarea id="isu-sup-notes" style={{ ...sp.input, minHeight: 60, resize: 'vertical' }} maxLength={1000} value={form.notes} onChange={e => set('notes', e.target.value)} />
          <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.notes || '').length}/1000</div>
        </div>
        <div style={sp.actions}>
          <button style={sp.cancelBtn} onClick={() => setEditing(null)}>{t.cancel}</button>
          <button style={{ ...sp.saveBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={save} disabled={saving}>{saving ? t.saving : editing ? t.saveChanges : t.invSetupAddSupplierTitle}</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={sp.toolbar}>
        <input
          type="search"
          style={sp.searchInput}
          value={supplierSearch}
          onChange={e => setSupplierSearch(e.target.value)}
          placeholder="Search suppliers..."
        />
        <label style={sp.toggle}>
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
          {t.invSetupShowArchived}
        </label>
        {supplierQuery && <button style={sp.clearBtn} onClick={() => setSupplierSearch('')}>Clear</button>}
        <button style={sp.addBtn} onClick={openNew}>{t.invSetupAddSupplierBtn}</button>
      </div>
      {!loading && !error && (
        <div style={sp.filterMeta}>
          {supplierQuery
            ? `Showing ${visibleSuppliers.length} of ${suppliers.length} matching suppliers`
            : `${suppliers.length} suppliers`}
        </div>
      )}
      {error && <div role="alert" style={sp.error}>{error}</div>}
      {loading ? (
        <SkeletonList count={3} rows={2} />
      ) : suppliers.length === 0 ? (
        <div style={sp.empty}>
          <p>{t.invSetupNoSuppliers}</p>
        </div>
      ) : visibleSuppliers.length === 0 ? (
        <div style={sp.empty}>
          <p>No suppliers match that search.</p>
        </div>
      ) : (
        <div style={sp.list}>
          {visibleSuppliers.map(sup => (
            <div key={sup.id} style={{ ...sp.card, opacity: sup.active ? 1 : 0.6 }}>
              <div style={sp.cardMain}>
                <div style={sp.cardInfo}>
                  <div style={sp.cardName}>{sup.name}</div>
                  {sup.contact_name && <div style={sp.cardMeta}>{sup.contact_name}</div>}
                  <div style={sp.cardContacts}>
                    {sup.phone && <span style={sp.contact}>{sup.phone}</span>}
                    {sup.email && <a href={`mailto:${sup.email}`} style={sp.contactLink}>{sup.email}</a>}
                    {sup.website && isHttpUrl(sup.website) && <a href={sup.website} target="_blank" rel="noopener noreferrer" style={sp.contactLink}>{sup.website.replace(/^https?:\/\//, '')}</a>}
                  </div>
                  {sup.notes && <div style={sp.cardNotes}>{sup.notes}</div>}
                </div>
                <div style={sp.cardActions}>
                  {sup.active ? (
                    <>
                      <span style={{ ...sp.badge, color: '#059669', background: '#d1fae5' }}>{t.invSetupActiveStatus}</span>
                      <button style={sp.iconBtn} onClick={() => openEdit(sup)} title={t.edit}>Edit</button>
                      {pendingArchiveSupId === sup.id ? (
                        <>
                          <button style={sp.confirmArchiveBtn} onClick={() => archive(sup)}>{t.confirm}</button>
                          <button style={sp.iconBtn} aria-label={t.cancelArchive} onClick={() => setPendingArchiveSupId(null)}>X</button>
                        </>
                      ) : (
                        <button style={sp.iconBtn} onClick={() => setPendingArchiveSupId(sup.id)} title={t.archive}>Archive</button>
                      )}
                    </>
                  ) : (
                    <>
                      <span style={{ ...sp.badge, color: '#6b7280', background: '#f3f4f6' }}>{t.invSetupArchivedStatus}</span>
                      <button style={sp.iconBtn} onClick={() => restore(sup)} title={t.restore}>Restore</button>
                    </>
                  )}
                </div>
                {archiveError && <p style={sp.inlineError}>{archiveError}</p>}
                {restoreError && <p style={sp.inlineError}>{restoreError}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const sp = {
  toolbar:     { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  searchInput: { flex: '1 1 240px', minWidth: 200, padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#111827' },
  toggle:      { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280', cursor: 'pointer' },
  clearBtn:    { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 700, color: '#374151', cursor: 'pointer' },
  addBtn:      { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  filterMeta:  { margin: '0 0 12px', fontSize: 13, color: '#6b7280' },
  error:       { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13 },
  empty:       { textAlign: 'center', padding: '48px 24px', color: '#6b7280', fontSize: 14 },
  emptyIcon:   { fontSize: 36, marginBottom: 10 },
  list:        { display: 'flex', flexDirection: 'column', gap: 8 },
  card:        { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' },
  cardMain:    { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  cardInfo:    { flex: 1, minWidth: 0 },
  cardName:    { fontSize: 15, fontWeight: 700, color: '#111827' },
  cardMeta:    { fontSize: 13, color: '#6b7280', marginTop: 2 },
  cardContacts:{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 4 },
  contact:     { fontSize: 13, color: '#374151' },
  contactLink: { fontSize: 13, color: '#2563eb', textDecoration: 'none' },
  cardNotes:   { fontSize: 13, color: '#6b7280', marginTop: 4, fontStyle: 'italic' },
  cardActions: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  badge:       { display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, marginRight: 4 },
  iconBtn:     { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: '2px 3px' },
  confirmArchiveBtn: { background: '#f59e0b', color: '#fff', border: 'none', padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  inlineError: { fontSize: 12, color: '#ef4444', margin: '4px 0 0' },
  formWrap:    { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 },
  formTitle:   { fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 16 },
  row:         { display: 'flex', gap: 12, flexWrap: 'wrap' },
  field:       { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160, marginBottom: 12 },
  label:       { fontSize: 12, fontWeight: 600, color: '#374151' },
  input:       { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, color: '#111827', background: '#fff', width: '100%', boxSizing: 'border-box' },
  actions:     { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 },
  cancelBtn:   { padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  saveBtn:     { padding: '8px 18px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};

// ── Main Setup Component ───────────────────────────────────────────────────────

export default function InventorySetup({ projects, settings }) {
  const t = useT();

  const LEVEL_LABELS = {
    locations:    t.invSetupLocations,
    areas:        t.invSetupAreas,
    racks:        t.invSetupRacks,
    bays:         t.invSetupBays,
    compartments: t.invSetupCompartments,
  };

  const LEVEL_LABELS_SGl = {
    locations:    t.invSetupLocationSgl,
    areas:        t.invSetupAreaSgl,
    racks:        t.invSetupRackSgl,
    bays:         t.invSetupBaySgl,
    compartments: t.invSetupCompartmentSgl,
  };

  const [levelKey,  setLevelKey]  = useState('locations');
  const [items,     setItems]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [setupSearch, setSetupSearch] = useState('');
  const [editing,   setEditing]   = useState(null); // null=list, false=new, obj=edit
  const [printItem, setPrintItem] = useState(null); // item to print label for
  const [pendingArchiveItemId, setPendingArchiveItemId] = useState(null);
  const [itemArchiveError, setItemArchiveError] = useState('');
  const [itemRestoreError, setItemRestoreError] = useState('');

  // Parent cascade: store selected IDs for each level so child levels can filter
  const [parentSels, setParentSels] = useState({
    location_id: '',
    area_id:     '',
    rack_id:     '',
    bay_id:      '',
  });
  // Options for each parent dropdown
  const [parentOpts, setParentOpts] = useState({
    locations: [],
    areas:     [],
    racks:     [],
    bays:      [],
  });

  const level = LEVELS.find(l => l.key === levelKey);

  // Load parent options when a parent selection changes
  useEffect(() => {
    const load = async () => {
      // Always keep locations fresh
      const locs = await api.get('/inventory/locations?active=all').catch(() => ({ data: [] }));
      setParentOpts(p => ({ ...p, locations: locs.data }));
    };
    load();
  }, []);

  useEffect(() => {
    if (!parentSels.location_id) {
      setParentOpts(p => ({ ...p, areas: [] }));
      setParentSels(s => ({ ...s, area_id: '', rack_id: '', bay_id: '' }));
      return;
    }
    api.get(`/inventory/setup/areas?active=all&location_id=${parentSels.location_id}`)
      .then(r => setParentOpts(p => ({ ...p, areas: r.data })))
      .catch(silentError('inventorysetup'));
    setParentSels(s => ({ ...s, area_id: '', rack_id: '', bay_id: '' }));
  }, [parentSels.location_id]);

  useEffect(() => {
    if (!parentSels.area_id) {
      setParentOpts(p => ({ ...p, racks: [] }));
      setParentSels(s => ({ ...s, rack_id: '', bay_id: '' }));
      return;
    }
    api.get(`/inventory/setup/racks?active=all&area_id=${parentSels.area_id}`)
      .then(r => setParentOpts(p => ({ ...p, racks: r.data })))
      .catch(silentError('inventorysetup'));
    setParentSels(s => ({ ...s, rack_id: '', bay_id: '' }));
  }, [parentSels.area_id]);

  useEffect(() => {
    if (!parentSels.rack_id) {
      setParentOpts(p => ({ ...p, bays: [] }));
      setParentSels(s => ({ ...s, bay_id: '' }));
      return;
    }
    api.get(`/inventory/setup/bays?active=all&rack_id=${parentSels.rack_id}`)
      .then(r => setParentOpts(p => ({ ...p, bays: r.data })))
      .catch(silentError('inventorysetup'));
    setParentSels(s => ({ ...s, bay_id: '' }));
  }, [parentSels.rack_id]);

  // Load items for current level
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      let url = `${level.apiPath}?active=all`;
      if (level.parentKey) {
        const parentId = parentSels[level.parentKey];
        if (parentId) url += `&${level.parentKey}=${parentId}`;
      }
      const r = await api.get(url);
      setItems(r.data);
    } catch {
      setError(t.invSetupFailedLoad);
    } finally {
      setLoading(false);
    }
  };

  // Reload when level or relevant parent selection changes
  useEffect(() => {
    setEditing(null);
    load();
  }, [levelKey, parentSels.location_id, parentSels.area_id, parentSels.rack_id, parentSels.bay_id]);

  useEffect(() => {
    setSetupSearch('');
  }, [levelKey]);

  const handleSave = () => {
    setEditing(null);
    load();
  };

  const archive = async item => {
    setPendingArchiveItemId(null);
    setItemArchiveError('');
    try {
      await api.delete(`${level.apiPath}/${item.id}`);
      load();
    } catch (err) {
      setItemArchiveError(err.response?.data?.error || t.invSetupFailedArchive);
    }
  };

  const restore = async item => {
    setItemRestoreError('');
    try {
      await api.patch(`${level.apiPath}/${item.id}`, { active: true });
      load();
    } catch { setItemRestoreError(t.invSetupFailedRestore); }
  };

  // Which parent option list feeds the "Add new" form's parent selector
  const parentOptionsForForm = () => {
    if (!level?.parentLevel) return [];
    return parentOpts[level.parentLevel] || [];
  };

  // Pre-selected parent ID for "Add new" form
  const preselectedParentId = level?.parentKey ? parentSels[level.parentKey] : null;

  // Parent filter selects to show above the list
  const parentFilters = () => {
    const filters = [];
    if (['areas','racks','bays','compartments'].includes(levelKey)) {
      filters.push({ label: t.invSetupLocationSgl, key: 'location_id', options: parentOpts.locations });
    }
    if (['racks','bays','compartments'].includes(levelKey)) {
      filters.push({ label: t.invSetupAreaSgl, key: 'area_id', options: parentOpts.areas });
    }
    if (['bays','compartments'].includes(levelKey)) {
      filters.push({ label: t.invSetupRackSgl, key: 'rack_id', options: parentOpts.racks });
    }
    if (levelKey === 'compartments') {
      filters.push({ label: t.invSetupBaySgl, key: 'bay_id', options: parentOpts.bays });
    }
    return filters;
  };

  const setupQuery = setupSearch.trim().toLowerCase();
  const visibleItems = setupQuery
    ? items.filter(item => [
        item.name,
        item.parent_name,
        item.address,
        item.notes,
        item.type,
        item.active ? 'active' : 'archived',
      ].some(value => String(value || '').toLowerCase().includes(setupQuery)))
    : items;

  return (
    <div style={s.wrap}>
      {/* Level tabs */}
      <div style={s.levelTabs}>
        {LEVELS.map(l => (
          <button
            key={l.key}
            style={{ ...s.levelTab, ...(l.key === levelKey ? s.levelTabActive : {}) }}
            onClick={() => setLevelKey(l.key)}
          >
            {LEVEL_LABELS[l.key] || l.label}
          </button>
        ))}
      </div>

      {/* Parent cascade filters */}
      {parentFilters().length > 0 && (
        <div style={s.filters}>
          {parentFilters().map(f => (
            <div key={f.key} style={s.filterGroup}>
              <label style={s.filterLabel}>{f.label}</label>
              <select
                style={s.filterSelect}
                value={parentSels[f.key]}
                onChange={e => setParentSels(p => ({ ...p, [f.key]: e.target.value }))}
              >
                <option value="">{t.invCycAllLocations}</option>
                {f.options.map(o => <option key={o.id} value={o.id}>{o.name}{!o.active ? ` ${t.invSetupArchivedSuffix}` : ''}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      {/* Edit / Add form */}
      {editing !== null && (
        <EntityForm
          level={level}
          item={editing || null}
          parentId={preselectedParentId}
          parentOptions={parentOptionsForForm()}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
          projects={projects}
          settings={settings}
        />
      )}

      {/* List */}
      {editing === null && (
        <>
          <div style={s.searchBar}>
            <input
              type="search"
              style={s.searchInput}
              value={setupSearch}
              onChange={e => setSetupSearch(e.target.value)}
              placeholder={`Search ${(LEVEL_LABELS[level.key] || level.label).toLowerCase()}...`}
            />
            {setupQuery && (
              <button style={s.clearBtn} onClick={() => setSetupSearch('')}>Clear</button>
            )}
          </div>
          <div style={s.toolbar}>
            <span style={s.count}>
              {setupQuery
                ? `Showing ${visibleItems.length} of ${items.length} ${(LEVEL_LABELS[level.key] || level.label).toLowerCase()}`
                : `${items.length} ${(LEVEL_LABELS[level.key] || level.label).toLowerCase()}`}
            </span>
            <button style={s.addBtn} onClick={() => setEditing(false)}>
              + {t.add} {LEVEL_LABELS_SGl[level.key] || level.label}
            </button>
          </div>

          {error && <div role="alert" style={s.error}>{error}</div>}

          {loading ? (
            <SkeletonList count={3} rows={1} />
          ) : items.length === 0 ? (
            <div style={s.empty}>
              <p>{t.invSetupNoPrefix} {(LEVEL_LABELS[level.key] || level.label).toLowerCase()} {t.invSetupNoSuffix}</p>
            </div>
          ) : visibleItems.length === 0 ? (
            <div style={s.empty}>
              <p>No {(LEVEL_LABELS[level.key] || level.label).toLowerCase()} match that search.</p>
            </div>
          ) : (
            <div style={s.list}>
              {visibleItems.map(item => (
                <div key={item.id} style={{ ...s.card, opacity: item.active ? 1 : 0.55 }}>
                  <div style={s.cardMain}>
                    <div style={s.cardInfo}>
                      <div style={s.cardName}>{item.name}</div>
                      {item.parent_name && (
                        <div style={s.cardParent}>{t.invSetupIn} {item.parent_name}</div>
                      )}
                      {item.address && <div style={s.cardAddress}>{item.address}</div>}
                      {item.notes && <div style={s.cardNotes}>{item.notes}</div>}
                    </div>
                    <div style={s.cardRight}>
                      {item.photo_urls?.length > 0 && (
                        <div style={s.photoRow}>
                          {item.photo_urls.slice(0, 3).map((url, i) => (
                            <img
                              key={i}
                              src={url}
                              alt=""
                              style={s.thumbSmall}
                              onClick={() => window.open(url, '_blank')}
                            />
                          ))}
                          {item.photo_urls.length > 3 && (
                            <span style={s.morePhotos}>+{item.photo_urls.length - 3}</span>
                          )}
                        </div>
                      )}
                      <div style={s.cardActions}>
                        {!item.active
                          ? <span style={{ ...s.badge, color: '#6b7280', background: '#f3f4f6' }}>{t.invSetupArchivedStatus}</span>
                          : <span style={{ ...s.badge, color: '#059669', background: '#d1fae5' }}>{t.invSetupActiveStatus}</span>
                        }
                        {item.active ? (
                          <>
                            {level.key !== 'locations' && (
                              <button style={s.iconBtn} onClick={() => setPrintItem(item)} title={t.printQRLabel}>Label</button>
                            )}
                            <button style={s.iconBtn} onClick={() => setEditing(item)} title={t.edit}>Edit</button>
                            {pendingArchiveItemId === item.id ? (
                              <>
                                <button style={s.confirmArchiveBtn} onClick={() => archive(item)}>{t.confirm}</button>
                                <button style={s.iconBtn} aria-label={t.cancelArchive} onClick={() => setPendingArchiveItemId(null)}>X</button>
                              </>
                            ) : (
                              <button style={s.iconBtn} onClick={() => setPendingArchiveItemId(item.id)} title={t.archive}>Archive</button>
                            )}
                          </>
                        ) : (
                          <button style={s.iconBtn} onClick={() => restore(item)} title={t.restore}>Restore</button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {itemArchiveError && <p style={s.inlineError}>{itemArchiveError}</p>}
      {itemRestoreError && <p style={s.inlineError}>{itemRestoreError}</p>}
      {printItem && (
        <BinLabelModal
          item={printItem}
          binType={level.key.slice(0, -1)} // 'areas' to 'area'
          onClose={() => setPrintItem(null)}
        />
      )}
    </div>
  );
}

const s = {
  wrap:          { padding: 16 },
  levelTabs:     { display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' },
  levelTab:      { padding: '7px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  levelTabActive:{ background: '#92400e', color: '#fff', borderColor: '#92400e' },
  filters:       { display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 16px' },
  filterGroup:   { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 150 },
  filterLabel:   { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  filterSelect:  { padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151' },
  searchBar:     { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
  searchInput:   { flex: '1 1 240px', minWidth: 200, padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, background: '#fff', color: '#111827' },
  clearBtn:      { padding: '8px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 700, color: '#374151', cursor: 'pointer' },
  toolbar:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  count:         { fontSize: 13, color: '#6b7280' },
  addBtn:        { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#92400e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  error:         { background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 12, fontSize: 14 },
  empty:         { textAlign: 'center', padding: '48px 24px', color: '#6b7280', fontSize: 15 },
  emptyIcon:     { fontSize: 36, marginBottom: 10 },
  list:          { display: 'flex', flexDirection: 'column', gap: 8 },
  card:          { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' },
  cardMain:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  cardInfo:      { flex: 1, minWidth: 0 },
  cardName:      { fontSize: 15, fontWeight: 700, color: '#111827' },
  cardParent:    { fontSize: 12, color: '#6b7280', marginTop: 2 },
  cardAddress:   { fontSize: 12, color: '#6b7280', marginTop: 3, fontStyle: 'italic' },
  cardNotes:     { fontSize: 13, color: '#6b7280', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  cardRight:     { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 },
  photoRow:      { display: 'flex', gap: 4, alignItems: 'center' },
  thumbSmall:    { width: 40, height: 40, borderRadius: 6, objectFit: 'cover', cursor: 'pointer', border: '1px solid #e5e7eb' },
  morePhotos:    { fontSize: 12, color: '#6b7280', fontWeight: 600 },
  cardActions:   { display: 'flex', alignItems: 'center', gap: 4 },
  badge:         { display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 },
  iconBtn:       { background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: '2px 3px' },
  confirmArchiveBtn: { background: '#f59e0b', color: '#fff', border: 'none', padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  inlineError:   { fontSize: 12, color: '#ef4444', margin: '4px 0 0' },
};
