// ─────────────────────────────────────────────────────────────────────────────
// routes/onboarding-routes.js
//
// GET  /api/tenants/:tenantId/onboarding/status   — check if onboarding done
// POST /api/tenants/:tenantId/onboarding/complete — save all onboarding data
// ─────────────────────────────────────────────────────────────────────────────

import {
  getOnboardingStatus,
  completeOnboarding,
} from '../services/onboarding-service.js';

export default async function onboardingRoutes(fastify) {
  const requireAuth = async (request, reply) => {
    try {
      await request.jwtVerify();
      if (request.user.tenantId !== request.params.tenantId) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  // ── GET onboarding status ─────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/onboarding/status', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    try {
      return await getOnboardingStatus(request.params.tenantId);
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  // ── POST complete onboarding ──────────────────────────────────────────────
  fastify.post('/api/tenants/:tenantId/onboarding/complete', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    try {
      const result = await completeOnboarding(request.params.tenantId, request.body ?? {});
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });
}
