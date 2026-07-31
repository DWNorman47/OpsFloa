-- Stripe Connect: let a company connect their OWN Stripe account so their clients
-- can pay invoices online, with the money landing in the company's balance (not
-- OpsFloa's). We store only the connected-account id and a cached charges-enabled
-- flag — never the company's Stripe keys. Distinct from stripe_customer_id /
-- stripe_subscription_id, which are OpsFloa's OWN subscription billing.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_connect_account_id       VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_connect_charges_enabled  BOOLEAN NOT NULL DEFAULT false;
