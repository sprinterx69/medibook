// ─────────────────────────────────────────────────────────────────────────────
// routes/staff-routes.js
//
// Staff endpoints:
//   GET /api/tenants/:tenantId/staff              — all active staff
//   GET /api/tenants/:tenantId/staff/on-duty      — staff + today's appt counts
// ─────────────────────────────────────────────────────────────────────────────

import { getStaffOnDuty, getAllStaff } from '../services/staff-service.js';

export default async function staffRoutes(fastify) {

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

  // All active staff (for dropdowns and the staff management page)
  fastify.get(
    '/api/tenants/:tenantId/staff',
    { preHandler: [requireAuth] },
    async (request) => {
      const staff = await getAllStaff(request.params.tenantId);
      return { staff };
    },
  );

  // Staff on duty today — includes appointment counts and busy status
  fastify.get(
    '/api/tenants/:tenantId/staff/on-duty',
    { preHandler: [requireAuth] },
    async (request) => {
      const staff = await getStaffOnDuty(request.params.tenantId);
      return {
        staff,
        onlineCount: staff.filter(s => s.isAvailable).length,
      };
    },
  );
}
