// ─────────────────────────────────────────────────────────────────────────────
// routes/phone-routes.js
//
// Phone number provisioning API. Wraps Twilio REST for search + purchase.
//
// GET    /api/tenants/:tenantId/phone-numbers              — list assigned numbers
// GET    /api/tenants/:tenantId/available-numbers          — search Twilio inventory
// POST   /api/tenants/:tenantId/buy-number                 — purchase a number
// DELETE /api/tenants/:tenantId/phone-numbers/:number      — release a number
// ─────────────────────────────────────────────────────────────────────────────

import {
  getTenantNumbers,
  searchAvailableNumbers,
  purchaseNumber,
  releaseNumber,
  SUPPORTED_COUNTRIES,
} from '../services/phone-numbers.js';

export default async function phoneRoutes(fastify) {
  // Auth middleware - verify JWT and ensure tenant matches
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

  // ── GET /api/tenants/:tenantId/phone-numbers ──────────────────────────────
  fastify.get('/api/tenants/:tenantId/phone-numbers', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    try {
      return await getTenantNumbers(request.params.tenantId);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  // ── GET /api/tenants/:tenantId/available-numbers ──────────────────────────
  // Query params: country (default GB), areaCode (optional)
  fastify.get('/api/tenants/:tenantId/available-numbers', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { country = 'GB', areaCode } = request.query;

    if (!SUPPORTED_COUNTRIES.map(c => c.code).includes(country)) {
      return reply.status(400).send({
        error: `Country "${country}" is not supported. Supported: ${SUPPORTED_COUNTRIES.map(c => c.code).join(', ')}`,
      });
    }

    try {
      const numbers = await searchAvailableNumbers(country, areaCode || null);
      return { numbers, countries: SUPPORTED_COUNTRIES };
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  // ── POST /api/tenants/:tenantId/buy-number ────────────────────────────────
  // Body: { phoneNumber: "+441234567890" }
  fastify.post('/api/tenants/:tenantId/buy-number', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { phoneNumber } = request.body ?? {};
    if (!phoneNumber) {
      return reply.status(400).send({ error: 'phoneNumber is required in request body' });
    }

    try {
      const result = await purchaseNumber(request.params.tenantId, phoneNumber);
      return reply.status(201).send(result);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({
        error:        err.message,
        code:         err.code         ?? null,
        requiredPlan: err.requiredPlan ?? null,
        limit:        err.limit        ?? null,
      });
    }
  });

  // ── DELETE /api/tenants/:tenantId/phone-numbers/:number ───────────────────
  // :number must be URL-encoded, e.g. %2B441234567890
  fastify.delete('/api/tenants/:tenantId/phone-numbers/:number', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const phoneNumber = decodeURIComponent(request.params.number);
    try {
      return await releaseNumber(request.params.tenantId, phoneNumber);
    } catch (err) {
      return reply.status(err.statusCode ?? 500).send({ error: err.message });
    }
  });
}
