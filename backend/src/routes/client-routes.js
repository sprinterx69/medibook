// ─────────────────────────────────────────────────────────────────────────────
// routes/client-routes.js
//
// GET  /api/tenants/:tenantId/clients              — list / search
// GET  /api/tenants/:tenantId/clients/stats        — stat cards
// GET  /api/tenants/:tenantId/clients/:clientId    — single client + history
// POST /api/tenants/:tenantId/clients              — create client
// PATCH /api/tenants/:tenantId/clients/:clientId   — update notes/tags
// ─────────────────────────────────────────────────────────────────────────────

import { listClients, getClientStats, getClientById, createClient, updateClient } from '../services/client-service.js';

export default async function clientRoutes(fastify) {
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

  // ── List clients ───────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/clients', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const { search = '', filter = 'all', sort = 'name', order = 'asc', limit } = request.query;

    const clients = await listClients(tenantId, {
      search,
      filter,
      sort,
      order,
      limit: limit ? parseInt(limit) : 200,
    });
    return { clients, count: clients.length };
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/clients/stats', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const stats = await getClientStats(tenantId);
    return stats;
  });

  // ── Single client ──────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/clients/:clientId', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId, clientId } = request.params;
    const client = await getClientById(tenantId, clientId);
    if (!client) return reply.code(404).send({ error: 'Client not found' });
    return client;
  });

  // ── Create client ──────────────────────────────────────────────────────────
  fastify.post('/api/tenants/:tenantId/clients', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const { fullName, email, phone, notes } = request.body ?? {};

    if (!fullName?.trim()) {
      return reply.code(400).send({ error: 'fullName is required' });
    }

    try {
      const client = await createClient(tenantId, { fullName, email, phone, notes });
      return reply.code(201).send({ success: true, clientId: client.id });
    } catch (err) {
      if (err.code === 'P2002') {
        return reply.code(409).send({ error: 'A client with this email already exists' });
      }
      throw err;
    }
  });

  // ── Update client ──────────────────────────────────────────────────────────
  fastify.patch('/api/tenants/:tenantId/clients/:clientId', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId, clientId } = request.params;
    await updateClient(tenantId, clientId, request.body ?? {});
    return { success: true };
  });
}
