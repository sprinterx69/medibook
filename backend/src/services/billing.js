// ─────────────────────────────────────────────────────────────────────────────
// stripe/billing.js
// MediBook — Complete Stripe Subscription & Billing Backend
//
// Covers:
//   POST /billing/checkout          — Create Stripe Checkout Session (trial start)
//   POST /billing/portal            — Create Billing Portal Session (manage plan)
//   POST /billing/webhooks          — Handle all Stripe lifecycle events
//   GET  /billing/subscription      — Get current subscription status
//   POST /billing/cancel            — Cancel at period end
//   POST /billing/reactivate        — Undo cancellation
//   GET  /billing/invoices          — List past invoices
//   POST /billing/upgrade           — Upgrade/downgrade plan immediately
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
  typescript: false,
});

const prisma = new PrismaClient();

// ─── Plan Configuration ───────────────────────────────────────────────────────
// Map internal plan names to Stripe Price IDs.
// Replace with your actual Stripe Price IDs from your dashboard.
export const PLANS = {
  starter: {
    name: 'Starter',
    priceId: process.env.STRIPE_PRICE_STARTER,   // e.g. price_1Pxxx
    amount: 4900,     // £49.00 in pence
    features: { maxStaff: 2, maxLocations: 1, voiceAgent: false },
  },
  pro: {
    name: 'Pro',
    priceId: process.env.STRIPE_PRICE_PRO,
    amount: 12900,    // £129.00
    features: { maxStaff: -1, maxLocations: 3, voiceAgent: true },
  },
  enterprise: {
    name: 'Enterprise',
    priceId: process.env.STRIPE_PRICE_ENTERPRISE,
    amount: null,     // Custom pricing
    features: { maxStaff: -1, maxLocations: -1, voiceAgent: true },
  },
};

const TRIAL_DAYS = 30;

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE CHECKOUT SESSION
//    Called during onboarding step 5.
//    Creates a Stripe Checkout with a 14-day trial + card collection.
// ─────────────────────────────────────────────────────────────────────────────
export async function createCheckoutSession({ tenantId, planKey, successUrl, cancelUrl }) {
  const plan = PLANS[planKey];
  if (!plan || !plan.priceId) {
    throw new Error(`Invalid plan or missing Stripe Price ID for: ${planKey}`);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, stripeCustomerId: true },
  });
  if (!tenant) throw new Error('Tenant not found');

  // Create or reuse Stripe Customer
  let customerId = tenant.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.name,
      metadata: { tenantId },
    });
    customerId = customer.id;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { tenantId, planKey },
    },
    payment_method_collection: 'always',     // Collect card even during trial
    billing_address_collection: 'required',
    allow_promotion_codes: true,
    success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl,
    metadata: { tenantId, planKey },
    // Customise Stripe-hosted page
    custom_text: {
      submit: { message: 'Your 30-day free trial starts today. No charge until the trial ends.' },
    },
  });

  return { sessionId: session.id, url: session.url };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. BILLING PORTAL SESSION
