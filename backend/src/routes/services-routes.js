// ─────────────────────────────────────────────────────────────────────────────
// routes/services-routes.js
// Service catalogue CRUD.
//
// GET    /api/tenants/:tenantId/service-catalog         — list services
// POST   /api/tenants/:tenantId/service-catalog         — create service
// PUT    /api/tenants/:tenantId/service-catalog/:id     — update service
// PATCH  /api/tenants/:tenantId/service-catalog/:id/toggle — toggle active
// ─────────────────────────────────────────────────────────────────────────────

import {
  listServices,
  createService,
  updateService,
  toggleService,
} from '../services/service-catalog-service.js';

export default async function servicesRoutes(fastify) {
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

  // ── List services ──────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/service-catalog', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const activeOnly = request.query.active === 'true';
    const services = await listServices(tenantId, { activeOnly });
    return { services };
  });

  // ── Create service ─────────────────────────────────────────────────────────
  fastify.post('/api/tenants/:tenantId/service-catalog', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    try {
      const service = await createService(tenantId, request.body ?? {});
      return reply.code(201).send({ success: true, serviceId: service.id });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── Update service ─────────────────────────────────────────────────────────
  fastify.put('/api/tenants/:tenantId/service-catalog/:serviceId', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId, serviceId } = request.params;
    try {
      await updateService(tenantId, serviceId, request.body ?? {});
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── Toggle active ──────────────────────────────────────────────────────────
  fastify.patch('/api/tenants/:tenantId/service-catalog/:serviceId/toggle', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId, serviceId } = request.params;
    try {
      const updated = await toggleService(tenantId, serviceId);
      return { success: true, isActive: updated.isActive };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
