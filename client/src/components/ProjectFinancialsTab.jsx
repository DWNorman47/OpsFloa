// Project financials tab — categorized budget bar, spend breakdown,
// P&L summary. Mounts inside the existing ProjectsPage detail panel.
// Reads from /projects/:id/budget, /projects/:id/spend, /projects/:id/pnl,
// /projects/:id/expenses. tableExists guards on the server side mean
// optional modules (sub POs, etc.) don't break this view if they're
// not migrated on a given environment.

import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { SkeletonList } from './Skeleton';
import MoneyInput from './MoneyInput';
import { useConfirm } from './ConfirmDialog';
import { useToast } from '../contexts/ToastContext';
import { useT } from '../hooks/useT';
import { formatMoney } from '../utils/format';
import { silentError } from '../errorReporter';

const CATEGORIES = ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other'];

const CATEGORY_COLORS = {
  labor:       'var(--ops-page-accent)',
  materials:   '#0891b2',
  equipment:   '#7c3aed',
  subs:        '#0f3a8a',
  overhead:    '#6b7280',
  contingency: '#a16207',
  other:       '#9ca3af',
};

// formatCents kept as a local alias so existing call sites don't need
// edits. The big P&L numbers want whole-dollar rounding (no $0.00 noise
// on a $250k contract), so showCents=false.
const formatCents = (c) => formatMoney(c);

