import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { fmtHours, formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { handlePdfError } from '../pdfError';
import { renderTraceItem, renderLeaveDetail, traceItemPhase } from '../utils/reportTrace';
import DeductionListEditor from './DeductionListEditor';
import { downloadCsv } from '../utils/csv';

const fmtDate = d => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local
const sundayOf = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; };

// Preset ranges. Weeks are Sunday–Saturday, matching the app's default range.
function presetRange(kind) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const thisSun = sundayOf(today);
  const lastSun = new Date(thisSun); lastSun.setDate(lastSun.getDate() - 7);
  const lastSat = new Date(thisSun); lastSat.setDate(lastSat.getDate() - 1);
  if (kind === 'this') return { from: fmtDate(thisSun), to: fmtDate(today) };
  if (kind === 'lastweek') return { from: fmtDate(lastSun), to: fmtDate(lastSat) };
  if (kind === 'twoweeks') { const twoSun = new Date(thisSun); twoSun.setDate(twoSun.getDate() - 14); return { from: fmtDate(twoSun), to: fmtDate(lastSat) }; }
  if (kind === 'lastmonth') { const first = new Date(today.getFullYear(), today.getMonth() - 1, 1); const last = new Date(today.getFullYear(), today.getMonth(), 0); return { from: fmtDate(first), to: fmtDate(last) }; }
  return { from: fmtDate(lastSun), to: fmtDate(lastSat) };
}

function defaultDates() { return presetRange('lastweek'); }

