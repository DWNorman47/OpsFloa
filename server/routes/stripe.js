const router = require('express').Router();
const Stripe = require('stripe');
const pool = require('../db');
const { requireAdmin, requirePerm } = require('../middleware/auth');
const { mapStripeStatus } = require('../constants/companyEnums');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Sum monthly revenue in cents from Stripe subscription items (normalises annual → monthly)
function calcMrrCents(items) {
  return items.reduce((sum, item) => {
    const amount = item.price?.unit_amount ?? 0;
    const qty = item.quantity ?? 1;
    const interval = item.price?.recurring?.interval;
    const monthly = interval === 'year' ? Math.round(amount / 12) : amount;
    return sum + monthly * qty;
  }, 0);
}

function planFromPrice(priceId) {
  if (priceId === process.env.STRIPE_PRICE_BUSINESS_BASE ||
      priceId === process.env.STRIPE_PRICE_BUSINESS_BASE_ANNUAL) return 'business';
  if (priceId === process.env.STRIPE_PRICE_STARTER ||
      priceId === process.env.STRIPE_PRICE_STARTER_ANNUAL) return 'starter';
  return 'free';
}

// GET /stripe/plans — available pricing plans
router.get('/plans', requireAdmin, (req, res) => {
  res.json({
    starter: {
      monthly_price_id: process.env.STRIPE_PRICE_STARTER,
      annual_price_id: process.env.STRIPE_PRICE_STARTER_ANNUAL,
      monthly: 20,
      annual: 200, // 2 months free
    },
    business: {
      base_monthly_price_id: process.env.STRIPE_PRICE_BUSINESS_BASE,
      base_annual_price_id: process.env.STRIPE_PRICE_BUSINESS_BASE_ANNUAL,
      worker_monthly_price_id: process.env.STRIPE_PRICE_BUSINESS_WORKER,
      worker_annual_price_id: process.env.STRIPE_PRICE_BUSINESS_WORKER_ANNUAL,
      base_monthly: 35,
      base_annual: 350, // 2 months free
      per_worker_monthly: 2,
      per_worker_annual: 20,
    },
    qbo: {
      monthly_price_id: process.env.STRIPE_PRICE_QBO,
      annual_price_id: process.env.STRIPE_PRICE_QBO_ANNUAL,
      monthly: 25,
      annual: 250, // 2 months free
    },
  });
});

// GET /stripe/status — read-only subscription info. Every admin reads this
// to render the trial-expired banner, the plan label, the QBO add-on flag,
// etc. Don't gate on manage_billing; only the actual billing actions
// (checkout, portal) need that perm.
router.get('/status', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT subscription_status, trial_ends_at, plan, addon_qbo, billing_cycle, stripe_customer_id, stripe_subscription_id FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    res.json(result.rows[0] || {});
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /stripe/checkout — create Stripe Checkout session
router.post('/checkout', requireAdmin, requirePerm('manage_billing'), async (req, res) => {
  const { price_id, worker_price_id, worker_count, add_qbo, qbo_price_id } = req.body;
  if (!price_id) return res.status(400).json({ error: 'price_id required' });
  try {
    const stripe = getStripe();
    const company = await pool.query(
      'SELECT c.*, u.email FROM companies c JOIN users u ON u.company_id = c.id WHERE c.id = $1 AND u.role = $2 AND u.active = true LIMIT 1',
      [req.user.company_id, 'admin']
    );
    const c = company.rows[0];
    if (!c) return res.status(404).json({ error: 'Company not found' });

    let customerId = c.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: c.email,
        name: c.name,
        metadata: { company_id: String(req.user.company_id) },
      });
      customerId = customer.id;
      await pool.query('UPDATE companies SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.company_id]);
    }

    const trialEnd = c.trial_ends_at && new Date(c.trial_ends_at) > new Date()
      ? Math.floor(new Date(c.trial_ends_at).getTime() / 1000)
      : undefined;

    // Build line items — base plan + optional per-worker + optional pro add-on
    const lineItems = [{ price: price_id, quantity: 1 }];
    if (worker_price_id && worker_count > 0) {
      lineItems.push({ price: worker_price_id, quantity: parseInt(worker_count, 10) });
    }
    if (add_qbo && qbo_price_id) {
      lineItems.push({ price: qbo_price_id, quantity: 1 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      success_url: `${process.env.APP_URL}/administration#billing`,
      cancel_url: `${process.env.APP_URL}/administration#billing`,
      subscription_data: {
        metadata: { company_id: String(req.user.company_id) },
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
    });
    res.json({ url: session.url });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to create checkout session' }); }
});

// POST /stripe/portal — customer billing portal
router.post('/portal', requireAdmin, requirePerm('manage_billing'), async (req, res) => {
  try {
    const stripe = getStripe();
    const company = await pool.query('SELECT stripe_customer_id FROM companies WHERE id = $1', [req.user.company_id]);
    const customerId = company.rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No billing account found. Subscribe first.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.APP_URL}/administration#billing`,
    });
    res.json({ url: session.url });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to open billing portal' }); }
});