//    Opens Stripe's hosted billing portal where customers can:
//    - Update payment method
//    - View/download invoices
//    - Cancel or change plan
// ─────────────────────────────────────────────────────────────────────────────
export async function createPortalSession({ tenantId, returnUrl }) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeCustomerId: true },
  });

  if (!tenant?.stripeCustomerId) {
    throw new Error('No Stripe customer found for this tenant');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET SUBSCRIPTION STATUS
//    Returns the current plan, status, trial end, next billing date, etc.
// ─────────────────────────────────────────────────────────────────────────────
export async function getSubscriptionStatus(tenantId) {
  const sub = await prisma.subscription.findFirst({
    where: { tenantId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub) {
    return { hasSubscription: false, plan: 'none', status: 'none' };
  }

  // Fetch live data from Stripe to ensure accuracy
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);

  // Identify plan from price ID
  const planKey = Object.entries(PLANS).find(
    ([, p]) => p.priceId === stripeSub.items.data[0]?.price.id
  )?.[0] ?? 'unknown';

  return {
    hasSubscription: true,
    plan: planKey,
    planName: PLANS[planKey]?.name ?? 'Unknown',
    status: stripeSub.status,                   // active | trialing | past_due | cancelled
    trialEnd: stripeSub.trial_end
      ? new Date(stripeSub.trial_end * 1000).toISOString()
      : null,
    currentPeriodEnd: new Date(stripeSub.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    features: PLANS[planKey]?.features ?? {},
    amount: stripeSub.items.data[0]?.price.unit_amount ?? 0,
    currency: stripeSub.items.data[0]?.price.currency ?? 'gbp',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. UPGRADE / DOWNGRADE PLAN
//    Changes the subscription's price immediately (prorated).
// ─────────────────────────────────────────────────────────────────────────────
export async function changePlan({ tenantId, newPlanKey }) {
  const newPlan = PLANS[newPlanKey];
  if (!newPlan?.priceId) throw new Error('Invalid plan key');

  const sub = await prisma.subscription.findFirst({
    where: { tenantId, status: { in: ['ACTIVE', 'TRIALING'] } },
  });
  if (!sub) throw new Error('No active subscription found');

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);

  // Update the subscription item price (Stripe handles proration automatically)
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items: [{ id: stripeSub.items.data[0].id, price: newPlan.priceId }],
    proration_behavior: 'create_prorations',
    metadata: { planKey: newPlanKey },
  });

  // Update our local record
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { stripePriceId: newPlan.priceId },
  });

  // Update tenant plan
  const planEnumMap = { starter: 'STARTER', pro: 'PRO', enterprise: 'ENTERPRISE' };
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { plan: planEnumMap[newPlanKey] ?? 'PRO' },
  });

  return { success: true, plan: newPlanKey, status: updated.status };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CANCEL / REACTIVATE
// ─────────────────────────────────────────────────────────────────────────────
export async function cancelSubscription(tenantId) {
  const sub = await prisma.subscription.findFirst({
    where: { tenantId, status: { in: ['ACTIVE', 'TRIALING'] } },
  });
  if (!sub) throw new Error('No active subscription to cancel');

  // Cancel at end of period (not immediately) — best practice for SaaS
  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: true },
  });

  return { success: true, message: 'Subscription will cancel at end of billing period.' };
}

export async function reactivateSubscription(tenantId) {
  const sub = await prisma.subscription.findFirst({
    where: { tenantId, cancelAtPeriodEnd: true },
  });
  if (!sub) throw new Error('No cancelled subscription to reactivate');

  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    cancel_at_period_end: false,
  });

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: false },
  });

  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. LIST INVOICES