// The report AREA: the detail panel for ONE selected member, rendered once below
// the member table (not per row). Mounted with key={worker.id} so switching
// members resets its state cleanly.
export default function WorkerMetrics({ worker, currency = 'USD', companyInfo = {}, overtimeEnabled = true, projectsEnabled = true, projects = [], settings = null }) {
  const t = useT();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [from, setFrom] = useState(defaultDates().from);
  const [to, setTo] = useState(defaultDates().to);
  const [billData, setBillData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openLine, setOpenLine] = useState(null); // 'e{idx}' | 'ot' | 'sick' | 'vacation' | 'guarantee' | 'deductions' | 'inputs'
  const [detailsOpen, setDetailsOpen] = useState(false); // the per-entry breakdown is collapsed by default
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [addForm, setAddForm] = useState({ work_date: defaultDates().to, start_time: '08:00', end_time: '17:00', project_id: '', notes: '', break_minutes: '0' });
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState(false);
  const [showDeductions, setShowDeductions] = useState(false);
  const [deductions, setDeductions] = useState(null);
  const [dedSaving, setDedSaving] = useState(false);
  const [dedError, setDedError] = useState('');
  const [dedSaved, setDedSaved] = useState(false);

  const policyRaw = settings?.hours_rules || null;
  const toggleLine = key => setOpenLine(cur => (cur === key ? null : key));
  const goto = link => { if (link) navigate(link); };

  const rowToForm = d => ({ id: `d${d.id}`, name: d.name || '', kind: d.kind === 'fixed' ? 'fixed' : 'percent', value: d.value != null ? String(d.value) : '', cap: d.cap_amount != null ? String(d.cap_amount) : '' });

  const toggleDeductions = async () => {
    const next = !showDeductions;
    setShowDeductions(next);
    setDedError(''); setDedSaved(false);
    if (next && deductions == null) {
      try {
        const r = await api.get(`/admin/workers/${worker.id}/deductions`);
        setDeductions((r.data.deductions || []).map(rowToForm));
      } catch (err) {
        setDeductions([]);
        setDedError(err?.response?.data?.error || t.dedSaveFailed);
      }
    }
  };

  const saveDeductions = async () => {
    setDedSaving(true); setDedError(''); setDedSaved(false);
    try {
      const payload = (deductions || [])
        .filter(it => String(it.name).trim() && Number.isFinite(parseFloat(it.value)) && parseFloat(it.value) >= 0)
        .map(it => {
          const out = { name: String(it.name).trim().slice(0, 120), kind: it.kind, value: parseFloat(it.value) };
          const cap = parseFloat(it.cap);
          if (it.kind === 'percent' && Number.isFinite(cap) && cap > 0) out.cap_amount = cap;
          return out;
        });
      const r = await api.put(`/admin/workers/${worker.id}/deductions`, { deductions: payload });
      setDeductions((r.data.deductions || []).map(rowToForm));
      setDedSaved(true);
      setTimeout(() => setDedSaved(false), 3000);
      if (billData) fetchBill();
    } catch (err) {
      setDedError(err?.response?.data?.error || t.dedSaveFailed);
    } finally {
      setDedSaving(false);
    }
  };

  const handleAddEntry = async e => {
    e.preventDefault();
    setAddSaving(true); setAddError(''); setAddSuccess(false);
    try {
      await api.post(`/admin/workers/${worker.id}/entries`, {
        work_date: addForm.work_date,
        start_time: addForm.start_time,
        end_time: addForm.end_time,
        project_id: addForm.project_id || null,
        notes: addForm.notes || null,
        break_minutes: parseInt(addForm.break_minutes) || 0,
      });
      setAddSuccess(true);
      setTimeout(() => setAddSuccess(false), 3000);
      setShowAddEntry(false);
      setAddForm({ work_date: defaultDates().to, start_time: '08:00', end_time: '17:00', project_id: '', notes: '', break_minutes: '0' });
      if (billData) fetchBill();
    } catch (err) {
      setAddError(err.response?.data?.error || t.failedAddEntry);
    } finally {
      setAddSaving(false);
    }
  };

  const applyPreset = kind => {
    const r = presetRange(kind);
    setFrom(r.from); setTo(r.to);
  };

  const fetchBill = async () => {
    setLoading(true); setOpenLine(null);
    try {
      const params = { explain: 1 };
      if (from) params.from = from;
      if (to) params.to = to;
      const r = await api.get(`/admin/workers/${worker.id}/entries`, { params });
      setBillData(r.data);
    } finally {
      setLoading(false);
    }
  };

  const makeBillElement = async () => {
    const [{ pdf }, { default: BillPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('./BillPDF'),
    ]);
    const el = React.createElement(BillPDF, { data: billData, currency, companyInfo, overtimeEnabled, showProject: projectsEnabled, showRateType: (companyInfo?.prevailing_wage_rate ?? 0) > 0, t, language: user?.language, settings });
    return { pdf, el };
  };

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const { pdf, el } = await makeBillElement();
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `bill-${worker.username}-${from || 'all'}-to-${to || 'all'}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      handlePdfError(err, t.pdfFailed);
    } finally { setPdfGenerating(false); }
  };

  const togglePreview = async () => {
    if (showPreview) { setShowPreview(false); return; }
    setPdfGenerating(true);
    try {
      const { pdf, el } = await makeBillElement();
      const blob = await pdf(el).toBlob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      setShowPreview(true);
    } catch (err) {
      handlePdfError(err, t.pdfFailed);
    } finally { setPdfGenerating(false); }
  };

  const exportCSV = () => {
    const showOtCol = overtimeEnabled && settings?.report_daily_ot_column !== false;
    const headers = ['Date', 'Type', 'Project', 'Category / Wage Type', 'Start', 'End', ...(showOtCol ? ['Overtime'] : []), 'Hours', 'Amount'];
    const SYN_CSV = { guarantee: 'Guaranteed hours (no clock-in)', min_daily: 'Minimum daily top-up', weekly_guarantee: 'Weekly-hours guarantee top-up', sick: 'Sick leave', vacation: 'Vacation leave' };
    const timeRows = billData.entries.map(e => {
      if (e.synthetic) {
        // Rule-generated hours (floor / guarantee / leave) are entries now — one CSV row each.
        return [e.work_date?.toString().substring(0, 10), 'Rule hours', SYN_CSV[e.kind] || e.kind, e.wage_type, '', '', ...(showOtCol ? ['0.00'] : []), Number(e.hours).toFixed(2), e.cost != null ? e.cost : ''];
      }
      let hMs = new Date(`1970-01-01T${e.end_time}`) - new Date(`1970-01-01T${e.start_time}`);
      if (hMs < 0) hMs += 86400000; // overnight shift (end past midnight) — same wrap as netHours
      const h = Math.max(0, hMs / 3600000 - (Number(e.break_minutes) || 0) / 60).toFixed(2);
      return [e.work_date?.toString().substring(0, 10), 'Time', e.project_name || '', e.wage_type, e.start_time, e.end_time, ...(showOtCol ? [(e.overtime_hours || 0).toFixed(2)] : []), h, ''];
    });
    const reimbRows = (billData.reimbursements || []).map(r => [
      r.expense_date?.toString().substring(0, 10), 'Expense', r.project_name || '', r.category || r.description || '', '', '', ...(showOtCol ? [''] : []), '', r.amount,
    ]);
    downloadCsv([headers, ...timeRows, ...reimbRows], `${worker.username}-${from || 'all'}-to-${to || 'all'}.csv`);
  };

  const PRESETS = [
    { kind: 'this', label: t.presetThisWeek },
    { kind: 'lastweek', label: t.presetLastWeek },
    { kind: 'twoweeks', label: t.presetLastTwoWeeks },
    { kind: 'lastmonth', label: t.presetLastMonth },
  ];

  const s = billData?.summary;
  const hasResults = billData && (billData.entries.length > 0 || (billData.reimbursements || []).length > 0 || (s?.sick_hours > 0) || (s?.vacation_hours > 0) || (s?.guarantee_shortfall_hours > 0));

  // Labels + expandable "why" for engine-generated (synthetic) entry rows — the hours
  // a rule adds without a clock-in (floor / guarantee / paid leave).
  const SYN_LABELS = {
    guarantee: t.floorGuaranteeLabel, min_daily: t.floorMinDailyLabel,
    weekly_guarantee: t.guaranteeTopupLabel, sick: t.pdfSickHours || 'Sick', vacation: t.pdfVacationHours || 'Vacation',
  };
  const syntheticTrace = (e) => {
    if (e.kind === 'sick' || e.kind === 'vacation')
      return <LeaveDetail rows={(billData.leave_detail || []).filter(d => d.type === e.kind)} t={t} policyRaw={policyRaw} goto={goto} />;
    let text, link = '/administration#workspace';
    if (e.kind === 'weekly_guarantee') {
      const ex = (e.explain && e.explain[0]) || {};
      text = (t.trGuaranteeTopup || 'Guaranteed {min}h over {weeks} wk; worked {worked} — topped up {short} × {rate} = {cost}.')
        .replace('{min}', fmtHours(ex.minHours)).replace('{weeks}', ex.weeks).replace('{worked}', fmtHours(s.total_hours))
        .replace('{short}', fmtHours(e.hours)).replace('{rate}', formatCurrency(s.rate, currency)).replace('{cost}', formatCurrency(e.cost, currency));
      link = '/team';
    } else {
      text = e.kind === 'guarantee' ? t.floorGuaranteeTrace : t.floorMinDailyTrace;
    }
    return <div style={styles.trace}><div style={styles.traceItem}><span>{text}</span><button style={styles.traceLink} onClick={() => goto(link)}>{t.trViewSetting} →</button></div></div>;
  };

  // Paid hours for a row: clock span MINUS the logged break (the break comes off paid
  // time). Synthetic rows already carry their net hours. The break itself is in the
  // entry's expand trace (break_logged), so the difference from the span is traceable.
  const dur = e => {
    if (e.synthetic) return Number(e.hours) || 0;
    let ms = new Date(`1970-01-01T${e.end_time}`) - new Date(`1970-01-01T${e.start_time}`);
    if (ms < 0) ms += 86400000; // overnight shift (end past midnight) — same wrap as netHours
    return Math.max(0, ms / 3600000 - (Number(e.break_minutes) || 0) / 60);
  };

  // Structured per-entry trace: clock in → its rules, clock out → its rules, then the
  // total with the type breakdown → its rules. Reads top-to-bottom like the shift ran.
  const EntryTrace = ({ e }) => {
    const items = Array.isArray(e.explain) ? e.explain : [];
    const row = (it, i) => {
      const r = renderTraceItem(it, { t, policyRaw });
      if (!r) return null;
      return (
        <div key={i} style={styles.traceSub}>
          <span>{r.text}</span>
          {r.link && <button style={styles.traceLink} onClick={() => goto(r.link)}>{t.trViewSetting} →</button>}
        </div>
      );
    };
    const rowsFor = phase => items.filter(it => traceItemPhase(it) === phase).map(row).filter(Boolean);
    const rawIn = (e.raw_start_time || e.start_time || '').slice(0, 5);
    const rawOut = (e.raw_end_time || e.end_time || '').slice(0, 5);
    const totalH = dur(e);
    const ot = Number(e.overtime_hours) || 0;
    const reg = Math.max(0, totalH - ot);
    const parts = [`${fmtHours(reg)} ${t.trTypeRegular}`];
    if (overtimeEnabled && ot > 0) parts.push(`${fmtHours(ot)} ${t.trTypeOvertime}`);
    if (e.wage_type === 'prevailing') parts.push(t.trTypePrevailing);
    return (
      <div style={styles.trace}>
        <div style={styles.traceHead}>{t.trHdrClockIn} · {rawIn}</div>
        {rowsFor('in')}
        <div style={styles.traceHead}>{t.trHdrClockOut} · {rawOut}</div>
        {rowsFor('out')}
        <div style={styles.traceHead}>{t.trHdrTotal} · {fmtHours(totalH)} ({parts.join(' · ')})</div>
        {rowsFor('total')}
      </div>
    );
  };

  return (
    <div style={styles.panelCard}>
      <div style={styles.panelHead}>
        <span style={styles.name}>{worker.full_name}</span>
        <span style={styles.username}>@{worker.username}</span>
      </div>
      <div style={styles.panel}>
          <div style={styles.panelActions}>
            <button style={styles.addEntryBtn} onClick={toggleDeductions}>{showDeductions ? `✕ ${t.cancel}` : `− ${t.dedWorkerBtn}`}</button>
            <button style={styles.addEntryBtn} onClick={() => { setShowAddEntry(v => !v); setAddError(''); setAddSuccess(false); }}>{showAddEntry ? `✕ ${t.cancel}` : `+ ${t.addEntry}`}</button>
          </div>

          {showDeductions && (
            <div style={styles.addForm}>
              <p style={{ fontSize: 12.5, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>{t.dedWorkerNote}</p>
              {deductions == null ? <div style={{ color: '#6b7280', fontSize: 13 }}>{t.loading}</div> : (
                <>
                  <DeductionListEditor items={deductions} onChange={setDeductions} />
                  {dedError && <div style={styles.addError}>{dedError}</div>}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                    <button style={{ ...styles.fetchBtn, ...(dedSaving ? styles.disabled : {}) }} onClick={saveDeductions} disabled={dedSaving}>{dedSaving ? t.saving : t.dedSave}</button>
                    {dedSaved && <span style={{ color: '#059669', fontSize: 13, fontWeight: 600 }}>{t.dedSaved}</span>}
                  </div>
                </>
              )}
            </div>
          )}
          {addSuccess && <div style={styles.addSuccess}>{t.entryAddedSuccess}</div>}
          {showAddEntry && (
            <form onSubmit={handleAddEntry} style={styles.addForm}>
              <div style={styles.addRow}>
                <div style={styles.addField}><label style={styles.label}>{t.date}</label><input style={styles.input} type="date" value={addForm.work_date} onChange={e => setAddForm(f => ({ ...f, work_date: e.target.value }))} required disabled={addSaving} /></div>
                <div style={styles.addField}><label style={styles.label}>{t.startTime}</label><input style={styles.input} type="time" value={addForm.start_time} onChange={e => setAddForm(f => ({ ...f, start_time: e.target.value }))} required disabled={addSaving} /></div>
                <div style={styles.addField}><label style={styles.label}>{t.endTime}</label><input style={styles.input} type="time" value={addForm.end_time} onChange={e => setAddForm(f => ({ ...f, end_time: e.target.value }))} required disabled={addSaving} /></div>
                <div style={styles.addField}><label style={styles.label}>{t.breakMin}</label><input style={{ ...styles.input, width: 70 }} type="number" min="0" value={addForm.break_minutes} onChange={e => setAddForm(f => ({ ...f, break_minutes: e.target.value }))} disabled={addSaving} /></div>
              </div>
              {projectsEnabled && projects.length > 0 && (
                <div style={styles.addField}><label style={styles.label}>Project</label>
                  <select style={styles.input} value={addForm.project_id} onChange={e => setAddForm(f => ({ ...f, project_id: e.target.value }))} disabled={addSaving}>
                    <option value="">No project</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
              <div style={styles.addField}><label style={styles.label}>{t.notes}</label><input style={{ ...styles.input, width: '100%' }} type="text" maxLength={500} value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} placeholder={t.optional} disabled={addSaving} /></div>
              {addError && <div style={styles.addError}>{addError}</div>}
              <button style={{ ...styles.fetchBtn, ...(addSaving ? styles.disabled : {}) }} type="submit" disabled={addSaving}>{addSaving ? t.saving : t.addEntry}</button>
            </form>
          )}

          <div style={styles.dateRow}>
            <div style={styles.dateField}><label style={styles.label}>{t.from}</label><input style={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div style={styles.dateField}><label style={styles.label}>{t.to}</label><input style={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
            <button style={{ ...styles.fetchBtn, ...(loading ? styles.disabled : {}) }} onClick={fetchBill} disabled={loading}>{loading ? t.loading : t.generateEntries}</button>
          </div>
          <div style={styles.presetRow}>
            {PRESETS.map(p => <button key={p.kind} style={styles.presetBtn} onClick={() => applyPreset(p.kind)}>{p.label}</button>)}
          </div>

          {billData && !hasResults && <div style={{ marginTop: 12, color: '#6b7280', fontSize: 14 }}>{t.noEntriesPeriod}</div>}

          {billData && hasResults && (
            <div style={{ marginTop: 16 }}>
              {/* ── Time entries (collapsible details, default collapsed) ── */}
              {(billData.entries.length > 0 || s.guarantee_shortfall_hours > 0 || s.sick_hours > 0 || s.vacation_hours > 0) && (
                <div style={styles.section}>
                  <div style={{ ...styles.line, ...styles.lineClickable }} onClick={() => setDetailsOpen(v => !v)}>
                    <span style={styles.sectionTitle}>{t.trTimeEntries}</span>
                    <span style={styles.rowSpacer} />
                    <span style={styles.lineChev}>{detailsOpen ? '▾' : '▸'}</span>
                  </div>
                  {detailsOpen && billData.entries.map((e, idx) => {
                    const key = `e${idx}`;
                    // Real entries always expand (clock in / out / total); synthetic rows
                    // expand only when they carry a trace.
                    const expandable = e.synthetic ? (Array.isArray(e.explain) && e.explain.length > 0) : true;
                    const synLabel = e.synthetic ? (SYN_LABELS[e.kind] || t.floorMinDailyLabel) : null;
                    return (
                      <div key={e.id ?? idx}>
                        <div style={{ ...styles.line, ...(expandable ? styles.lineClickable : {}) }} onClick={() => expandable && toggleLine(key)}>
                          <span style={styles.lineDate}>{e.work_date?.toString().substring(0, 10)}</span>
                          <span style={styles.lineMid}>{e.synthetic
                            ? <>{synLabel}{e.cost != null ? ` · ${formatCurrency(e.cost, currency)}` : ''}</>
                            : <>{e.project_name || '—'}{e.wage_type === 'prevailing' ? ` · ${t.prevailingLabel}` : ''}</>}</span>
                          <span style={styles.lineTimes}>{e.synthetic ? '' : `${(e.start_time || '').slice(0, 5)}–${(e.end_time || '').slice(0, 5)}`}</span>
                          {overtimeEnabled && !e.synthetic && (e.overtime_hours || 0) > 0 && <span style={styles.otBadge}>{t.otHrs} {fmtHours(e.overtime_hours)}</span>}
                          <span style={styles.lineHours}>{fmtHours(dur(e))}</span>
                          <span style={styles.lineChev}>{expandable ? (openLine === key ? '▾' : '▸') : ''}</span>
                        </div>
                        {openLine === key && expandable && (e.synthetic ? syntheticTrace(e) : <EntryTrace e={e} />)}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Expenses ── */}
              {(billData.reimbursements || []).length > 0 && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>{t.trExpenses}</div>
                  {billData.reimbursements.map((r, i) => (
                    <div key={r.id ?? i} style={styles.line}>
                      <span style={styles.lineDate}>{r.expense_date?.toString().substring(0, 10)}</span>
                      <span style={styles.lineMid}>{r.category || r.description || '—'}</span>
                      <span style={styles.lineHours}>{formatCurrency(r.amount, currency)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Pay summary (expandable lines) ── */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>{t.trPaySummary}</div>
                {s.regular_hours > 0 && <SummaryLine label={t.regularLabel} value={`${fmtHours(s.regular_hours)} · ${formatCurrency(s.regular_cost, currency)}`} />}
                {overtimeEnabled && s.overtime_hours > 0 && (
                  <SummaryLine label={t.overtimeLabel} value={`${fmtHours(s.overtime_hours)} · ${formatCurrency(s.overtime_cost, currency)}`}
                    open={openLine === 'ot'} onToggle={() => toggleLine('ot')}
                    detail={<div style={styles.trace}>
                      {(s.overtime_bands && s.overtime_bands.length > 0
                        ? s.overtime_bands.map((b, i) => (
                            <div key={i} style={styles.traceItem}><span>{(t.trOvertimeBand || '{n}h at {m}×').replace('{n}', fmtHours(b.hours)).replace('{m}', b.mult)}</span></div>
                          ))
                        : [<div key="t" style={styles.traceItem}><span>{t.trOvertimeTotal.replace('{n}', fmtHours(s.overtime_hours))}</span></div>])}
                    </div>} />
                )}
                {s.prevailing_hours > 0 && <SummaryLine label={t.prevailingLabel} value={`${fmtHours(s.prevailing_hours)} · ${formatCurrency(s.prevailing_cost, currency)}`} />}
                {s.night_cost > 0 && (() => {
                  const nd = billData.settings_used?.night_differential;
                  const hr = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0')}`;
                  const detailText = nd
                    ? (t.trNight || '{n}h in the {from}–{to} night window, paid at +{pct}%')
                        .replace('{n}', fmtHours(s.night_hours)).replace('{from}', hr(nd.fromHour)).replace('{to}', hr(nd.toHour)).replace('{pct}', nd.pct)
                    : `${fmtHours(s.night_hours)}`;
                  return (
                    <SummaryLine label={t.nightDiffLabel || 'Night differential'} value={`${fmtHours(s.night_hours)} · ${formatCurrency(s.night_cost, currency)}`}
                      open={openLine === 'night'} onToggle={() => toggleLine('night')}
                      detail={<div style={styles.trace}><div style={styles.traceItem}><span>{detailText}</span><button style={styles.traceLink} onClick={() => goto('/administration#workspace')}>{t.trViewSetting} →</button></div></div>} />
                  );
                })()}
                {/* Guarantee top-up + paid leave are traceable Time-Entries rows above,
                    not summary lines — the summary must not add hours without a matching entry. */}
                <SummaryLine label={t.totalHours || 'Total hours'} value={fmtHours((s.total_hours || 0) + (s.guarantee_shortfall_hours || 0) + (s.sick_hours || 0) + (s.vacation_hours || 0))} strong />
                {(s.deductions || []).length > 0 && (
                  <>
                    <SummaryLine label={t.pdfGrossWages || 'Gross wages'} value={formatCurrency(s.gross_wages, currency)} />
                    <SummaryLine label={t.deductionsLabel || 'Deductions'} value={`− ${formatCurrency(s.deductions_total, currency)}`}
                      open={openLine === 'deductions'} onToggle={() => toggleLine('deductions')}
                      detail={<div style={styles.trace}>{s.deductions.map((d, i) => <div key={i} style={styles.traceItem}><span>{d.name}{d.kind === 'percent' ? ` (${d.value}%)` : ''} — {formatCurrency(d.amount, currency)}</span></div>)}</div>} />
                  </>
                )}
                {s.reimbursement_total > 0 && <SummaryLine label={t.expensesLabel || 'Expenses'} value={`+ ${formatCurrency(s.reimbursement_total, currency)}`} />}
                <SummaryLine label={t.totalCostLabel} value={formatCurrency(s.net_pay ?? s.total_cost, currency)} strong />
              </div>

              {/* ── Inputs used ── */}
              {billData.settings_used && (
                <div style={styles.section}>
                  <div style={{ ...styles.line, ...styles.lineClickable }} onClick={() => toggleLine('inputs')}>
                    <span style={styles.sectionTitle}>{t.trInputsUsed}</span>
                    <span style={styles.rowSpacer} />
                    <span style={styles.lineChev}>{openLine === 'inputs' ? '▾' : '▸'}</span>
                  </div>
                  {openLine === 'inputs' && <InputsUsed su={billData.settings_used} t={t} currency={currency} goto={goto} />}
                </div>
              )}

              {/* ── Export / preview at the bottom ── */}
              <div style={styles.btnRow}>
                <button style={{ ...styles.previewBtn, ...(pdfGenerating ? styles.disabled : {}) }} onClick={togglePreview} disabled={pdfGenerating}>{pdfGenerating ? t.preparing : showPreview ? t.hideBill : t.previewBill}</button>
                <button style={styles.csvBtn} onClick={exportCSV}>{t.exportCSV}</button>
                <button style={{ ...styles.pdfBtn, ...(pdfGenerating ? styles.disabled : {}) }} onClick={downloadPDF} disabled={pdfGenerating}>{pdfGenerating ? t.preparingPDF : t.downloadPDF}</button>
              </div>
              {showPreview && previewUrl && <iframe src={previewUrl} style={styles.pdfViewer} title="Bill Preview" />}
            </div>
          )}
      </div>
    </div>
  );
}

