// ─────────────────────────────────────────────────────────────────────────────
// stripe/billing-routes.js
// Fastify route registrations for all billing endpoints.
// Register with: server.register(billingRoutes, { prefix: '/billing' })
// ─────────────────────────────────────────────────────────────────────────────

import {
  createCheckoutSession,
  createPortalSession,
  getSubscriptionStatus,
  changePlan,
  cancelSubscription,
  reactivateSubscription,
  listInvoices,
  handleStripeWebhook,
} from './billing.js';

export async function billingRoutes(fastify) {

  // ── POST /billing/checkout ─────────────────────────────────────────────────
  // Create a Stripe Checkout Session for new subscription signup.
  // Returns { sessionId, url } — redirect user to `url` or use Stripe.js.
  fastify.post('/checkout', {
    schema: {
      body: {
        type: 'object',
        required: ['planKey'],
        properties: {
          planKey: { type: 'string', enum: ['starter', 'pro', 'enterprise'] },
          successUrl: { type: 'string' },
          cancelUrl: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.user.tenantId; // Injected by auth middleware
    const { planKey, successUrl, cancelUrl } = request.body;

    const result = await createCheckoutSession({
      tenantId,
      planKey,
      successUrl: successUrl ?? `${process.env.PUBLIC_URL}/dashboard?checkout=success`,
      cancelUrl:  cancelUrl  ?? `${process.env.PUBLIC_URL}/onboarding?step=4`,
    });

    return reply.send(result);
  });

  // ── POST /billing/portal ───────────────────────────────────────────────────
  // Opens Stripe Customer Portal (manage payment method, view invoices, cancel).
  fastify.post('/portal', async (request, reply) => {
    const tenantId = request.user.tenantId;
    const result = await createPortalSession({
      tenantId,
      returnUrl: `${process.env.PUBLIC_URL}/settings/billing`,
    });
    return reply.send(result);
  });

  // ── GET /billing/subscription ──────────────────────────────────────────────
  // Returns current subscription status, plan, trial info, features.
  fastify.get('/subscription', async (request, reply) => {
    const tenantId = request.user.tenantId;
    const status = await getSubscriptionStatus(tenantId);
    return reply.send(status);
  });

  // ── POST /billing/upgrade ──────────────────────────────────────────────────
  // Immediately change plan (proration applied by Stripe).
  fastify.post('/upgrade', {
    schema: {
      body: {
        type: 'object',
        required: ['newPlanKey'],
        properties: { newPlanKey: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.user.tenantId;
    const result = await changePlan({ tenantId, newPlanKey: request.body.newPlanKey });
    return reply.send(result);
  });

  // ── POST /billing/cancel ───────────────────────────────────────────────────
  // Schedule subscription cancellation at end of current period.
  fastify.post('/cancel', async (request, reply) => {
    const tenantId = request.user.tenantId;
    const result = await cancelSubscription(tenantId);
    return reply.send(result);
  });

  // ── POST /billing/reactivate ───────────────────────────────────────────────
  // Undo a scheduled cancellation.
  fastify.post('/reactivate', async (request, reply) => {
    const tenantId = request.user.tenantId;
    const result = await reactivateSubscription(tenantId);
    return reply.send(result);
  });

  // ── GET /billing/invoices ──────────────────────────────────────────────────
  // List past invoices with download links.
  fastify.get('/invoices', async (request, reply) => {
    const tenantId = request.user.tenantId;
    const limit = parseInt(request.query.limit ?? '12');
    const result = await listInvoices(tenantId, limit);
    return reply.send(result);
  });

  // ── POST /billing/webhooks ─────────────────────────────────────────────────
  // Stripe sends events here. Must use raw body (not parsed JSON).
  // Fastify: exclude this route from body parsing middleware, use addContentTypeParser.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    async (req, body) => body  // Return raw buffer for webhook verification
  );

  fastify.post('/webhooks', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (!signature) {
      return reply.code(400).send({ error: 'Missing stripe-signature header' });
    }

    try {
      const result = await handleStripeWebhook(request.body, signature);
      return reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err }, 'Webhook error');
      return reply.code(400).send({ error: err.message });
    }
  });
}