// ─────────────────────────────────────────────────────────────────────────────
export async function listInvoices(tenantId, limit = 12) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeCustomerId: true },
  });
  if (!tenant?.stripeCustomerId) return { invoices: [] };

  const invoices = await stripe.invoices.list({
    customer: tenant.stripeCustomerId,
    limit,
    status: 'paid',
  });

  return {
    invoices: invoices.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      date: new Date(inv.created * 1000).toISOString(),
      amount: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      pdfUrl: inv.invoice_pdf,
      hostedUrl: inv.hosted_invoice_url,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. STRIPE WEBHOOK HANDLER
//    This is the most critical piece — handles all Stripe lifecycle events.
//    Must be mounted with raw body parsing (not JSON) for signature verification.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleStripeWebhook(rawBody, signature) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  console.log(`[Stripe Webhook] ${event.type}`);

  switch (event.type) {

    // ── Trial / Subscription Started ────────────────────────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') break;

      const { tenantId, planKey } = session.metadata ?? {};
      if (!tenantId) break;

      const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
      await upsertSubscription(tenantId, stripeSub, planKey);

      // Send welcome email
      await sendEmail({
        tenantId,
        template: 'welcome',
        data: { planName: PLANS[planKey]?.name ?? 'Pro', trialDays: TRIAL_DAYS },
      });
      break;
    }

    // ── Subscription Updated (plan change, renewal, etc.) ────────────────────
    case 'customer.subscription.updated': {
      const stripeSub = event.data.object;
      const tenantId = stripeSub.metadata?.tenantId;
      if (!tenantId) break;

      const planKey = Object.entries(PLANS).find(
        ([, p]) => p.priceId === stripeSub.items.data[0]?.price.id
      )?.[0];

      await upsertSubscription(tenantId, stripeSub, planKey);

      // Trial ending soon (Stripe sends this 3 days before)
      if (event.data.previous_attributes?.status === 'trialing' && stripeSub.status === 'active') {
        await sendEmail({ tenantId, template: 'trial_converted' });
      }
      break;
    }

    // ── Subscription Deleted / Expired ───────────────────────────────────────
    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object;
      const tenantId = stripeSub.metadata?.tenantId;
      if (!tenantId) break;

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: stripeSub.id },
        data: { status: 'CANCELLED' },
      });

      await prisma.tenant.updateMany({
        where: { id: tenantId },
        data: { plan: 'STARTER', isActive: true }, // Downgrade but keep account alive
      });

      await sendEmail({ tenantId, template: 'subscription_cancelled' });
      break;
    }

    // ── Trial Ending Reminder (sent by Stripe 3 days before) ─────────────────
    case 'customer.subscription.trial_will_end': {
      const stripeSub = event.data.object;
      const tenantId = stripeSub.metadata?.tenantId;
      if (!tenantId) break;

      const trialEndDate = new Date(stripeSub.trial_end * 1000).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
      await sendEmail({ tenantId, template: 'trial_ending', data: { trialEndDate } });
      break;
    }

    // ── Payment Succeeded ─────────────────────────────────────────────────────
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      if (!invoice.subscription) break;

      const stripeSub = await stripe.subscriptions.retrieve(invoice.subscription);
      const tenantId = stripeSub.metadata?.tenantId;
      if (!tenantId) break;

      // Record payment in our DB
      await prisma.payment.create({
        data: {
          tenantId,
          clientId: await getOwnerClientId(tenantId),
          amountCents: invoice.amount_paid,
          currency: invoice.currency,
          type: 'FULL_PAYMENT',
          status: 'PAID',
          stripeInvoiceId: invoice.id,
        },
      }).catch(() => {}); // Non-fatal if owner clientId not set up yet

      await sendEmail({
        tenantId,
        template: 'payment_receipt',
        data: { amount: `£${(invoice.amount_paid / 100).toFixed(2)}`, invoiceUrl: invoice.hosted_invoice_url },
      });
      break;
    }

    // ── Payment Failed ────────────────────────────────────────────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const stripeSub = await stripe.subscriptions.retrieve(invoice.subscription);
      const tenantId = stripeSub.metadata?.tenantId;
      if (!tenantId) break;

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: invoice.subscription },
        data: { status: 'PAST_DUE' },
      });

      await sendEmail({
        tenantId,
        template: 'payment_failed',
        data: { updateUrl: `${process.env.PUBLIC_URL}/billing/portal` },
      });
      break;
    }

    default:
      // Unhandled event type — log and ignore
      console.log(`[Stripe Webhook] Unhandled: ${event.type}`);
  }

  return { received: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertSubscription(tenantId, stripeSub, planKey) {
  const statusMap = {
    active: 'ACTIVE',
    trialing: 'TRIALING',
    past_due: 'PAST_DUE',
    canceled: 'CANCELLED',
    incomplete: 'PAST_DUE',
  };

  const data = {
    tenantId,
    stripeSubscriptionId: stripeSub.id,
    stripePriceId: stripeSub.items.data[0]?.price.id ?? '',
    status: statusMap[stripeSub.status] ?? 'ACTIVE',
    currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
  };

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: stripeSub.id },
    create: data,
    update: data,
  });

  // Sync tenant plan
  const planEnumMap = { starter: 'STARTER', pro: 'PRO', enterprise: 'ENTERPRISE' };
  if (planKey && planEnumMap[planKey]) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { plan: planEnumMap[planKey] },
    });
  }
}

async function getOwnerClientId(tenantId) {
  const staff = await prisma.staff.findFirst({
    where: { tenantId, role: 'OWNER' },
    select: { id: true },
  });
  return staff?.id ?? null;
}

// Stub — replace with your email service (Resend, SendGrid, etc.)
async function sendEmail({ tenantId, template, data = {} }) {
  console.log(`[Email] Sending "${template}" to tenant ${tenantId}`, data);
  // Example with Resend:
  // await resend.emails.send({
  //   from: 'MediBook <hello@medibook.io>',
  //   to: ownerEmail,
  //   subject: EMAIL_TEMPLATES[template].subject,
  //   html: renderTemplate(template, data),
  // });
}
