// ─────────────────────────────────────────────────────────────────────────────
// stripe/billing.js
// MediBook — Complete Stripe Subscription & Billing Backend
//
// Covers:
//   POST /billing/checkout                   — Create Stripe Checkout Session (legacy / tenant-first)
//   POST /api/admin/clinics/initiate         — Create checkout for admin-initiated Stripe-first flow
//   POST /billing/portal                     — Create Billing Portal Session (manage plan)
//   POST /billing/webhooks                   — Handle all Stripe lifecycle events
//   GET  /billing/subscription               — Get current subscription status
//   POST /billing/cancel                     — Cancel at period end
//   POST /billing/reactivate                 — Undo cancellation
//   GET  /billing/invoices                   — List past invoices
//   POST /billing/upgrade                    — Upgrade/downgrade plan immediately
// ─────────────────────────────────────────────────────────────────────────────

import Stripe from 'stripe';
import crypto from 'crypto';
import { prisma } from '../config/prisma.js';
import { sendOnboardingEmail } from './email.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
  typescript: false,
});



// ─── Plan Configuration ───────────────────────────────────────────────────────
// Map internal plan names to Stripe Price IDs.
// Replace with your actual Stripe Price IDs from your dashboard.
//
// Billing cycles:
//   monthly  — billed every month
//   annual   — billed once per year (2 months free = ~16.7% saving)
//
// Annual pricing:
//   professional  $199/mo × 10 = $1,990/yr  (save $398)
export const PLANS = {
  professional: {
    name: 'Professional',
    monthly: {
      priceId: process.env.STRIPE_PRICE_PROFESSIONAL_MONTHLY,
      amount: 29900,    // $299.00/month in cents
    },
    annual: {
      priceId: process.env.STRIPE_PRICE_PROFESSIONAL_ANNUAL,
      amount: 299000,   // $2,990.00/year in cents (2 months free)
      monthlyEquivalent: 24917, // $249.17/month
    },
    // Unlimited AI calls + full clinic access — staff, locations, voice agent, phone numbers included
    features: { maxStaff: -1, maxLocations: -1, voiceAgent: true, phoneNumbers: 1, integrations: true, maxCalls: -1 },
    // DB enum value
    dbPlan: 'STARTER',
  },
};

// Helper — get priceId for a plan + billing cycle combo
export function getPlanPriceId(planKey, billingCycle = 'monthly') {
  const plan = PLANS[planKey];
  if (!plan) return null;
  return plan[billingCycle]?.priceId ?? plan.monthly?.priceId ?? null;
}

// Backwards-compatible priceId lookup (used by webhook to identify plan from Stripe price ID)
export function getPlanKeyByPriceId(priceId) {
  for (const [key, plan] of Object.entries(PLANS)) {
    if (plan.monthly?.priceId === priceId || plan.annual?.priceId === priceId) return key;
  }
  return null;
}

const TRIAL_DAYS = 0;

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE CHECKOUT SESSION
//    Called during onboarding step 5.
//    Creates a Stripe Checkout with a 14-day trial + card collection.
// ─────────────────────────────────────────────────────────────────────────────
export async function createCheckoutSession({ tenantId, planKey, billingCycle = 'monthly', successUrl, cancelUrl }) {
  const plan = PLANS[planKey];
  const priceId = getPlanPriceId(planKey, billingCycle);
  if (!plan || !priceId) {
    throw new Error(`Invalid plan or missing Stripe Price ID for: ${planKey} (${billingCycle})`);
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
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      metadata: { tenantId, planKey, billingCycle },
    },
    payment_method_collection: 'always',
    billing_address_collection: 'required',
    allow_promotion_codes: true,
    success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl,
    metadata: { tenantId, planKey, billingCycle },
  });

  return { sessionId: session.id, url: session.url };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. ADMIN-INITIATED CHECKOUT (Stripe-first clinic creation)
