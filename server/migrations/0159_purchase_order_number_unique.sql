-- Repair any legacy duplicate PO numbers before enforcing the document-number invariant.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY company_id, po_number ORDER BY id) AS duplicate_rank
    FROM purchase_orders
)
UPDATE purchase_orders po
   SET po_number = 'PO-DUP-' || po.id
  FROM ranked r
 WHERE po.id = r.id
   AND r.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_company_number
  ON purchase_orders(company_id, po_number);
