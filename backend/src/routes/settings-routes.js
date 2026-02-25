// ─────────────────────────────────────────────────────────────────────────────
// routes/settings-routes.js
//
// GET /api/tenants/:tenantId/settings/clinic          — get clinic info
// PUT /api/tenants/:tenantId/settings/clinic          — update clinic info
// GET /api/tenants/:tenantId/settings/notifications   — get notif prefs
// PUT /api/tenants/:tenantId/settings/notifications   — update notif prefs
// ─────────────────────────────────────────────────────────────────────────────

import {
  getClinicSettings,
  updateClinicSettings,
  updateNotificationSettings,
} from '../services/settings-service.js';

export default async function settingsRoutes(fastify) {
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

  // ── GET clinic settings ────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/settings/clinic', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const settings = await getClinicSettings(request.params.tenantId);
    if (!settings) return reply.code(404).send({ error: 'Not found' });
    return settings;
  });

  // ── PUT clinic settings ────────────────────────────────────────────────────
  fastify.put('/api/tenants/:tenantId/settings/clinic', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    try {
      await updateClinicSettings(request.params.tenantId, request.body ?? {});
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── GET notification settings ──────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/settings/notifications', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const settings = await getClinicSettings(request.params.tenantId);
    if (!settings) return reply.code(404).send({ error: 'Not found' });
    return settings.notifications;
  });

  // ── PUT notification settings ──────────────────────────────────────────────
  fastify.put('/api/tenants/:tenantId/settings/notifications', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    try {
      await updateNotificationSettings(request.params.tenantId, request.body ?? {});
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
