const router = require('express').Router();
const Stripe = require('stripe');
const pool = require('../db');
const { requireAdmin, requirePerm } = require('../middleware/auth');
const { mapStripeStatus } = require('../constants/companyEnums');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// A company may have at most ONE subscription. Returns the company's live Stripe
// subscription (active / trialing / past_due / unpaid) or null. Verified against
// Stripe — NOT just the DB flag — so a webhook lag can't let a second checkout
// through, and a stale id for a canceled sub doesn't wrongly block a re-subscribe.
// This is the guard that stops a company accidentally buying a SECOND parallel
// subscription (which would double-bill them until someone notices + refunds).
async function liveSubscription(stripe, subscriptionId) {
  if (!subscriptionId) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status) ? sub : null;
  } catch (err) {
    return null; // not found / deleted → no live subscription
  }
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

// The base plan for a subscription = the first item whose price maps to a real
// plan. Stripe does NOT guarantee item order, so keying off items[0] (as this
// used to) would mis-read a business sub as 'free' whenever the per-worker seat
// item or an add-on sorted ahead of the base price — silently downgrading a
// paying company. 'free' only if NO item is a recognized base plan (e.g. an
// add-ons-only subscription from /checkout-addon).
function planFromItems(items) {
  for (const it of items || []) {
    const p = planFromPrice(it.price?.id);
    if (p !== 'free') return p;
  }
  return 'free';
}

// GET /stripe/plans — available pricing plans
router.get('/plans', requireAdmin, async (req, res) => {
  // Takeoff add-on amounts are read live from Stripe so they never drift from
  // the dashboard (the other plans are stable and stay hardcoded).
  const takeoff = {
    monthly_price_id: process.env.STRIPE_PRICE_TAKEOFF || null,
    annual_price_id: process.env.STRIPE_PRICE_TAKEOFF_ANNUAL || null,
    monthly: null,
    annual: null,
  };
  const planroom = {
    monthly_price_id: process.env.STRIPE_PRICE_PLANROOM || null,
    annual_price_id: process.env.STRIPE_PRICE_PLANROOM_ANNUAL || null,
    monthly: null,
    annual: null,
  };
  const storm = {
    monthly_price_id: process.env.STRIPE_PRICE_STORM || null,
    annual_price_id: process.env.STRIPE_PRICE_STORM_ANNUAL || null,
    monthly: null,
    annual: null,
  };
  const roof = {
    monthly_price_id: process.env.STRIPE_PRICE_ROOF || null,
    annual_price_id: process.env.STRIPE_PRICE_ROOF_ANNUAL || null,
    monthly: null,
    annual: null,
  };
  try {
    const stripe = getStripe();
    for (const addon of [takeoff, planroom, storm, roof]) {
      if (addon.monthly_price_id) {
        const p = await stripe.prices.retrieve(addon.monthly_price_id);
        if (p.unit_amount != null) addon.monthly = p.unit_amount / 100;
      }
      if (addon.annual_price_id) {
        const p = await stripe.prices.retrieve(addon.annual_price_id);
        if (p.unit_amount != null) addon.annual = p.unit_amount / 100;
      }
    }
  } catch (err) { req.log.warn({ err: { message: err.message } }, 'add-on price fetch failed'); }

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
    takeoff,
    planroom,
    storm,
    roof,
  });
});

