-- Advanced Payroll add-on. The paid tier for the payroll workflow: WH-347 /
-- certified payroll (folded in here), the custom Paycheck Rules (pay schedules +
-- deduction rulesets), and the deduction/net-pay/payroll-export tools. The free
-- tier keeps the plain hours register (regular/OT/prevailing) + basic export in
-- Reports; this add-on gates the advanced stuff.
--
-- Certified payroll used to be its own add-on (addon_certified_payroll,
-- superadmin-only, no Stripe). We're folding it in, so backfill any company that
-- had certified payroll into Advanced Payroll (no one has purchased it, but this
-- keeps the fold-in honest). The middleware OR-gates on both during the transition.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS addon_advanced_payroll BOOLEAN NOT NULL DEFAULT false;

UPDATE companies SET addon_advanced_payroll = true
 WHERE addon_certified_payroll = true AND addon_advanced_payroll = false;