function SummaryLine({ label, value, detail, open, onToggle, strong }) {
  const clickable = typeof onToggle === 'function';
  return (
    <div>
      <div style={{ ...styles.line, ...(clickable ? styles.lineClickable : {}), ...(strong ? styles.lineStrong : {}) }} onClick={clickable ? onToggle : undefined}>
        <span style={styles.lineMid}>{label}</span>
        <span style={styles.rowSpacer} />
        <span style={styles.lineHours}>{value}</span>
        <span style={styles.lineChev}>{clickable ? (open ? '▾' : '▸') : ''}</span>
      </div>
      {open && detail}
    </div>
  );
}

function LeaveDetail({ rows, t, policyRaw, goto }) {
  const rendered = (rows || []).map(d => renderLeaveDetail(d, { t, policyRaw })).filter(Boolean);
  if (rendered.length === 0) return <div style={styles.traceEmpty}>{t.trNoRules}</div>;
  return (
    <div style={styles.trace}>
      {rendered.map((r, i) => (
        <div key={i} style={styles.traceItem}><span>{r.text}</span>{r.link && <button style={styles.traceLink} onClick={() => goto(r.link)}>{t.trViewSetting} →</button>}</div>
      ))}
    </div>
  );
}

function InputsUsed({ su, t, currency, goto }) {
  const money = v => formatCurrency(v, currency);
  const items = [
    { label: t.trRate, value: `${money(su.rate)}${su.rate_type === 'daily' ? '/day' : '/hr'}`, link: '/team' },
    { label: t.trOtRule, value: su.overtime_rule === 'weekly' ? t.trWeekly : t.trDaily, link: '/team' },
    { label: t.trOtThreshold, value: `${su.overtime_threshold}h`, link: '/administration#workspace' },
    { label: t.trOtMult, value: `${su.overtime_multiplier}×`, link: '/administration#workspace' },
    su.prevailing_wage_rate > 0 ? { label: t.prevailingLabel, value: `${money(su.prevailing_wage_rate)}/hr`, link: '/administration#workspace' } : null,
    su.night_differential ? { label: t.nightDiffLabel || 'Night differential', value: `${String(Math.floor(su.night_differential.fromHour)).padStart(2, '0')}:00–${String(Math.floor(su.night_differential.toHour)).padStart(2, '0')}:00 +${su.night_differential.pct}%`, link: '/administration#workspace' } : null,
    { label: t.mrRegularShift, value: `${su.regular_shift_hours}h`, link: '/administration#workspace' },
    { label: t.mrSickPayRate, value: `${su.sick_pay_pct}%`, link: '/administration#workspace' },
    { label: t.mrVacationPayRate, value: `${su.vacation_pay_pct}%`, link: '/administration#workspace' },
    su.guaranteed_weekly_hours > 0 ? { label: t.minGuaranteeLabel || 'Min. guarantee', value: `${su.guaranteed_weekly_hours}h/wk`, link: '/team' } : null,
  ].filter(Boolean);
  return (
    <div style={styles.trace}>
      {items.map((it, i) => (
        <div key={i} style={styles.traceItem}>
          <span><b style={{ color: '#374151' }}>{it.label}:</b> {it.value}</span>
          <button style={styles.traceLink} onClick={() => goto(it.link)}>{t.trViewSetting} →</button>
        </div>
      ))}
    </div>
  );
}

