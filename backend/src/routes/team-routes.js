// ─────────────────────────────────────────────────────────────────────────────
// routes/team-routes.js
//
// GET    /api/tenants/:tenantId/team             — list team members
// POST   /api/tenants/:tenantId/team/invite      — invite new member
// PUT    /api/tenants/:tenantId/team/:userId      — update member role
// DELETE /api/tenants/:tenantId/team/:userId      — remove member
// ─────────────────────────────────────────────────────────────────────────────

import {
  listTeamMembers,
  inviteTeamMember,
  updateTeamMemberRole,
  removeTeamMember,
} from '../services/team-service.js';

export default async function teamRoutes(fastify) {
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

  // Only OWNER or ADMIN can manage team
  const requireAdmin = async (request, reply) => {
    try {
      await request.jwtVerify();
      if (request.user.tenantId !== request.params.tenantId) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      if (!['OWNER', 'ADMIN'].includes(request.user.role)) {
        return reply.code(403).send({ error: 'Admin access required' });
      }
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  // ── List team members ──────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/team', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const members = await listTeamMembers(request.params.tenantId);
    return { members };
  });

  // ── Invite member ──────────────────────────────────────────────────────────
  fastify.post('/api/tenants/:tenantId/team/invite', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const { fullName, email, role, title } = request.body ?? {};

    if (!fullName || !email) {
      return reply.code(400).send({ error: 'fullName and email are required' });
    }

    try {
      const result = await inviteTeamMember(tenantId, { fullName, email, role, title });
      return reply.code(201).send({ success: true, ...result });
    } catch (err) {
      return reply.code(409).send({ error: err.message });
    }
  });

  // ── Update member role ─────────────────────────────────────────────────────
  fastify.put('/api/tenants/:tenantId/team/:userId', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const { tenantId, userId } = request.params;
    const { role } = request.body ?? {};

    if (!role) return reply.code(400).send({ error: 'role is required' });

    try {
      await updateTeamMemberRole(tenantId, userId, { role });
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── Remove member ──────────────────────────────────────────────────────────
  fastify.delete('/api/tenants/:tenantId/team/:userId', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const { tenantId, userId } = request.params;
    try {
      await removeTeamMember(tenantId, userId);
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
