// ─────────────────────────────────────────────────────────────────────────────
// routes/calendar-routes.js
// Calendar / appointment view endpoints.
//
// GET /api/tenants/:tenantId/calendar/week?start=YYYY-MM-DD
// GET /api/tenants/:tenantId/calendar/day?date=YYYY-MM-DD
// GET /api/tenants/:tenantId/calendar/upcoming?start=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────

import { getWeekAppointments, getDayAppointments, getUpcomingWeek } from '../services/calendar-service.js';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** Returns the Monday of the week containing the given ISO date */
function weekMonday(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d.getTime() + diff * 86400000);
  return mon.toISOString().slice(0, 10);
}

export default async function calendarRoutes(fastify) {
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

  // ── Week view ──────────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/calendar/week', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const rawStart = request.query.start ?? todayISO();
    const start = weekMonday(rawStart);

    const appointments = await getWeekAppointments(tenantId, start);
    return { weekStart: start, appointments };
  });

  // ── Day view ───────────────────────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/calendar/day', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const date = request.query.date ?? todayISO();

    const appointments = await getDayAppointments(tenantId, date);
    return { date, appointments };
  });

  // ── Upcoming this week (table) ─────────────────────────────────────────────
  fastify.get('/api/tenants/:tenantId/calendar/upcoming', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { tenantId } = request.params;
    const rawStart = request.query.start ?? todayISO();
    const start = weekMonday(rawStart);

    const appointments = await getUpcomingWeek(tenantId, start);
    return { weekStart: start, appointments };
  });
}
