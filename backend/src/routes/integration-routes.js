// ─────────────────────────────────────────────────────────────────────────────
// routes/integration-routes.js
//
// GET    /api/tenants/:tenantId/integrations                        — list integrations
// GET    /api/tenants/:tenantId/integrations/google-calendar/connect — OAuth URL
// GET    /api/tenants/:tenantId/integrations/google-calendar/callback — OAuth callback
// DELETE /api/tenants/:tenantId/integrations/:key                   — disconnect
// ─────────────────────────────────────────────────────────────────────────────

import {
  listIntegrations,
  getGoogleCalendarAuthUrl,
  handleGoogleCalendarCallback,
  disconnectIntegration,
} from '../services/integration-service.js';

export default async function integrationRoutes(fastify) {
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

  // ── List integrations ──────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/integrations', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const integrations = await listIntegrations(request.params.tenantId);
    return { integrations };
  });

  // ── Google Calendar: get OAuth URL ─────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/integrations/google-calendar/connect', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    try {
      const url = getGoogleCalendarAuthUrl(tenantId);
      return { url };
    } catch (err) {
      return reply.code(503).send({ error: err.message });
    }
  });

  // ── Google Calendar: OAuth callback (no auth — called by Google) ───────────
  // State param contains tenantId for verification
  fastify.get('/api/tenants/:tenantId/integrations/google-calendar/callback', async (request, reply) => {
    const { tenantId } = request.params;
    const { code, error, state } = request.query;

    if (error || !code) {
      return reply.redirect(`/app/settings.html?googleError=1`);
    }
    if (state !== tenantId) {
      return reply.code(400).send({ error: 'State mismatch' });
    }

    try {
      await handleGoogleCalendarCallback(tenantId, code);
      return reply.redirect(`/app/settings.html?googleConnected=1`);
    } catch (err) {
      fastify.log.error(err, 'Google Calendar OAuth callback failed');
      return reply.redirect(`/app/settings.html?googleError=1`);
    }
  });

  // ── Disconnect integration ─────────────────────────────────────────────────
  fastify.delete('/api/tenants/:tenantId/integrations/:integrationKey', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId, integrationKey } = request.params;
    // Only allow disconnecting OAuth integrations, not env-var ones
    const oauthKeys = ['google_calendar'];
    if (!oauthKeys.includes(integrationKey)) {
      return reply.code(400).send({ error: 'Cannot disconnect this integration from here' });
    }
    try {
      await disconnectIntegration(tenantId, integrationKey);
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