const styles = {
  panelCard: { background: '#fff', borderRadius: 12, boxShadow: '0 2px 14px rgba(0,0,0,0.10)', overflow: 'hidden', marginTop: 16 },
  panelHead: { padding: '14px 18px', display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: '1px solid #f0f0f0' },
  name: { fontWeight: 700, fontSize: 16 },
  username: { color: '#6b7280', fontSize: 12.5 },
  rowSpacer: { flex: 1 },
  panel: { padding: '14px 18px', background: '#fafafa' },
  panelActions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  addEntryBtn: { padding: '5px 14px', background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  addForm: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: '14px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  addRow: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  addField: { display: 'flex', flexDirection: 'column', gap: 4 },
  addError: { color: '#dc2626', fontSize: 13 },
  addSuccess: { color: '#059669', fontSize: 13, fontWeight: 600, marginBottom: 8 },
  dateRow: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  dateField: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#666' },
  input: { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 14 },
  fetchBtn: { padding: '8px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  disabled: { opacity: 0.55, cursor: 'not-allowed' },
  presetRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 },
  presetBtn: { background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 },
  line: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid #f0f0f0', fontSize: 13.5 },
  lineClickable: { cursor: 'pointer' },
  lineStrong: { fontWeight: 700 },
  lineDate: { fontVariantNumeric: 'tabular-nums', color: '#374151', minWidth: 84 },
  lineMid: { color: '#374151' },
  lineTimes: { color: '#6b7280', fontVariantNumeric: 'tabular-nums' },
  lineHours: { fontWeight: 600, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' },
  lineChev: { color: '#9ca3af', fontSize: 11, width: 12, textAlign: 'right' },
  otBadge: { fontSize: 11, fontWeight: 700, color: '#d97706', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '1px 6px' },
  trace: { background: '#fff', border: '1px solid #eef0f2', borderRadius: 8, padding: '8px 12px', margin: '2px 0 8px', display: 'flex', flexDirection: 'column', gap: 6 },
  traceItem: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#4b5563', lineHeight: 1.5 },
  traceHead: { fontSize: 12.5, fontWeight: 700, color: '#374151', marginTop: 4 },
  traceSub: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#4b5563', lineHeight: 1.5, paddingLeft: 14 },
  traceEmpty: { fontSize: 12.5, color: '#9ca3af', padding: '6px 12px' },
  traceLink: { marginLeft: 'auto', background: 'none', border: 'none', color: '#4338ca', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', padding: 0 },
  btnRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 18 },
  previewBtn: { padding: '10px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  csvBtn: { padding: '10px 20px', background: '#0f766e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  pdfBtn: { padding: '10px 20px', background: '#059669', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  pdfViewer: { width: '100%', height: 600, marginTop: 16, borderRadius: 8, border: '1px solid #e5e7eb' },
};