// GET /stripe/status — read-only subscription info. Every admin reads this
// to render the trial-expired banner, the plan label, the QBO add-on flag,
// etc. Don't gate on manage_billing; only the actual billing actions
// (checkout, portal) need that perm.
router.get('/status', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT subscription_status, trial_ends_at, plan, addon_qbo, addon_takeoff, addon_planroom, addon_storm, addon_roof, billing_cycle, stripe_customer_id, stripe_subscription_id FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    res.json(result.rows[0] || {});
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /stripe/checkout — create Stripe Checkout session
router.post('/checkout', requireAdmin, requirePerm('manage_billing'), async (req, res) => {
  const { price_id, worker_price_id, worker_count, add_qbo, qbo_price_id, add_takeoff, takeoff_price_id, add_planroom, planroom_price_id, add_storm, storm_price_id, add_roof, roof_price_id } = req.body;
  if (!price_id) return res.status(400).json({ error: 'price_id required' });
  try {
    const stripe = getStripe();
    const company = await pool.query(
      'SELECT c.*, u.email FROM companies c JOIN users u ON u.company_id = c.id WHERE c.id = $1 AND u.role = $2 AND u.active = true LIMIT 1',
      [req.user.company_id, 'admin']
    );
    const c = company.rows[0];
    if (!c) return res.status(404).json({ error: 'Company not found' });

    // Refuse a SECOND subscription. A company that already has a live subscription must
    // change their plan / add add-ons from Manage billing (the portal, or /addon) — a fresh
    // checkout would create a parallel subscription and double-bill them. This is the guard
    // that prevents the accidental double-purchase.
    if (await liveSubscription(stripe, c.stripe_subscription_id)) {
      return res.status(409).json({
        error: 'You already have an active subscription. Change your plan or add add-ons from Manage billing instead of subscribing again.',
        code: 'has_subscription',
      });
    }

    // Takeoff is a layer on top of Plan Room — it can't be bought without it.
    // Allowed only if Plan Room is already owned or is in this same checkout.
    if (add_takeoff && !add_planroom && !c.addon_planroom) {
      return res.status(400).json({ error: 'Takeoff requires Plan Room — add Plan Room too.', code: 'planroom_required' });
    }
    // Roof Measurement likewise rides on Plan Room.
    if (add_roof && !add_planroom && !c.addon_planroom) {
      return res.status(400).json({ error: 'Roof Measurement requires Plan Room — add Plan Room too.', code: 'planroom_required' });
    }
    // Storm/Utility rides on the Takeoff add-on.
    if (add_storm && !add_takeoff && !c.addon_takeoff) {
      return res.status(400).json({ error: 'Storm/Utility requires the Takeoff add-on — add Takeoff too.', code: 'takeoff_required' });
    }

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
    if (add_takeoff && takeoff_price_id) {
      lineItems.push({ price: takeoff_price_id, quantity: 1 });
    }
    if (add_planroom && planroom_price_id) {
      lineItems.push({ price: planroom_price_id, quantity: 1 });
    }
    if (add_storm && storm_price_id) {
      lineItems.push({ price: storm_price_id, quantity: 1 });
    }
    if (add_roof && roof_price_id) {
      lineItems.push({ price: roof_price_id, quantity: 1 });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      success_url: `${process.env.APP_URL}/administration#billing`,
      cancel_url: `${process.env.APP_URL}/administration#billing`,
      // Set company_id on BOTH the session and the subscription. subscription_data
      // only reaches the Subscription; the checkout.session.completed webhook reads
      // the session's own metadata, so without this the activation handler had no
      // company_id and never stored stripe_subscription_id.
      metadata: { company_id: String(req.user.company_id) },
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

// One-click add-ons: map -> { price env getters, entitlement column }. The
// column names are a fixed allowlist (never user input) so interpolating them
// into the UPDATE below is safe.
const ADDON_PRICES = {
  qbo:      { monthly: () => process.env.STRIPE_PRICE_QBO,      annual: () => process.env.STRIPE_PRICE_QBO_ANNUAL,      col: 'addon_qbo' },
  takeoff:  { monthly: () => process.env.STRIPE_PRICE_TAKEOFF,  annual: () => process.env.STRIPE_PRICE_TAKEOFF_ANNUAL,  col: 'addon_takeoff' },
  planroom: { monthly: () => process.env.STRIPE_PRICE_PLANROOM, annual: () => process.env.STRIPE_PRICE_PLANROOM_ANNUAL, col: 'addon_planroom' },
  storm:    { monthly: () => process.env.STRIPE_PRICE_STORM,    annual: () => process.env.STRIPE_PRICE_STORM_ANNUAL,    col: 'addon_storm' },
  roof:     { monthly: () => process.env.STRIPE_PRICE_ROOF,     annual: () => process.env.STRIPE_PRICE_ROOF_ANNUAL,     col: 'addon_roof' },
};

// POST /stripe/addon — add a paid add-on to the company's EXISTING subscription
// in one click, as a prorated line item (no re-checkout). For already-subscribed
// companies; new/trial companies use the bundled checkout instead.
router.post('/addon', requireAdmin, requirePerm('manage_billing'), async (req, res) => {
  const cfg = ADDON_PRICES[req.body && req.body.addon];
  if (!cfg) return res.status(400).json({ error: 'Unknown add-on' });
  try {
    const r = await pool.query('SELECT stripe_subscription_id, addon_planroom, addon_takeoff FROM companies WHERE id = $1', [req.user.company_id]);
    const subId = r.rows[0] && r.rows[0].stripe_subscription_id;
    if (!subId) return res.status(400).json({ error: 'No active subscription — subscribe to a plan first.', code: 'no_subscription' });

    // Takeoff is a layer on top of Plan Room — it can't be added on its own.
    // One-click adds a single item, so Plan Room must already be owned.
    if (req.body.addon === 'takeoff' && !r.rows[0].addon_planroom) {
      return res.status(400).json({ error: 'Takeoff requires Plan Room — add Plan Room first.', code: 'planroom_required' });
    }
    // Roof Measurement is likewise a layer on Plan Room (the tracing lives in the
    // Plan Room app), so Plan Room must already be owned to add it one-click.
    if (req.body.addon === 'roof' && !r.rows[0].addon_planroom) {
      return res.status(400).json({ error: 'Roof Measurement requires Plan Room — add Plan Room first.', code: 'planroom_required' });
    }
    // Storm/Utility is a deep layer on the Takeoff trade — useless without it, so
    // Takeoff must already be owned to add Storm one-click.
    if (req.body.addon === 'storm' && !r.rows[0].addon_takeoff) {
      return res.status(400).json({ error: 'Storm/Utility requires the Takeoff add-on — add Takeoff first.', code: 'takeoff_required' });
    }

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subId);
    if (!['active', 'trialing', 'past_due'].includes(sub.status)) {
      return res.status(400).json({ error: 'Subscription is not active.' });
    }
    // Match the add-on's interval to the subscription's — Stripe requires every
    // recurring item in one subscription to share the same billing interval.
    const interval = sub.items.data[0] && sub.items.data[0].price.recurring && sub.items.data[0].price.recurring.interval;
    const priceId = interval === 'year' ? cfg.annual() : cfg.monthly();
    if (!priceId) return res.status(400).json({ error: 'Add-on price is not configured.' });

    // Idempotent — if the add-on is already on the subscription, just re-affirm.
    const already = sub.items.data.some(i => i.price.id === cfg.monthly() || i.price.id === cfg.annual());
    if (!already) {
      await stripe.subscriptionItems.create({
        subscription: subId, price: priceId, quantity: 1,
        proration_behavior: 'create_prorations',
      });
    }
    // Reflect immediately; the customer.subscription.updated webhook also confirms.
    await pool.query(`UPDATE companies SET ${cfg.col} = true WHERE id = $1`, [req.user.company_id]);
    res.json({ ok: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to add the add-on' }); }
});

// POST /stripe/addon/remove — remove a paid add-on from the existing
// subscription (prorated) and clear the entitlement, in one click.
router.post('/addon/remove', requireAdmin, requirePerm('manage_billing'), async (req, res) => {
  const cfg = ADDON_PRICES[req.body && req.body.addon];
  if (!cfg) return res.status(400).json({ error: 'Unknown add-on' });
  try {
    const r = await pool.query('SELECT stripe_subscription_id FROM companies WHERE id = $1', [req.user.company_id]);
    const subId = r.rows[0] && r.rows[0].stripe_subscription_id;
    if (subId) {
      const stripe = getStripe();
      const sub = await stripe.subscriptions.retrieve(subId);
      const item = sub.items.data.find(i => i.price.id === cfg.monthly() || i.price.id === cfg.annual());
      if (item) {
        if (sub.items.data.length <= 1) {
          return res.status(400).json({ error: 'This add-on is the only item on your subscription — cancel the subscription from Manage billing instead.' });
        }
        await stripe.subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' });
      }
    }
    // Clear immediately; the customer.subscription.updated webhook also confirms.
    await pool.query(`UPDATE companies SET ${cfg.col} = false WHERE id = $1`, [req.user.company_id]);
    res.json({ ok: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to remove the add-on' }); }
});

// POST /stripe/checkout-addon — buy one or more add-ons with NO base plan.
//
// For a company that wants just Plan Room and/or the Takeoff add-on without
// subscribing to a regular plan. Creates ONE Stripe subscription whose line
// items are the chosen add-ons — so a company buying both gets a single
// subscription and a single invoice, not two. The rest of the system already
// supports this shape:
//   - planFromPrice() returns 'free' for an add-on price, so the webhook writes
//     plan='free' + the entitlement flags (no mis-mapping);
//   - requirePlanToolsAddon / requireTakeoffAddon grant tool access on the
//     add-on flag alone — they never require a base plan.
// So this endpoint is the whole gap: the bundled /checkout hard-requires a base
// price, and /addon needs an already-existing subscription.
const STANDALONE_ADDONS = new Set(['takeoff', 'planroom', 'roof']); // NOT qbo (needs a plan to be useful), NOT storm (not for sale). roof rides on Plan Room (checked below).

router.post('/checkout-addon', requireAdmin, requirePerm('manage_billing'), async (req, res) => {
  const annual = !!(req.body && req.body.annual);
  // Accept a single `addon` or an array `addons`; keep only the sellable ones,
  // de-duped. Silently dropping qbo/storm here is the same allowlist the UI
  // enforces — the endpoint just doesn't trust the client.
  const requested = Array.isArray(req.body && req.body.addons)
    ? req.body.addons
    : [req.body && req.body.addon];
  const addons = [...new Set(requested.filter(a => STANDALONE_ADDONS.has(a)))];
  if (!addons.length) return res.status(400).json({ error: 'Unknown add-on' });

  const lineItems = [];
  for (const a of addons) {
    const cfg = ADDON_PRICES[a];
    const priceId = annual ? cfg.annual() : cfg.monthly();
    if (!priceId) return res.status(400).json({ error: 'Add-on price is not configured.' });
    lineItems.push({ price: priceId, quantity: 1 });
  }

  try {
    const stripe = getStripe();
    const company = await pool.query(
      'SELECT c.*, u.email FROM companies c JOIN users u ON u.company_id = c.id WHERE c.id = $1 AND u.role = $2 AND u.active = true LIMIT 1',
      [req.user.company_id, 'admin']
    );
    const c = company.rows[0];
    if (!c) return res.status(404).json({ error: 'Company not found' });

    // Takeoff is a layer on top of Plan Room — reject it unless Plan Room is
    // already owned or is being bought in this same checkout.
    if (addons.includes('takeoff') && !addons.includes('planroom') && !c.addon_planroom) {
      return res.status(400).json({ error: 'Takeoff requires Plan Room — add Plan Room too.', code: 'planroom_required' });
    }
    // Roof Measurement rides on Plan Room the same way — the standalone roof door
    // is Plan Room + Roof, so require Plan Room owned or in this same checkout.
    if (addons.includes('roof') && !addons.includes('planroom') && !c.addon_planroom) {
      return res.status(400).json({ error: 'Roof Measurement requires Plan Room — add Plan Room too.', code: 'planroom_required' });
    }

    // If they already have a LIVE subscription, adding an add-on there is the
    // right path (one prorated line item, one invoice) — a second subscription
    // would double the billing relationship. Route them to /addon. A stale
    // subscription_id from a canceled/expired sub is fine: only live states block
    // ('trial' = a trialing sub that was pre-purchased, also live).
    if (c.stripe_subscription_id && ['active', 'past_due', 'trial'].includes(c.subscription_status)) {
      return res.status(400).json({ error: 'You already have a subscription — add this from your plan instead.', code: 'has_subscription' });
    }

    let customerId = c.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: c.email, name: c.name,
        metadata: { company_id: String(req.user.company_id) },
      });
      customerId = customer.id;
      await pool.query('UPDATE companies SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.company_id]);
    }

    // A trial company can pre-buy without being charged until the trial ends —
    // same courtesy the bundled checkout extends.
    const trialEnd = c.trial_ends_at && new Date(c.trial_ends_at) > new Date()
      ? Math.floor(new Date(c.trial_ends_at).getTime() / 1000)
      : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      success_url: `${process.env.APP_URL}/administration#billing`,
      cancel_url: `${process.env.APP_URL}/administration#billing`,
      // company_id on both session and subscription (see /checkout above).
      metadata: { company_id: String(req.user.company_id) },
      subscription_data: {
        metadata: { company_id: String(req.user.company_id) },
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
    });
    res.json({ url: session.url });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to create checkout session' }); }
});

// ── Stripe Connect (invoice online payments) ─────────────────────────────────
// Separate from the subscription billing above: this lets a company connect
// their OWN Stripe account so their clients can pay invoices, money landing in
// the company's balance. We only ever store the connected-account id + a cached
// charges-enabled flag — never the company's keys.

// POST /stripe/connect/onboard — create (or reuse) the company's Standard
// connected account and return a hosted onboarding link.
router.post('/connect/onboard', requireAdmin, requirePerm('manage_billing'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const stripe = getStripe();
    const r = await pool.query('SELECT stripe_connect_account_id FROM companies WHERE id = $1', [companyId]);
    let acct = r.rows[0]?.stripe_connect_account_id;
    if (!acct) {
      const account = await stripe.accounts.create({ type: 'standard', metadata: { company_id: String(companyId) } });
      acct = account.id;
      await pool.query('UPDATE companies SET stripe_connect_account_id = $1 WHERE id = $2', [acct, companyId]);
    }
    const base = (process.env.APP_URL || 'https://opsfloa.com').replace(/\/+$/, '');
    const link = await stripe.accountLinks.create({
      account: acct,
      refresh_url: `${base}/?stripe_connect=refresh`,
      return_url: `${base}/?stripe_connect=return`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (err) {
    req.log.error({ err }, 'stripe connect onboard error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /stripe/connect/status — is the company connected AND able to accept
// charges? Caches charges_enabled on the row so the public pay path can gate
// without a Stripe round-trip.
router.get('/connect/status', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query('SELECT stripe_connect_account_id, stripe_connect_charges_enabled FROM companies WHERE id = $1', [companyId]);
    const acct = r.rows[0]?.stripe_connect_account_id;
    if (!acct) return res.json({ connected: false, charges_enabled: false });
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(acct);
    const chargesEnabled = !!account.charges_enabled;
    if (chargesEnabled !== r.rows[0].stripe_connect_charges_enabled) {
      await pool.query('UPDATE companies SET stripe_connect_charges_enabled = $1 WHERE id = $2', [chargesEnabled, companyId]);
    }
    res.json({ connected: true, charges_enabled: chargesEnabled, details_submitted: !!account.details_submitted });
  } catch (err) {
    req.log.error({ err }, 'stripe connect status error');
    res.status(500).json({ error: 'Server error' });
  }
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
    // Stripe events carry no ordering guarantee. `event.created` (epoch seconds)
    // is the watermark: the subscription-lifecycle branches only apply when this
    // event is at least as new as the last one we applied, so a stale
    // updated/deleted can't clobber newer state. (See migration 0153.)
    const eventCreated = event.created;
    if (event.type === 'checkout.session.completed') {
      if (obj.subscription) {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        // Prefer the session's own metadata; fall back to the subscription's.
        // Older sessions were created without top-level metadata, so the sub is
        // the reliable carrier of company_id there.
        const companyId = obj.metadata?.company_id || sub.metadata?.company_id;
        if (companyId) {
          const items = sub.items.data;
          const plan = planFromItems(items);
          // Pro add-on is present if any item matches the addon_qbo price IDs
          const proIds = [process.env.STRIPE_PRICE_QBO, process.env.STRIPE_PRICE_QBO_ANNUAL].filter(Boolean);
          const hasProAddon = items.some(i => proIds.includes(i.price.id));
          const takeoffIds = [process.env.STRIPE_PRICE_TAKEOFF, process.env.STRIPE_PRICE_TAKEOFF_ANNUAL].filter(Boolean);
          const hasTakeoff = items.some(i => takeoffIds.includes(i.price.id));
          const planroomIds = [process.env.STRIPE_PRICE_PLANROOM, process.env.STRIPE_PRICE_PLANROOM_ANNUAL].filter(Boolean);
          const hasPlanroom = items.some(i => planroomIds.includes(i.price.id));
          const stormIds = [process.env.STRIPE_PRICE_STORM, process.env.STRIPE_PRICE_STORM_ANNUAL].filter(Boolean);
          const hasStorm = items.some(i => stormIds.includes(i.price.id));
          const roofIds = [process.env.STRIPE_PRICE_ROOF, process.env.STRIPE_PRICE_ROOF_ANNUAL].filter(Boolean);
          const hasRoof = items.some(i => roofIds.includes(i.price.id));
          const mrrCents = calcMrrCents(items);
          await pool.query(
            `UPDATE companies SET stripe_subscription_id = $1, subscription_status = $2, plan = $3, addon_qbo = $4, addon_takeoff = $5, addon_planroom = $6, addon_storm = $7, addon_roof = $8, mrr_cents = $9, last_stripe_event_at = $11
              WHERE id = $10 AND (last_stripe_event_at IS NULL OR last_stripe_event_at <= $11)`,
            [obj.subscription, 'active', plan, hasProAddon, hasTakeoff, hasPlanroom, hasStorm, hasRoof, mrrCents, companyId, eventCreated]
          );
        }
      }
    } else if (event.type === 'customer.subscription.updated') {
      const companyId = obj.metadata?.company_id;
      if (companyId) {
        const items = obj.items?.data || [];
        const plan = planFromItems(items);
        const proIds = [process.env.STRIPE_PRICE_QBO, process.env.STRIPE_PRICE_QBO_ANNUAL].filter(Boolean);
        const hasProAddon = items.some(i => proIds.includes(i.price.id));
        const takeoffIds = [process.env.STRIPE_PRICE_TAKEOFF, process.env.STRIPE_PRICE_TAKEOFF_ANNUAL].filter(Boolean);
        const hasTakeoff = items.some(i => takeoffIds.includes(i.price.id));
        const planroomIds = [process.env.STRIPE_PRICE_PLANROOM, process.env.STRIPE_PRICE_PLANROOM_ANNUAL].filter(Boolean);
        const hasPlanroom = items.some(i => planroomIds.includes(i.price.id));
        const stormIds = [process.env.STRIPE_PRICE_STORM, process.env.STRIPE_PRICE_STORM_ANNUAL].filter(Boolean);
        const hasStorm = items.some(i => stormIds.includes(i.price.id));
        const roofIds = [process.env.STRIPE_PRICE_ROOF, process.env.STRIPE_PRICE_ROOF_ANNUAL].filter(Boolean);
        const hasRoof = items.some(i => roofIds.includes(i.price.id));
        const mrrCents = calcMrrCents(items);
        // Map Stripe's subscription status (`trialing`, `incomplete`,
        // `unpaid`, etc.) onto our internal set before writing — the
        // companies.subscription_status column is CHECK-constrained and
        // a raw Stripe value would fail the constraint. Also (re)assert
        // stripe_subscription_id (obj.id) so the sub id is never left unset if
        // the watermark ever skips the checkout.session.completed event.
        await pool.query(
          `UPDATE companies SET subscription_status = $1, plan = $2, addon_qbo = $3, addon_takeoff = $4, addon_planroom = $5, addon_storm = $6, addon_roof = $7, mrr_cents = $8, stripe_subscription_id = $10, last_stripe_event_at = $11
            WHERE id = $9 AND (last_stripe_event_at IS NULL OR last_stripe_event_at <= $11)`,
          [mapStripeStatus(obj.status), plan, hasProAddon, hasTakeoff, hasPlanroom, hasStorm, hasRoof, mrrCents, companyId, obj.id, eventCreated]
        );
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const companyId = obj.metadata?.company_id;
      if (companyId) {
        await pool.query(
          `UPDATE companies SET subscription_status = $1, addon_qbo = false, addon_takeoff = false, addon_planroom = false, addon_storm = false, addon_roof = false, last_stripe_event_at = $3
            WHERE id = $2 AND (last_stripe_event_at IS NULL OR last_stripe_event_at <= $3)`,
          ['canceled', companyId, eventCreated]
        );
      }
    } else if (event.type === 'invoice.payment_failed') {
      if (obj.subscription) {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        const companyId = sub.metadata?.company_id;
        if (companyId) {
          // Only a live-ish subscription can go past_due. Guard so a late-retried
          // payment_failed can't resurrect a company that's already canceled,
          // exempt (superadmin-comped), or trial_expired.
          await pool.query(
            `UPDATE companies SET subscription_status = 'past_due'
              WHERE id = $1 AND subscription_status IN ('active','trial','past_due')`,
            [companyId]
          );

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
                sendEmail(
                  admin.email,
                  `Payment failed for your OpsFloa subscription`,
                  `
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
                ).catch(err => req.log.warn({ err }, 'payment_failed email send failed'));
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
              sendEmail(
                admin.email,
                `Your OpsFloa trial ends ${endsStr}`,
                `
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
              ).catch(err => req.log.warn({ err }, 'trial-will-end email send failed'));
            }
          }
        } catch (err) {
          req.log.warn({ err }, 'trial_will_end processing failed (email only)');
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    // Processing failed AFTER signature verification. These branches do DB
    // writes and Stripe reads — overwhelmingly *transient* failures — so return
    // 500 and let Stripe retry (it retries for up to 3 days). Silently 200-ing
    // here dropped the state change forever, which is far worse than a few
    // retries of a genuinely deterministic failure; Sentry still surfaces the
    // latter so we can fix the root cause.
    req.log.error({ err, eventType: event?.type, eventId: event?.id }, 'stripe webhook handler failed');
    if (process.env.SENTRY_DSN) {
      const Sentry = require('@sentry/node');
      Sentry.captureException(err, {
        tags: { source: 'stripe_webhook', event_type: event?.type },
        extra: { event_id: event?.id },
      });
    }
    res.status(500).json({ error: 'webhook handler failed' });
  }
});

module.exports = router;
