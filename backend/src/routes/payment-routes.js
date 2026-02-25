// ─────────────────────────────────────────────────────────────────────────────
// routes/payment-routes.js
//
// GET  /api/tenants/:tenantId/payments               — list payments
// GET  /api/tenants/:tenantId/payments/stats         — stat cards
// GET  /api/tenants/:tenantId/payments/weekly        — weekly revenue chart
// GET  /api/tenants/:tenantId/payments/by-service    — service breakdown
// PATCH /api/tenants/:tenantId/payments/:id/mark-paid — mark paid
// ─────────────────────────────────────────────────────────────────────────────

import {
  listPayments,
  getPaymentStats,
  getWeeklyRevenue,
  getRevenueByService,
  markPaymentPaid,
} from '../services/payment-service.js';

export default async function paymentRoutes(fastify) {
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

  // ── List payments ──────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/payments', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const { filter = 'all', search = '', limit } = request.query;

    const payments = await listPayments(tenantId, {
      filter,
      search,
      limit: limit ? parseInt(limit) : 100,
    });
    return { payments, count: payments.length };
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/payments/stats', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const stats = await getPaymentStats(tenantId);
    return stats;
  });

  // ── Weekly revenue chart ───────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/payments/weekly', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const weeks = parseInt(request.query.weeks ?? '8');
    const data = await getWeeklyRevenue(tenantId, weeks);
    return { weeks: data };
  });

  // ── Revenue by service ─────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/payments/by-service', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const breakdown = await getRevenueByService(tenantId);
    return { breakdown };
  });

  // ── Mark paid ──────────────────────────────────────────────────────────────
  fastify.patch('/api/tenants/:tenantId/payments/:paymentId/mark-paid', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId, paymentId } = request.params;
    try {
      await markPaymentPaid(tenantId, paymentId);
      return { success: true };
    } catch (err) {
      return reply.code(404).send({ error: err.message });
    }
  });
}