//     Creates a Stripe Checkout for a not-yet-created clinic.
//     On completion, the webhook creates the Tenant + User + OnboardingToken.
// ─────────────────────────────────────────────────────────────────────────────
export async function createAdminCheckoutSession({ planKey, billingCycle = 'monthly', businessName, email, fullName, successUrl, cancelUrl }) {
  const plan = PLANS[planKey];
  const priceId = getPlanPriceId(planKey, billingCycle);
  if (!plan || !priceId) throw new Error(`Invalid plan or missing Stripe Price ID: ${planKey} (${billingCycle})`);

  // Create a Stripe Customer before checkout so we can link them later
  const customer = await stripe.customers.create({
    name: businessName,
    email,
    metadata: { businessName, fullName, planKey },
  });

  // Track the pending registration in DB
  const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '').slice(0, 50) || 'clinic';
  await prisma.pendingRegistration.upsert({
    where:  { email },
    create: {
      planKey, businessName, slug,
      fullName, email,
      username: slug + '-' + Date.now(),
      passwordHash: '',
      verifyCode: '000000',
      verifyExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
    update: { planKey, businessName, fullName },
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customer.id,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      metadata: { businessName, fullName, email, planKey, billingCycle },
    },
    payment_method_collection: 'always',
    billing_address_collection: 'required',
    allow_promotion_codes: true,
    success_url: successUrl + '?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl,
    metadata: { businessName, fullName, email, planKey, billingCycle },
    // Note: customer_email must NOT be set when customer is already specified
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
  const planKey = getPlanKeyByPriceId(stripeSub.items.data[0]?.price.id) ?? 'unknown';

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
    currency: stripeSub.items.data[0]?.price.currency ?? 'usd',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. UPGRADE / DOWNGRADE PLAN
//    Changes the subscription's price immediately (prorated).
// ─────────────────────────────────────────────────────────────────────────────
export async function changePlan({ tenantId, newPlanKey, billingCycle = 'monthly' }) {
  const newPlan = PLANS[newPlanKey];
  const priceId = getPlanPriceId(newPlanKey, billingCycle);
  if (!newPlan || !priceId) throw new Error('Invalid plan key');

  const sub = await prisma.subscription.findFirst({
    where: { tenantId, status: { in: ['ACTIVE', 'TRIALING'] } },
  });
  if (!sub) throw new Error('No active subscription found');

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);

  // Update the subscription item price (Stripe handles proration automatically)
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items: [{ id: stripeSub.items.data[0].id, price: priceId }],
    proration_behavior: 'create_prorations',
    metadata: { planKey: newPlanKey, billingCycle },
  });

  // Update our local record
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { stripePriceId: priceId },
  });

  // Update tenant plan
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { plan: newPlan.dbPlan ?? 'PRO' },
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

      const { tenantId, planKey, businessName, fullName, email } = session.metadata ?? {};
      const stripeSub = await stripe.subscriptions.retrieve(session.subscription);

      if (tenantId) {
        // Existing tenant (tenant created before checkout)
        // Use subscription table to detect duplicates — tenant always has stripeCustomerId set already
        const existingSub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: stripeSub.id } });
        if (existingSub) { console.log('[Stripe] Duplicate checkout.session.completed, skipping'); break; }
        await upsertSubscription(tenantId, stripeSub, planKey);
        await prisma.tenant.update({ where: { id: tenantId }, data: { stripeCustomerId: String(session.customer), stripeSubscriptionId: stripeSub.id, clinicStatus: 'live' } });
      } else if (email) {
        // Stripe-first flow (admin-initiated checkout — clinic not yet created)
        const existingTenant = await prisma.tenant.findFirst({
          where: { OR: [{ stripeCustomerId: String(session.customer) }, { stripeSubscriptionId: stripeSub.id }] },
        });
        if (existingTenant) { console.log('[Stripe] Duplicate admin checkout, skipping'); break; }

        const slug = (businessName || email).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) || 'clinic';
        const tempPassword = crypto.randomBytes(16).toString('hex');
        const { scryptSync, randomBytes } = await import('node:crypto');
        const salt = randomBytes(16).toString('hex');
        const hash = scryptSync(tempPassword, salt, 64).toString('hex');
        const passwordHash = `${salt}:${hash}`;
        const onboardingToken = crypto.randomBytes(32).toString('hex');

        await prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: {
              slug, name: businessName || email,
              plan: PLANS[planKey]?.dbPlan ?? 'PRO',
              stripeCustomerId: String(session.customer),
              stripeSubscriptionId: stripeSub.id,
              clinicStatus: 'onboarding_required',
              settings: { timezone: 'America/New_York', currency: 'usd', brandColor: '#c9903a' },
            },
          });

          const user = await tx.user.create({
            data: {
              tenantId: tenant.id,
              email,
              username: slug + '-owner',
              passwordHash,
              fullName: fullName || email,
              role: 'OWNER',
              platformRole: 'CLINIC',
              emailVerifiedAt: new Date(),
            },
          });

          await tx.staff.create({
            data: { tenantId: tenant.id, email, name: fullName || email, role: 'OWNER' },
          });

          await tx.onboardingToken.create({
            data: {
              tenantId: tenant.id,
              token: onboardingToken,
              expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
            },
          });

          await tx.subscription.upsert({
            where: { stripeSubscriptionId: stripeSub.id },
            create: {
              tenantId: tenant.id,
              stripeSubscriptionId: stripeSub.id,
              stripePriceId: stripeSub.items.data[0]?.price.id ?? '',
              status: stripeSub.status === 'trialing' ? 'TRIALING' : 'ACTIVE',
              currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
              cancelAtPeriodEnd: false,
            },
            update: {},
          });

          // Mark pending registration as processed if it exists
          await tx.pendingRegistration.deleteMany({ where: { email } });

          return { tenant, user };
        });

        // Send onboarding email (outside transaction)
        try {
          const onboardingUrl = `${process.env.PUBLIC_URL}/app/onboarding.html?token=${onboardingToken}`;
          await sendOnboardingEmail({ to: email, fullName: fullName || email, tenantName: businessName || email, onboardingUrl });
        } catch (emailErr) {
          console.error('[Stripe] Failed to send onboarding email:', emailErr.message);
        }
      }
      break;
    }

    // ── Subscription Updated (plan change, renewal, etc.) ────────────────────
    case 'customer.subscription.updated': {
      const stripeSub = event.data.object;
      const tenantId = stripeSub.metadata?.tenantId;
      if (!tenantId) break;

      const planKey = getPlanKeyByPriceId(stripeSub.items.data[0]?.price.id);

      await upsertSubscription(tenantId, stripeSub, planKey);

      // Trial ending soon (Stripe sends this 3 days before)
      if (event.data.previous_attributes?.status === 'trialing' && stripeSub.status === 'active') {
        await sendEmail({ tenantId, template: 'trial_converted' });
      }
      break;
    }

    // ── Subscription Deleted / Expired ───────────────────────────────────────
    // Sets clinicStatus = 'paused'. Does NOT delete tenant, users, or data.
    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object;

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: stripeSub.id },
        data:  { status: 'CANCELLED' },
      });

      // Find tenant by stripeCustomerId or stripeSubscriptionId
      const tenant = await prisma.tenant.findFirst({
        where: { OR: [{ stripeCustomerId: String(stripeSub.customer) }, { stripeSubscriptionId: stripeSub.id }] },
      });
      if (tenant) {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: { clinicStatus: 'paused', isActive: false },
        });
        await sendEmail({ tenantId: tenant.id, template: 'subscription_cancelled' });
      }
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

      // Find tenant by subscription ID
      const tenant = await prisma.tenant.findFirst({
        where: { OR: [{ stripeCustomerId: String(invoice.customer) }, { stripeSubscriptionId: invoice.subscription }] },
      });
      if (!tenant) break;

      // Restore paused account on successful payment
      if (tenant.clinicStatus === 'paused') {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: { clinicStatus: 'live', isActive: true },
        });
      }

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: invoice.subscription },
        data: { status: 'ACTIVE', currentPeriodEnd: new Date(stripeSub.current_period_end * 1000) },
      });

      await sendEmail({
        tenantId: tenant.id,
        template: 'payment_receipt',
        data: { amount: `$${(invoice.amount_paid / 100).toFixed(2)}`, invoiceUrl: invoice.hosted_invoice_url },
      });
      break;
    }

    // ── Payment Failed ────────────────────────────────────────────────────────
    // Pauses clinic access until payment is resolved.
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      if (!invoice.subscription) break;

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: invoice.subscription },
        data:  { status: 'PAST_DUE' },
      });

      const tenant = await prisma.tenant.findFirst({
        where: { OR: [{ stripeCustomerId: String(invoice.customer) }, { stripeSubscriptionId: invoice.subscription }] },
      });
      if (tenant) {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: { clinicStatus: 'paused' },
        });
        await sendEmail({
          tenantId: tenant.id,
          template: 'payment_failed',
          data: { updateUrl: `${process.env.PUBLIC_URL}/billing/portal` },
        });
      }
      break;
    }

    default:
      // Unhandled event type — log and ignore
      console.log(`[Stripe Webhook] Unhandled: ${event.type}`);
  }

  return { received: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Transaction-aware version for use inside prisma.$transaction
async function upsertSubscriptionTx(tx, tenantId, stripeSub, planKey) {
  const statusMap = {
    active: 'ACTIVE', trialing: 'TRIALING', past_due: 'PAST_DUE',
    canceled: 'CANCELLED', incomplete: 'PAST_DUE',
  };
  const data = {
    tenantId,
    stripeSubscriptionId: stripeSub.id,
    stripePriceId:        stripeSub.items.data[0]?.price.id ?? '',
    status:               statusMap[stripeSub.status] ?? 'ACTIVE',
    currentPeriodEnd:     new Date(stripeSub.current_period_end * 1000),
    cancelAtPeriodEnd:    stripeSub.cancel_at_period_end,
  };
  await tx.subscription.upsert({
    where:  { stripeSubscriptionId: stripeSub.id },
    create: data,
    update: data,
  });
}

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
  const dbPlan = PLANS[planKey]?.dbPlan;
  if (planKey && dbPlan) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { plan: dbPlan },
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
