// ─────────────────────────────────────────────────────────────────────────────
// routes/staff-routes.js
//
// Staff endpoints:
//   GET    /api/tenants/:tenantId/staff              — all active staff
//   GET    /api/tenants/:tenantId/staff/on-duty      — staff + today's appt counts
//   POST   /api/tenants/:tenantId/staff              — create staff member
//   PUT    /api/tenants/:tenantId/staff/:staffId     — update staff member
//   DELETE /api/tenants/:tenantId/staff/:staffId     — soft-delete staff member
// ─────────────────────────────────────────────────────────────────────────────

import { getStaffOnDuty, getAllStaff, createStaff, updateStaff, deleteStaff } from '../services/staff-service.js';

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

  // Create new staff member
  fastify.post(
    '/api/tenants/:tenantId/staff',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const staff = await createStaff(request.params.tenantId, request.body ?? {});
        return reply.code(201).send({ success: true, staff });
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );

  // Update staff member
  fastify.put(
    '/api/tenants/:tenantId/staff/:staffId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const staff = await updateStaff(request.params.tenantId, request.params.staffId, request.body ?? {});
        return { success: true, staff };
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );

  // Soft-delete staff member
  fastify.delete(
    '/api/tenants/:tenantId/staff/:staffId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        return await deleteStaff(request.params.tenantId, request.params.staffId);
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }
    },
  );
}
