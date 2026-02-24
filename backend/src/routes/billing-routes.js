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
} from '../services/billing.js';

export async function billingRoutes(fastify) {

  // ── POST /billing/checkout ─────────────────────────────────────────────────
  // Create a Stripe Checkout Session for new subscription signup.
  // Returns { sessionId, url } — redirect user to `url` or use Stripe.js.
  fastify.post('/checkout', {
    preHandler: [fastify.authenticate],
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
    const tenantId = request.user.tenantId;
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
  fastify.post('/portal', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const tenantId = request.user.tenantId;
    const result = await createPortalSession({
      tenantId,
      returnUrl: `${process.env.PUBLIC_URL}/settings/billing`,
    });
    return reply.send(result);
  });

  // ── GET /billing/subscription ──────────────────────────────────────────────
  // Returns current subscription status, plan, trial info, features.
  fastify.get('/subscription', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const tenantId = request.user.tenantId;
    const status = await getSubscriptionStatus(tenantId);
    return reply.send(status);
  });

  // ── POST /billing/upgrade ──────────────────────────────────────────────────
  // Immediately change plan (proration applied by Stripe).
  fastify.post('/upgrade', {
    preHandler: [fastify.authenticate],
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
  fastify.post('/cancel', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const tenantId = request.user.tenantId;
    const result = await cancelSubscription(tenantId);
    return reply.send(result);
  });

  // ── POST /billing/reactivate ───────────────────────────────────────────────
  // Undo a scheduled cancellation.
  fastify.post('/reactivate', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const tenantId = request.user.tenantId;
    const result = await reactivateSubscription(tenantId);
    return reply.send(result);
  });

  // ── GET /billing/invoices ──────────────────────────────────────────────────
  // List past invoices with download links.
  fastify.get('/invoices', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const tenantId = request.user.tenantId;
    const limit = parseInt(request.query.limit ?? '12');
    const result = await listInvoices(tenantId, limit);
    return reply.send(result);
  });

  // ── POST /billing/webhooks ─────────────────────────────────────────────────
  // Stripe sends events here. Must use raw body (not parsed JSON).
  // Use onRequest hook to capture raw body before Fastify parses it.
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url === '/billing/webhooks') {
      // Raw body capture for Stripe signature verification
      const chunks = [];
      request.rawBody = await new Promise((resolve, reject) => {
        request.raw.on('data', chunk => chunks.push(chunk));
        request.raw.on('end', () => resolve(Buffer.concat(chunks)));
        request.raw.on('error', reject);
      });
    }
  });

  fastify.post('/webhooks', async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    if (!signature) {
      return reply.code(400).send({ error: 'Missing stripe-signature header' });
    }

    try {
      const result = await handleStripeWebhook(request.rawBody, signature);
      return reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err }, 'Webhook error');
      return reply.code(400).send({ error: err.message });
    }
  });
}