// POST /stripe/webhook
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    req.log.warn({ err: { message: err.message } }, 'stripe webhook signature invalid');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const companyId = obj.metadata?.company_id;
      if (companyId && obj.subscription) {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        const items = sub.items.data;
        const plan = planFromPrice(items[0]?.price?.id);
        // Pro add-on is present if any item matches the addon_qbo price IDs
        const proIds = [process.env.STRIPE_PRICE_QBO, process.env.STRIPE_PRICE_QBO_ANNUAL].filter(Boolean);
        const hasProAddon = items.some(i => proIds.includes(i.price.id));
        const mrrCents = calcMrrCents(items);
        await pool.query(
          'UPDATE companies SET stripe_subscription_id = $1, subscription_status = $2, plan = $3, addon_qbo = $4, mrr_cents = $5 WHERE id = $6',
          [obj.subscription, 'active', plan, hasProAddon, mrrCents, companyId]
        );
      }
    } else if (event.type === 'customer.subscription.updated') {
      const companyId = obj.metadata?.company_id;
      if (companyId) {
        const items = obj.items?.data || [];
        const plan = planFromPrice(items[0]?.price?.id);
        const proIds = [process.env.STRIPE_PRICE_QBO, process.env.STRIPE_PRICE_QBO_ANNUAL].filter(Boolean);
        const hasProAddon = items.some(i => proIds.includes(i.price.id));
        const mrrCents = calcMrrCents(items);
        // Map Stripe's subscription status (`trialing`, `incomplete`,
        // `unpaid`, etc.) onto our internal set before writing — the
        // companies.subscription_status column is CHECK-constrained and
        // a raw Stripe value would fail the constraint.
        await pool.query(
          'UPDATE companies SET subscription_status = $1, plan = $2, addon_qbo = $3, mrr_cents = $4 WHERE id = $5',
          [mapStripeStatus(obj.status), plan, hasProAddon, mrrCents, companyId]
        );
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const companyId = obj.metadata?.company_id;
      if (companyId) {
        await pool.query(
          'UPDATE companies SET subscription_status = $1, addon_qbo = false WHERE id = $2',
          ['canceled', companyId]
        );
      }
    } else if (event.type === 'invoice.payment_failed') {
      if (obj.subscription) {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        const companyId = sub.metadata?.company_id;
        if (companyId) {
          await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', ['past_due', companyId]);

          // Email every admin so they can update the payment method before
          // the card is retried-then-stopped and their workers get locked out.
          try {
            const [companyRes, adminsRes] = await Promise.all([
              pool.query('SELECT name FROM companies WHERE id = $1', [companyId]),
              pool.query(
                `SELECT email, full_name FROM users
                  WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true AND email IS NOT NULL`,
                [companyId]
              ),
            ]);
            const company = companyRes.rows[0];
            if (company && adminsRes.rows.length > 0) {
              const amountStr = obj.amount_due != null
                ? `$${(obj.amount_due / 100).toFixed(2)}`
                : null;
              const { sendEmail } = require('../email');
              for (const admin of adminsRes.rows) {
                sendEmail({
                  to: admin.email,
                  subject: `Payment failed for your OpsFloa subscription`,
                  html: `
                    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
                      <h2 style="color:#b91c1c;margin-bottom:8px">Payment failed</h2>
                      <p style="color:#444">Hi ${admin.full_name || ''}, we weren't able to charge your payment method${amountStr ? ` for ${amountStr}` : ''} for <strong>${company.name}</strong>.</p>
                      <p style="color:#444">Stripe will automatically retry, but to avoid losing access, please update your payment method in billing.</p>
                      <a href="${process.env.APP_URL}/administration#billing"
                         style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px">
                        Update payment method
                      </a>
                      <p style="color:#9ca3af;font-size:12px;margin-top:24px">If the retry succeeds, no action is needed and you'll stay on your current plan.</p>
                    </div>
                  `,
                }).catch(err => req.log.warn({ err }, 'payment_failed email send failed'));
              }
            }
          } catch (err) {
            req.log.warn({ err }, 'payment_failed notification failed (status already flipped)');
          }
        }
      }
    } else if (event.type === 'invoice.payment_succeeded') {
      // Counterpart to invoice.payment_failed: a previously past_due
      // subscription whose latest invoice just cleared should flip back to
      // 'active'. Skip when there's no subscription (one-off invoices).
      if (obj.subscription) {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        const companyId = sub.metadata?.company_id;
        if (companyId) {
          await pool.query(
            `UPDATE companies
                SET subscription_status = 'active'
              WHERE id = $1
                AND subscription_status IN ('past_due', 'trial', 'trial_expired')`,
            [companyId]
          );
        }
      }
    } else if (event.type === 'customer.subscription.trial_will_end') {
      // Fires ~3 days before a trial ends. Email the company's admins so
      // they're not surprised when access cuts off. No DB change needed —
      // the trial is still active until trial_ends_at.
      const companyId = obj.metadata?.company_id;
      if (companyId) {
        try {
          const companyRes = await pool.query('SELECT name, trial_ends_at FROM companies WHERE id = $1', [companyId]);
          const adminsRes  = await pool.query(
            `SELECT email, full_name FROM users
              WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true AND email IS NOT NULL`,
            [companyId]
          );
          const company = companyRes.rows[0];
          if (company && adminsRes.rows.length > 0) {
            const endsStr = new Date(company.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            const { sendEmail } = require('../email');
            for (const admin of adminsRes.rows) {
              sendEmail({
                to: admin.email,
                subject: `Your OpsFloa trial ends ${endsStr}`,
                html: `
                  <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
                    <h2 style="color:#1a56db;margin-bottom:8px">Trial ending soon</h2>
                    <p style="color:#444">Hi ${admin.full_name || ''}, your OpsFloa trial for <strong>${company.name}</strong> ends on <strong>${endsStr}</strong>.</p>
                    <p style="color:#444">To keep your team's access, add a payment method in Administration → Billing before the trial ends.</p>
                    <a href="${process.env.APP_URL}/administration#billing"
                       style="display:inline-block;background:#1a56db;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px">
                      Go to billing
                    </a>
                  </div>
                `,
              }).catch(err => req.log.warn({ err }, 'trial-will-end email send failed'));
            }
          }
        } catch (err) {
          req.log.warn({ err }, 'trial_will_end processing failed (email only)');
        }
      }
    }
  } catch (err) {
    // Webhook processing failed after signature verification succeeded.
    // Log + Sentry so we hear about chronically failing subscription events
    // (Stripe retries for up to 3 days before giving up). Still return 200
    // so Stripe doesn't retry a deterministic failure, unless the failure
    // was transient (5xx from our DB) — we can tune this later.
    req.log.error({ err, eventType: event?.type, eventId: event?.id }, 'stripe webhook handler failed');
    if (process.env.SENTRY_DSN) {
      const Sentry = require('@sentry/node');
      Sentry.captureException(err, {
        tags: { source: 'stripe_webhook', event_type: event?.type },
        extra: { event_id: event?.id },
      });
    }
  }

  res.json({ received: true });
});

module.exports = router;
