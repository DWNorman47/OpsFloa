-- Let an admin convert a public service request into a Work Order (a service
-- call) as an alternative to a full Project. Nullable FK, cleared if the work
-- order is deleted. Idempotent.

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS converted_work_order_id INTEGER REFERENCES work_orders(id) ON DELETE SET NULL;
