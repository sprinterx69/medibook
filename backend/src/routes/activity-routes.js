// ─────────────────────────────────────────────────────────────────────────────
// routes/activity-routes.js
//
//   GET /api/tenants/:tenantId/activity?limit=20  — recent activity feed
// ─────────────────────────────────────────────────────────────────────────────

import { getRecentActivity } from '../services/activity-service.js';

export default async function activityRoutes(fastify) {

  async function requireAuth(request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (request.user.tenantId !== request.params.tenantId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  }

  fastify.get(
    '/api/tenants/:tenantId/activity',
    { preHandler: [requireAuth] },
    async (request) => {
      const limit  = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
      const activity = await getRecentActivity(request.params.tenantId, limit);
      return { activity };
    },
  );
}
