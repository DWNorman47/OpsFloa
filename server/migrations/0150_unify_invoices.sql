-- Unify QuickBooks onto native invoices. The QBO-mirror `project_invoices`
-- (0070) is folded into `invoices` (0149): each mirror row becomes a native
-- invoice tagged source='qbo' carrying its qbo_invoice_id, the paid portion
-- reconstructed as an invoice_payment, plus a summary line so the native detail
-- isn't empty. The lien_waivers FK is repointed off project_invoices onto
-- invoices. After this, qbo.js writes/reads native and QBO is a pure sync layer.
--
-- `project_invoices` is intentionally LEFT IN PLACE but DORMANT (no code reads
-- or writes it) as a rollback backup — a follow-up migration drops the table
-- once this is verified in production. See docs/BACKLOG.md.
--
-- Runs as one implicit transaction (migrate.js sends the whole file to
-- pool.query), so a failure anywhere rolls the entire unification back.

-- 1. Provenance: allow source='qbo', preserve the QBO DocNumber, and add a temp
--    back-reference (old project_invoices.id) used only to repoint the FK below.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoices_source;
ALTER TABLE invoices ADD  CONSTRAINT chk_invoices_source
  CHECK (source IN ('scratch','estimate','project','qbo'));
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qbo_doc_number VARCHAR(100);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS migrated_pi_id  INTEGER;

-- 2. Copy each mirror row into invoices. invoice_number must be unique per
--    company; anchor it on the mirror PK ('QBO-IMP-<pi.id>', distinct from the
--    'QBO-<qboId>' scheme qbo.js uses for new pushes, so the two never collide).
--    Mirror money is dollars; native is cents. Status maps from payment_status.
--    Amounts are clamped to >= 0 (GREATEST(0, ...)): invoices/lines CHECK cents
--    >= 0, so a negative mirror row (a QBO credit memo) would otherwise abort the
--    entire migration and block the deploy. A credit memo lands as a $0 row.
INSERT INTO invoices
  (company_id, project_id, client_id, invoice_number, client_name_snapshot, project_name, status,
   subtotal_cents, tax_cents, total_cents, issue_date, qbo_invoice_id,
   qbo_doc_number, source, created_at, migrated_pi_id)
SELECT
  pi.company_id, pi.project_id, p.client_id,
  'QBO-IMP-' || pi.id,
  COALESCE(NULLIF(cl.name, ''), 'QuickBooks import'),
  p.name,
  CASE pi.payment_status WHEN 'paid' THEN 'paid' WHEN 'partial' THEN 'partial' ELSE 'sent' END,
  GREATEST(0, ROUND(COALESCE(pi.amount, 0) * 100))::bigint,
  0,
  GREATEST(0, ROUND(COALESCE(pi.amount, 0) * 100))::bigint,
  pi.txn_date,
  pi.qbo_invoice_id,
  pi.doc_number,
  'qbo',
  pi.created_at,
  pi.id
FROM project_invoices pi
LEFT JOIN projects p  ON p.id  = pi.project_id
LEFT JOIN clients  cl ON cl.id = p.client_id;

-- 3. A single summary line per migrated invoice, so the native detail view / PDF
--    render line items (header totals were set directly above).
INSERT INTO invoice_lines
  (invoice_id, category, sort_order, description, qty, unit_cost_cents, total_cents)
SELECT
  i.id, 'other', 0,
  COALESCE('QuickBooks invoice ' || NULLIF(pi.doc_number, ''), 'QuickBooks invoice'),
  1,
  GREATEST(0, ROUND(COALESCE(pi.amount, 0) * 100))::bigint,
  GREATEST(0, ROUND(COALESCE(pi.amount, 0) * 100))::bigint
FROM invoices i
JOIN project_invoices pi ON pi.id = i.migrated_pi_id;

-- 4. Reconstruct the paid portion (amount − balance) as an invoice_payment so
--    native balance math and the AR "collected" rollup stay correct. A 'paid'
--    row counts the full amount even if balance is NULL. amount_cents CHECK (>0)
--    naturally drops fully-unpaid rows.
INSERT INTO invoice_payments
  (invoice_id, company_id, amount_cents, paid_date, method, notes)
SELECT
  i.id, i.company_id,
  ROUND((COALESCE(pi.amount, 0) - CASE WHEN pi.payment_status = 'paid'
         THEN 0 ELSE COALESCE(pi.balance, pi.amount) END) * 100)::bigint,
  COALESCE(pi.txn_date, i.created_at::date, CURRENT_DATE),
  'other',
  'QuickBooks payment (imported)'
FROM invoices i
JOIN project_invoices pi ON pi.id = i.migrated_pi_id
WHERE ROUND((COALESCE(pi.amount, 0) - CASE WHEN pi.payment_status = 'paid'
       THEN 0 ELSE COALESCE(pi.balance, pi.amount) END) * 100)::bigint > 0;

-- 5. Repoint lien_waivers.invoice_id off project_invoices(id) onto invoices(id):
--    drop the old FK, remap the ids via migrated_pi_id, null any that didn't map
--    (defensive — the FK was ON DELETE SET NULL so danglers are already NULL),
--    then add the new FK.
ALTER TABLE lien_waivers DROP CONSTRAINT IF EXISTS lien_waivers_invoice_id_fkey;
UPDATE lien_waivers lw
   SET invoice_id = i.id
  FROM invoices i
 WHERE i.migrated_pi_id = lw.invoice_id
   AND lw.invoice_id IS NOT NULL;
UPDATE lien_waivers lw
   SET invoice_id = NULL
 WHERE lw.invoice_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = lw.invoice_id);
ALTER TABLE lien_waivers
  ADD CONSTRAINT lien_waivers_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

-- 6. Drop the temp back-reference. project_invoices stays dormant as backup.
ALTER TABLE invoices DROP COLUMN IF EXISTS migrated_pi_id;