export default function ProjectFinancialsTab({ projectId }) {
  const toast = useToast();
  const t = useT();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [budget, setBudget] = useState(null);
  const [spend, setSpend] = useState(null);
  const [pnl, setPnl] = useState(null);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseForm, setExpenseForm] = useState({
    category: 'other', description: '', amount_cents: 0, tax_pct: 0, vendor: '', paid_date: new Date().toISOString().slice(0, 10),
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b, s, p, e] = await Promise.all([
        api.get(`/projects/${projectId}/budget`).then(r => r.data).catch(() => null),
        api.get(`/projects/${projectId}/spend`).then(r => r.data).catch(() => null),
        api.get(`/projects/${projectId}/pnl`).then(r => r.data).catch(() => null),
        api.get(`/projects/${projectId}/expenses`).then(r => r.data.items || []).catch(() => []),
      ]);
      setBudget(b);
      setSpend(s);
      setPnl(p);
      setExpenses(e);
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function addExpense() {
    setError(null);
    try {
      const amt = parseInt(expenseForm.amount_cents, 10);
      if (!Number.isFinite(amt) || amt < 0) {
        setError('Amount must be a positive number'); return;
      }
      if (!expenseForm.description.trim()) {
        setError('Description is required'); return;
      }
      await api.post(`/projects/${projectId}/expenses`, {
        category: expenseForm.category,
        description: expenseForm.description,
        amount_cents: amt,
        tax_pct: parseFloat(expenseForm.tax_pct) || 0,
        vendor: expenseForm.vendor || null,
        paid_date: expenseForm.paid_date || null,
      });
      toast('Expense added', 'success');
      setShowExpenseForm(false);
      setExpenseForm({ category: 'other', description: '', amount_cents: 0, tax_pct: 0, vendor: '', paid_date: new Date().toISOString().slice(0, 10) });
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to add expense'); }
  }

  async function deleteExpense(id) {
    if (!await confirm({
      title: 'Delete this expense?',
      confirmLabel: 'Delete',
      tone: 'danger',
    })) return;
    try {
      await api.delete(`/projects/${projectId}/expenses/${id}`);
      toast('Expense deleted', 'success');
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to delete expense'); }
  }

  if (loading) return <SkeletonList rows={5} />;

  return (
    <div>
      {confirmDialog}
      {error && <div style={styles.errorBox}>{error}</div>}

      {/* P&L summary */}
      {pnl && (
        <div style={styles.card}>
          <h3 style={styles.h3}>P&L Summary</h3>
          <div style={styles.statGrid}>
            <Stat label="Contract value" value={formatCents(pnl.contract_value_cents)} />
            <Stat label="Revenue billed" value={formatCents(pnl.revenue?.billed_cents)} />
            <Stat label="Cost spent" value={formatCents(pnl.cost?.spent_cents)} />
            <Stat label="Committed" value={formatCents(pnl.cost?.committed_cents)} muted />
          </div>
          <div style={{ ...styles.statGrid, marginTop: 12 }}>
            <Stat
              label="Gross profit"
              value={formatCents(pnl.gross_profit_cents)}
              valueColor={pnl.gross_profit_cents < 0 ? '#dc2626' : '#059669'}
            />
            <Stat
              label="Gross margin"
              value={pnl.gross_margin_pct == null ? '—' : `${pnl.gross_margin_pct.toFixed(1)}%`}
            />
            <Stat
              label="Projected profit"
              value={formatCents(pnl.projected_profit_cents)}
              valueColor={pnl.projected_profit_cents < 0 ? '#dc2626' : '#059669'}
            />
            <Stat
              label="Projected margin"
              value={pnl.projected_margin_pct == null ? '—' : `${pnl.projected_margin_pct.toFixed(1)}%`}
            />
          </div>
        </div>
      )}

      {/* Categorized budget + spend */}
      <div style={styles.card}>
        <h3 style={styles.h3}>Budget vs. Spend by category</h3>
        <table style={styles.table}>
          <thead>
            <tr style={styles.tableHeader}>
              <th style={styles.th}>Category</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Budget</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Spent</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Committed</th>
              <th style={styles.th}>% Used</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map(cat => {
              const b = budget?.categories?.find(c => c.category === cat) || { budget_cents: 0 };
              const sRow = spend?.categories?.find(c => c.category === cat) || { spent_cents: 0, committed_cents: 0 };
              const budgetCents = parseInt(b.budget_cents, 10) || 0;
              const spentCents = parseInt(sRow.spent_cents, 10) || 0;
              const committedCents = parseInt(sRow.committed_cents, 10) || 0;
              const used = spentCents + committedCents;
              const pct = budgetCents > 0 ? Math.min(150, Math.round((used / budgetCents) * 100)) : null;
              const pctColor = pct == null ? '#6b7280' : pct >= 100 ? '#dc2626' : pct >= 85 ? '#d97706' : '#059669';
              if (budgetCents === 0 && spentCents === 0 && committedCents === 0) return null;
              return (
                <tr key={cat} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={styles.td}>
                    <span style={{ ...styles.catPill, background: CATEGORY_COLORS[cat] + '22', color: CATEGORY_COLORS[cat] }}>
                      {cat}
                    </span>
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(budgetCents)}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(spentCents)}</td>
                  <td style={{ ...styles.td, textAlign: 'right', color: '#6b7280' }}>{formatCents(committedCents)}</td>
                  <td style={styles.td}>
                    {pct != null && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: pctColor }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: pctColor, minWidth: 40, textAlign: 'right' }}>{pct}%</span>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {budget?.total_cents > 0 && spend?.totals && (
            <tfoot>
              <tr style={{ background: '#f9fafb', borderTop: '2px solid #111827' }}>
                <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
                <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(budget.total_cents)}</td>
                <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(spend.totals.spent_cents)}</td>
                <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, color: '#6b7280' }}>{formatCents(spend.totals.committed_cents)}</td>
                <td style={{ ...styles.td, fontWeight: 700 }}>
                  {spend.totals.pct_used != null && `${spend.totals.pct_used}%`}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Manual expenses */}
      <div style={styles.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={styles.h3}>Project expenses ({expenses.length})</h3>
          <button onClick={() => setShowExpenseForm(s => !s)} style={styles.btn}>
            {showExpenseForm ? 'Cancel' : '+ Add expense'}
          </button>
        </div>

        {showExpenseForm && (
          <div style={{ background: '#fef3c7', padding: 12, borderRadius: 6, marginBottom: 12 }}>
            <div style={styles.grid3}>
              <Field label="Category">
                <select value={expenseForm.category} onChange={e => setExpenseForm(f => ({ ...f, category: e.target.value }))} style={styles.input}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Amount" required>
                <MoneyInput
                  valueCents={expenseForm.amount_cents}
                  onChange={cents => setExpenseForm(f => ({ ...f, amount_cents: cents }))}
                />
              </Field>
              <Field label="Tax %">
                <input
                  type="number" min="0" step="0.01"
                  value={expenseForm.tax_pct}
                  onChange={e => setExpenseForm(f => ({ ...f, tax_pct: e.target.value }))}
                  style={styles.input}
                />
              </Field>
              <Field label="Description" required>
                <input
                  value={expenseForm.description}
                  onChange={e => setExpenseForm(f => ({ ...f, description: e.target.value }))}
                  style={styles.input}
                />
              </Field>
              <Field label="Vendor">
                <input value={expenseForm.vendor} onChange={e => setExpenseForm(f => ({ ...f, vendor: e.target.value }))} style={styles.input} />
              </Field>
              <Field label="Paid date">
                <input type="date" value={expenseForm.paid_date} onChange={e => setExpenseForm(f => ({ ...f, paid_date: e.target.value }))} style={styles.input} />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={addExpense} style={styles.btnPrimary}>{t.add}</button>
            </div>
          </div>
        )}

        {expenses.length === 0 ? (
          <div style={{ fontSize: 14, color: '#6b7280', padding: '12px 0' }}>No manual expenses recorded.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr style={styles.tableHeader}>
                <th style={styles.th}>Date</th>
                <th style={styles.th}>Category</th>
                <th style={styles.th}>Description</th>
                <th style={styles.th}>Vendor</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Amount</th>
                <th style={{ ...styles.th, textAlign: 'right' }}>Tax</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {expenses.map(e => (
                <tr key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={styles.td}>{e.paid_date ? new Date(e.paid_date).toLocaleDateString() : '—'}</td>
                  <td style={styles.td}>
                    <span style={{ ...styles.catPill, background: CATEGORY_COLORS[e.category] + '22', color: CATEGORY_COLORS[e.category] }}>{e.category}</span>
                  </td>
                  <td style={styles.td}>{e.description}</td>
                  <td style={styles.td}>{e.vendor || '—'}</td>
                  <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(e.amount_cents)}</td>
                  <td style={{ ...styles.td, textAlign: 'right', color: '#6b7280' }}>{formatCents(e.tax_cents)}</td>
                  <td style={styles.td}>
                    <button onClick={() => deleteExpense(e.id)} style={styles.iconBtn} title="Delete">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, muted, valueColor }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: valueColor || (muted ? '#6b7280' : '#111827') }}>{value}</div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: '#6b7280', fontWeight: 600 }}>
      {label}{required && <span style={{ color: '#ef4444' }}>*</span>}
      {children}
    </label>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 8, padding: 18, marginBottom: 14, border: '1px solid #e5e7eb' },
  h3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 10 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb' },
  th: { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  td: { padding: '10px 12px', color: '#111827' },
  catPill: { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, textTransform: 'uppercase', letterSpacing: '0.04em' },
  btn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnPrimary: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  iconBtn: { background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' },
  input: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 14, fontSize: 14 },
};
